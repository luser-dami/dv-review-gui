/**
 * Workspace-diff model layer: parse `dv diff` output into a structured model,
 * keep the model in sync with the disk after line-level reverts, and perform
 * the on-disk revert itself.
 *
 * Line-number contract (the model must always mirror the working file):
 * - `n`  — 1-based line number in the BASE file ("-" and context lines only)
 * - `nn` — 1-based line number in the WORKING file: the line itself for
 *          "+" / context lines; for "-" lines the position where the line
 *          would be re-inserted (the working-file line it precedes).
 * `nn` is the revert coordinate for both kinds.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface DiffLine {
  t: "+" | "-" | " ";
  text: string;
  /** 1-based base-file line number ("-" and context lines) */
  n?: number;
  /** 1-based working-file line number / insertion position (all lines) */
  nn?: number;
}
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  header: string;
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  binary: boolean;
  hunks: DiffHunk[];
}

/** Thrown when the cached model no longer matches the revert request. */
export class StaleModelError extends Error {
  override name = "StaleModelError";
}

/** Thrown when the working file on disk no longer matches the diff model. */
export class DivergedError extends Error {
  override name = "DivergedError";
}

export function parseWorkspaceDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  // Remaining lines declared by the current hunk header; at zero the hunk is
  // closed so a trailing newline can't leak in as a phantom context line.
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      cur = { path: line.match(/^diff --git a\/(.*) b\/(.*)$/)?.[2] ?? "", binary: false, hunks: [] };
      files.push(cur);
      hunk = undefined;
      continue;
    }
    if (!cur) continue;
    if (line.includes("Binary files")) {
      cur.binary = true;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) {
        hunk = undefined;
        continue;
      }
      hunk = { oldStart: Number(m[1]), newStart: Number(m[3]), header: line, lines: [] };
      cur.hunks.push(hunk);
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      oldLeft = Number(m[2] ?? "1");
      newLeft = Number(m[4] ?? "1");
      continue;
    }
    if (
      line.startsWith("+++ ") ||
      line.startsWith("--- ") ||
      line.startsWith("index ") ||
      line.startsWith("\\") ||
      /^(new|deleted) file mode|^similarity index|^rename (from|to)/.test(line)
    ) {
      continue;
    }
    if (!hunk || (oldLeft === 0 && newLeft === 0)) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ t: "+", text: line.slice(1), nn: newNo });
      newNo++;
      newLeft--;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ t: "-", text: line.slice(1), n: oldNo, nn: newNo });
      oldNo++;
      oldLeft--;
    } else {
      // context line ("content" or empty); dv emits empty strings for blank lines
      hunk.lines.push({ t: " ", text: line.startsWith(" ") ? line.slice(1) : "", n: oldNo, nn: newNo });
      newNo++;
      oldNo++;
      oldLeft--;
      newLeft--;
    }
  }
  return files;
}

/** +/- line counts of a file's hunks (for stat chips). */
export function diffStats(file: DiffFile): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.t === "+") add++;
      else if (l.t === "-") del++;
    }
  }
  return { add, del };
}

/** Regenerate a hunk header from its lines after mutation. */
function reheader(h: DiffHunk): void {
  const first = h.lines[0];
  if (!first) return;
  const oldCount = h.lines.filter((l) => l.t !== "+").length;
  const newCount = h.lines.filter((l) => l.t !== "-").length;
  const oldStart = first.n ?? Math.max(1, (first.nn ?? 1) - 1);
  const newStart = first.nn ?? h.newStart;
  h.oldStart = oldStart;
  h.newStart = newStart;
  const suffix = h.header.match(/^@@ [^@]+ @@(.*)$/)?.[1] ?? "";
  h.header =
    `@@ -${oldStart}${oldCount === 1 ? "" : `,${oldCount}`}` +
    ` +${newStart}${newCount === 1 ? "" : `,${newCount}`} @@${suffix}`;
}

/**
 * Mirror a successful on-disk line revert into the cached diff model.
 * Returns the updated file, or null when the file has no remaining changes
 * (it is then removed from `files`). Throws StaleModelError when the model
 * does not contain the reverted line — the caller must reload from `dv`.
 */
export function applyRevertToModel(
  files: DiffFile[],
  relPath: string,
  kind: string,
  line: number,
  text: string,
): DiffFile | null {
  const fi = files.findIndex((f) => f.path === relPath);
  if (fi < 0) throw new StaleModelError("模型中没有该文件 — 请重新加载 diff");
  const file = files[fi];

  let target: DiffLine | undefined;
  let targetHunk: DiffHunk | undefined;
  for (const h of file.hunks) {
    target = h.lines.find(
      (l) => l.nn === line && l.text === text && (kind === "add" ? l.t === "+" : l.t === "-"),
    );
    if (target) {
      targetHunk = h;
      break;
    }
  }
  if (!target || !targetHunk) {
    throw new StaleModelError("模型与工作区不一致（目标行不在模型中）— 请重新加载 diff");
  }

  targetHunk.lines.splice(targetHunk.lines.indexOf(target), 1);
  // Mirror the disk line-number shift: deleting working line N decrements
  // every position after it; re-inserting at N increments positions from N.
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.nn === undefined) continue;
      if (kind === "add" && l.nn > line) l.nn--;
      else if (kind === "del" && l.nn >= line) l.nn++;
    }
  }
  // Hunks reduced to pure context are no longer differences.
  file.hunks = file.hunks.filter((h) => h.lines.some((l) => l.t !== " "));
  if (!file.hunks.length) {
    files.splice(fi, 1);
    return null;
  }
  for (const h of file.hunks) reheader(h);
  return file;
}
export function resolveWorkspacePath(root: string, rel: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("path is outside the workspace");
  }
  return resolved;
}


/**
 * Revert one changed line of the working file (the GUI's line-level undo).
 * kind "add": the working file gained this line at 1-based `line` — delete it.
 * kind "del": the working file lost the base line — re-insert it at `line`.
 * Line endings are preserved (CRLF files keep CRLF).
 */
export function revertLineInFile(root: string, rel: string, kind: string, line: number, text: string): void {
  const abs = resolveWorkspacePath(root, rel);
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) throw new Error("二进制文件不支持行级回退");
  const raw = buf.toString("utf8");
  const lines = raw.split("\n"); // entries keep their "\r" on CRLF files
  if (kind === "add") {
    const idx = line - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= lines.length) {
      throw new DivergedError("行号超出文件范围 — 文件已在磁盘上变化，正在重新加载 diff");
    }
    if (lines[idx].replace(/\r$/, "") !== text.replace(/\r$/, "")) {
      throw new DivergedError("文件内容已变化，与 diff 不一致 — 正在重新加载");
    }
    lines.splice(idx, 1);
    writeFileSync(abs, lines.length === 1 && lines[0] === "" ? "" : lines.join("\n"));
    return;
  }
  if (kind === "del") {
    const idx = line - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx > lines.length) {
      throw new DivergedError("文件行数已变化，与 diff 不一致 — 正在重新加载");
    }
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    lines.splice(idx, 0, text + (eol === "\r\n" ? "\r" : ""));
    writeFileSync(abs, lines.join("\n"));
    return;
  }
  throw new Error(`unknown revert kind: ${kind}`);
}

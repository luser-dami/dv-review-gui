/**
 * dv-review-gui — a standalone local web GUI for the Diversion (dv) version
 * control system, built for human review workflows.
 *
 * Serves a single-page UI on 127.0.0.1 showing workspace status, pending
 * changes, and open reviews, and drives the review loop: diff → comment →
 * approve / request-changes / reject → merge / close.
 *
 * Zero runtime dependencies: VCS data comes from the `dv` CLI (must be on
 * PATH, or point DV_BIN at the binary); reviews come from the Diversion REST
 * API (DV_API_TOKEN). The token never leaves this process; the server binds
 * to loopback only.
 *
 * Usage:
 *   dv-review-gui [workspace-dir]
 *   DV_WORKSPACE_DIR=/path/to/repo dv-review-gui
 *   DV_API_TOKEN=dvk_... DV_UI_PORT=7391 dv-review-gui
 */
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDv } from "./dv.js";
import { dvApi, type Review, type ReviewComment } from "./api.js";
import {
  applyRevertToModel,
  parseWorkspaceDiff,
  revertLineInFile,
  StaleModelError,
  type DiffFile,
} from "./model.js";

const VERSION = "0.2.0";
const PORT = Number(process.env.DV_UI_PORT ?? 7391);
const DIR = process.argv[2] ?? process.env.DV_WORKSPACE_DIR ?? process.cwd();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let repoIdCache: string | undefined;

async function repoId(): Promise<string> {
  if (repoIdCache) return repoIdCache;
  const r = await runDv(["status", "--nowait"], { dir: DIR, timeoutMs: 30_000 });
  const m = `${r.stdout}\n${r.stderr}`.match(/dv\.repo\.[0-9a-f][0-9a-f-]*/i);
  if (!m) throw new Error(`Not a Diversion workspace: ${DIR}`);
  repoIdCache = m[0];
  return repoIdCache;
}

// ---------- parsers: turn dv's human output into structured JSON ----------

export interface ChangeEntry {
  status: string;
  path: string;
}
export interface LogEntry {
  id: string;
  subject: string;
}
export interface BranchEntry {
  name: string;
  id: string;
  commit?: string;
}

export function parseNameStatus(text: string): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^([AMDR])\s+(.+)$/);
    if (m) out.push({ status: m[1], path: m[2] });
  }
  return out;
}

export function parseLog(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(dv\.commit\.\d+)\s+(.*)$/);
    if (m) out.push({ id: m[1], subject: m[2] });
  }
  return out;
}

export function parseBranches(text: string): BranchEntry[] {
  const out: BranchEntry[] = [];
  let cur: BranchEntry | undefined;
  for (const line of text.split("\n")) {
    const b = line.match(/^branch (.+?) \((dv\.branch\.[0-9a-f-]+)\)/);
    if (b) {
      cur = { name: b[1], id: b[2] };
      out.push(cur);
      continue;
    }
    const c = line.match(/^commit (dv\.commit\.\d+)/);
    if (c && cur) cur.commit = c[1];
  }
  return out;
}

export function parseStatus(text: string) {
  const grab = (re: RegExp) => text.match(re)?.[1];
  return {
    repo: grab(/^In repo (\S+)/m),
    repoId: grab(/dv\.repo\.[0-9a-f][0-9a-f-]*/i),
    branch: grab(/^On branch (\S+)/m),
    branchId: grab(/dv\.branch\.[0-9a-f][0-9a-f-]*/i),
    commit: grab(/Cloud workspace is over commit (dv\.commit\.\d+)/),
    workspace: grab(/Working in workspace (.+?) \(dv\.ws\./),
    synced: grab(/Local workspace is synced to commit: (dv\.commit\.\d+)/),
    clean: /has no changes/.test(text),
    raw: text.trim(),
  };
}

// ---------- HTTP ----------

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  let data = "";
  req.on("data", (chunk: Buffer) => {
    data += chunk;
    if (data.length > 1_000_000) reject(new Error("request body too large"));
  });
  req.on("end", () => {
    try {
      resolve(data ? JSON.parse(data) : {});
    } catch (e) {
      reject(new Error(`invalid JSON body: ${e instanceof Error ? e.message : e}`));
    }
  });
  req.on("error", reject);
  return promise;
}

// ---------- workspace-diff cache (server-side model) ----------
//
// One model per server, mirrored by the client: loaded once on view entry
// (?refresh=1), kept in sync by /api/revert-line without re-running `dv diff`
// (dv's sync lag is 2-7s, so post-revert snapshots cannot be trusted).

const WS_DIFF_TTL_MS = 30_000;
let wsDiffCache: { at: number; files: DiffFile[] } | null = null;
let wsDiffLoading: Promise<DiffFile[]> | null = null;

async function loadWorkspaceDiff(): Promise<DiffFile[]> {
  if (!wsDiffLoading) {
    wsDiffLoading = (async () => {
      const r = await runDv(["diff", "--color", "never"], { dir: DIR, timeoutMs: 120_000 });
      const files = parseWorkspaceDiff(`${r.stdout}\n${r.stderr}`);
      wsDiffCache = { at: Date.now(), files };
      return files;
    })().finally(() => {
      wsDiffLoading = null;
    });
  }
  return wsDiffLoading;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      // Stamp the running server's version into the page: an outdated process
      // still serves the newest index.html from disk, so the client must be
      // able to detect that its API peer is stale.
      const html = readFileSync(path.join(ROOT, "ui", "index.html"), "utf8").replace(
        "%DV_GUI_VERSION%",
        VERSION,
      );
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
      // Flat static assets only (basename lookup — no path traversal).
      const file = path.basename(url.pathname);
      const p = path.join(ROOT, "ui", "vendor", file);
      if (existsSync(p)) {
        const types: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
        res.writeHead(200, {
          "Content-Type": types[path.extname(p)] ?? "application/octet-stream",
          "Cache-Control": "public, max-age=86400",
        });
        res.end(readFileSync(p));
      } else {
        sendJson(res, 404, { error: "not found" });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const [status, changes, log, branches] = await Promise.all([
        runDv(["status", "--no-limit", "--nowait"], { dir: DIR }),
        runDv(["diff", "--name-status", "--color", "never"], { dir: DIR }),
        runDv(["log", "-n", "15", "--oneline", "--date", "iso"], { dir: DIR }),
        runDv(["branch"], { dir: DIR, timeoutMs: 30_000 }),
      ]);
      sendJson(res, 200, {
        version: VERSION,
        dir: DIR,
        info: parseStatus(`${status.stdout}\n${status.stderr}`),
        changes: parseNameStatus(`${changes.stdout}\n${changes.stderr}`),
        log: parseLog(log.stdout),
        branches: parseBranches(branches.stdout),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/reviews") {
      const data = await dvApi<{ items?: Review[] }>(`/repos/${await repoId()}/reviews?status=open`);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/review") {
      const id = url.searchParams.get("id") ?? "";
      const repo = await repoId();
      const review = await dvApi<Review>(`/repos/${repo}/reviews/${encodeURIComponent(id)}`);
      const files = await runDv(
        ["diff", "--name-status", "--color", "never", "--base", review.base_ref, "--compare", review.compare_ref],
        { dir: DIR },
      );
      let comments: ReviewComment[] = [];
      try {
        comments =
          (await dvApi<{ items?: ReviewComment[] }>(`/repos/${repo}/reviews/${encodeURIComponent(id)}/comments`))
            .items ?? [];
      } catch {
        // comments are optional context
      }
      sendJson(res, 200, { review, files: parseNameStatus(files.stdout), comments });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/diff") {
      const args = ["diff", "--color", "never"];
      const base = url.searchParams.get("base");
      const compare = url.searchParams.get("compare");
      const p = url.searchParams.get("path");
      if (base) args.push("--base", base);
      if (compare) args.push("--compare", compare);
      if (p) args.push(p);
      const r = await runDv(args, { dir: DIR, timeoutMs: 120_000 });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(r.stdout || r.stderr || "(no differences)");
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace-diff") {
      const p = url.searchParams.get("path");
      if (p) {
        // Single-file lookup: always fresh from dv, bypasses the model cache.
        const r = await runDv(["diff", "--color", "never", p], { dir: DIR, timeoutMs: 120_000 });
        sendJson(res, 200, { files: parseWorkspaceDiff(`${r.stdout}\n${r.stderr}`) });
        return;
      }
      const refresh = url.searchParams.get("refresh") === "1";
      if (refresh || !wsDiffCache || Date.now() - wsDiffCache.at > WS_DIFF_TTL_MS) {
        await loadWorkspaceDiff();
      }
      sendJson(res, 200, { at: wsDiffCache!.at, files: wsDiffCache!.files });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/revert-line") {
      const body = await readBody(req);
      const p = String(body.path ?? "");
      const kind = String(body.kind ?? "");
      const line = Number(body.line);
      const text = String(body.text ?? "");
      revertLineInFile(DIR, p, kind, line, text); // disk first; strict validation
      if (!wsDiffCache) {
        // No model to mirror into (server restarted after the client loaded).
        // The client must wait out dv's sync lag, then force-reload.
        sendJson(res, 200, { ok: true, file: null, stale: true });
        return;
      }
      try {
        const file = applyRevertToModel(wsDiffCache.files, p, kind, line, text);
        // The mirrored model is now fresher than any dv snapshot — restart TTL.
        wsDiffCache.at = Date.now();
        sendJson(res, 200, { ok: true, file });
      } catch (e) {
        if (e instanceof StaleModelError) {
          wsDiffCache = null; // force reload from dv on next fetch
          sendJson(res, 409, { error: e.message, stale: true });
          return;
        }
        throw e;
      }
      return;
    }


    if (req.method === "POST" && url.pathname === "/api/new-review") {
      const body = await readBody(req);
      const args = ["review", String(body.title ?? "")];
      if (body.into) args.push("--into", String(body.into));
      if (body.description) args.push("-d", String(body.description));
      const r = await runDv(args, { dir: DIR, timeoutMs: 60_000 });
      sendJson(res, r.ok ? 200 : 500, { ok: r.ok, output: `${r.stdout}\n${r.stderr}`.trim() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/action") {
      const body = await readBody(req);
      const id = encodeURIComponent(String(body.id ?? ""));
      const repo = await repoId();
      switch (body.action) {
        case "merge": {
          const review = await dvApi<Review>(`/repos/${repo}/reviews/${id}`);
          const r = await runDv(["merge", review.compare_ref, "--into", review.base_ref], {
            dir: DIR,
            timeoutMs: 300_000,
          });
          if (r.ok) wsDiffCache = null; // merge rewrote the workspace
          sendJson(res, r.ok ? 200 : 500, { ok: r.ok, output: `${r.stdout}\n${r.stderr}`.trim() });
          return;
        }
        case "comment": {
          const payload: Record<string, unknown> = { content: String(body.content ?? "") };
          if (body.file_path) payload.file_path = body.file_path;
          if (body.start_line !== undefined && body.start_line !== null) payload.start_line = body.start_line;
          const comment = await dvApi<ReviewComment>(`/repos/${repo}/reviews/${id}/comments`, {
            method: "POST",
            body: payload,
          });
          sendJson(res, 200, { ok: true, comment });
          return;
        }
        case "close": {
          const review = await dvApi<Review>(`/repos/${repo}/reviews/${id}`, {
            method: "PATCH",
            body: { status: "closed" },
          });
          sendJson(res, 200, { ok: true, review });
          return;
        }
        case "approved":
        case "changes_requested":
        case "rejected": {
          const review = await dvApi<Review>(`/repos/${repo}/reviews/${id}/reviewers/status`, {
            method: "PATCH",
            body: { status: body.action },
          });
          sendJson(res, 200, { ok: true, review });
          return;
        }
        default:
          sendJson(res, 400, { error: `unknown action: ${String(body.action)}` });
      }
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

function openBrowser(url: string): void {
  if (process.env.DV_UI_NO_OPEN) return;
  let opener: ChildProcess;
  if (process.platform === "win32") {
    // Windows: open in Edge explicitly, fall back to the default browser.
    const edge = [
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    ].find((p) => existsSync(p));
    opener = edge
      ? spawn(edge, ["--new-window", url], { stdio: "ignore", detached: true })
      : spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
  } else {
    opener = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
      stdio: "ignore",
      detached: true,
    });
  }
  opener.unref();
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    // Another dv-review-gui instance is already serving this port — the GUI
    // is up, so just (re)open the browser instead of failing the task.
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`dv-review-gui already running at ${url} — opening browser`);
    openBrowser(url);
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`dv-review-gui v${VERSION} → ${url}  (workspace: ${DIR})`);
  openBrowser(url);
});

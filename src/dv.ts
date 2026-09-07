import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";

export interface DvResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

const MAX_COLLECT = 5 * 1024 * 1024; // stop buffering after 5 MB per stream
const DEFAULT_TIMEOUT_MS = 120_000;

export function dvBin(): string {
  const override = process.env.DV_BIN;
  if (override) return override;
  return process.platform === "win32" ? "dv.exe" : "dv";
}

/**
 * Resolve the directory a dv command should run in.
 * Priority: explicit per-call dir > DV_WORKSPACE_DIR env (Zed can set this)
 * > server process cwd (Zed sets this to the project root).
 */
export function baseDir(explicit?: string): string {
  const root = process.env.DV_WORKSPACE_DIR || process.cwd();
  if (!explicit) return root;
  const expanded = explicit.startsWith("~") ? path.join(os.homedir(), explicit.slice(1)) : explicit;
  return path.resolve(root, expanded);
}

function collectWithCap(proc: ChildProcess, fd: "stdout" | "stderr"): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const stream = proc[fd];
  if (!stream) {
    resolve("");
    return promise;
  }
  let out = "";
  let capped = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    if (capped) return;
    out += chunk;
    if (out.length > MAX_COLLECT) {
      out += "\n... [output truncated]";
      capped = true;
      stream.destroy();
      resolve(out);
    }
  });
  stream.on("error", () => resolve(out));
  stream.on("end", () => resolve(out));
  return promise;
}

/**
 * Run `dv` with the given arguments. Never uses a shell, so every argument is
 * passed verbatim and paths with spaces are safe.
 */
export function runDv(
  args: string[],
  opts: { dir?: string; timeoutMs?: number } = {},
): Promise<DvResult> {
  const { promise: done, resolve } = Promise.withResolvers<DvResult>();
  const cwd = baseDir(opts.dir);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // stdin ignored: if dv ever prompts interactively it sees EOF and fails
  // fast instead of hanging the MCP session. The timeout is the backstop.
  const proc = spawn(dvBin(), args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const timer = setTimeout(() => {
    proc.kill("SIGKILL");
    resolve({
      ok: false,
      code: null,
      stdout: "",
      stderr: `dv ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s (cwd: ${cwd}). The command may be waiting for a file sync or an interactive prompt.`,
    });
  }, timeoutMs);

  const stdoutP = collectWithCap(proc, "stdout");
  const stderrP = collectWithCap(proc, "stderr");

  proc.on("error", (err) => {
    resolve({
      ok: false,
      code: null,
      stdout: "",
      stderr: `Failed to launch '${dvBin()}': ${err.message}. Is the Diversion CLI installed and on PATH? (You can point DV_BIN at the binary.)`,
    });
  });

  proc.on("close", async (code) => {
    const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
    resolve({ ok: code === 0, code, stdout, stderr });
    clearTimeout(timer);
  });

  return done;
}

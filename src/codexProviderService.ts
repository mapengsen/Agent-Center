import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildProviderConfig, type NewApiProvider } from "./codexProviderConfig";

export interface PythonCommand { executable: string; args: string[] }
export interface ProviderSwitchResult {
  ok: true;
  provider: string;
  threadCount: number;
  changedCount: number;
  databaseCount: number;
  backupDirectory: string;
}

export function resolveCodexHome(environment: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const configured = environment.CODEX_HOME?.trim();
  return configured ? path.resolve(configured.startsWith("~/") ? path.join(home, configured.slice(2)) : configured) : path.join(home, ".codex");
}

export async function readCodexConfig(home: string): Promise<string> {
  try { return await fs.readFile(path.join(home, "config.toml"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw new Error("无法读取当前环境的 Codex config.toml。"); }
}

async function pythonWorks(command: PythonCommand): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command.executable, [...command.args, "-c", "import sys,sqlite3;sys.exit(0 if sys.version_info >= (3,8) else 1)"], { windowsHide: true, shell: false, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

export async function findPython(explicit = ""): Promise<PythonCommand> {
  const candidates: PythonCommand[] = explicit.trim()
    ? [{ executable: explicit.trim(), args: [] }]
    : [{ executable: "python3", args: [] }, { executable: "python", args: [] }, ...(process.platform === "win32" ? [{ executable: "py", args: ["-3"] }] : [])];
  for (const candidate of candidates) if (await pythonWorks(candidate)) return candidate;
  throw new Error("服务商切换需要当前扩展宿主安装 Python 3.8+（含 sqlite3）。请安装 Python，或设置 agentStatus.codexProvider.pythonPath。");
}

export async function runProviderHelper(
  python: PythonCommand,
  scriptPath: string,
  request: Record<string, unknown>,
  onProgress?: (message: string) => void,
): Promise<ProviderSwitchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(python.executable, [...python.args, scriptPath], {
      windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
    });
    let output = "", pending = "", failure = "", finished = false;
    let result: ProviderSwitchResult | undefined;
    const timer = setTimeout(() => { child.kill(); }, 180000);
    child.stdout.on("data", (buffer: Buffer) => {
      output += buffer.toString("utf8"); pending += buffer.toString("utf8");
      if (output.length > 256 * 1024) { child.kill(); failure = "历史处理返回了异常大小的结果。"; return; }
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const entry = JSON.parse(line) as ProviderSwitchResult & { progress?: string; error?: string; backupDirectory?: string };
          if (entry.progress) onProgress?.(entry.progress);
          else if (entry.ok) result = entry;
          else if (entry.error) failure = entry.error + (entry.backupDirectory ? ` 备份位置：${entry.backupDirectory}` : "");
        } catch { /* Never surface raw helper output: it could contain configuration data. */ }
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => { /* Report process failure without echoing stdin. */ });
    child.on("error", () => { clearTimeout(timer); if (!finished) { finished = true; reject(new Error("无法启动 Codex 历史处理程序。")); } });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      if (code === 0 && result) resolve(result);
      else reject(new Error(failure || "服务商切换未完成。请查看 Codex 数据目录中的 agent-center/provider-backups，并重试。"));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function switchCodexProvider(options: {
  home: string; provider: string; scriptPath: string; pythonPath?: string;
  newProvider?: NewApiProvider; onProgress?: (message: string) => void;
}): Promise<ProviderSwitchResult> {
  const current = await readCodexConfig(options.home);
  const next = buildProviderConfig(current, options.provider, options.newProvider);
  const python = await findPython(options.pythonPath);
  return runProviderHelper(python, options.scriptPath, {
    home: options.home, provider: options.provider,
    expectedConfig: Buffer.from(current).toString("base64"),
    nextConfig: Buffer.from(next).toString("base64"),
  }, options.onProgress);
}

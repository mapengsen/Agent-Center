import { spawn } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";

export interface NvidiaSmiResult { ok: boolean; output: string; detail: string }
const MAX_BYTES = 1024 * 1024;

/** Run a single read-only sample without a shell or a persistent `watch` process. */
export async function readNvidiaSmi(executable = "", signal?: AbortSignal): Promise<NvidiaSmiResult> {
  const configured = executable.trim();
  const candidates = configured ? [configured.replace(/^~(?=[/\\]|$)/, os.homedir())] : ["nvidia-smi"];
  if (!configured && process.platform === "win32") {
    if (process.env.SystemRoot) candidates.push(path.join(process.env.SystemRoot, "System32", "nvidia-smi.exe"));
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"));
  }
  for (const candidate of [...new Set(candidates)]) {
    const result = await sample(candidate, signal);
    if (!result.missing) return result;
  }
  return { ok: false, output: "", detail: "未找到 nvidia-smi。请确认当前机器已安装 NVIDIA 驱动，或设置 nvidiaSmiPath。" };
}

async function sample(executable: string, signal?: AbortSignal): Promise<NvidiaSmiResult & { missing?: boolean }> {
  if (signal?.aborted) return { ok: false, output: "", detail: "已暂停" };
  return new Promise((resolve) => {
    let child;
    try { child = spawn(executable, [], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { resolve({ ok: false, output: "", detail: "无法启动 nvidia-smi。" }); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, timedOut = false, tooLarge = false, failure: NodeJS.ErrnoException | undefined;
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) { tooLarge = true; child.kill("SIGKILL"); return; }
      chunks.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error: NodeJS.ErrnoException) => { failure = error; });
    const abort = () => { child.kill("SIGKILL"); };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 5000);
    // Wait for close, including after cancellation, so refreshes never overlap children.
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return resolve({ ok: false, output: "", detail: "已暂停" });
      if (failure?.code === "ENOENT") return resolve({ ok: false, output: "", detail: "未找到 nvidia-smi", missing: true });
      if (timedOut) return resolve({ ok: false, output: "", detail: "nvidia-smi 执行超时（5 秒），监控已暂停。" });
      if (tooLarge) return resolve({ ok: false, output: "", detail: "nvidia-smi 输出超过 1 MiB，监控已暂停。" });
      const output = [cleanOutput(Buffer.concat(stdout).toString("utf8")), cleanOutput(Buffer.concat(stderr).toString("utf8"))].filter(Boolean).join("\n");
      const ok = !failure && code === 0 && Boolean(output);
      resolve({ ok, output, detail: ok ? "采样成功" : failure ? "无法执行 nvidia-smi，请检查可执行文件和权限。"
        : output ? "nvidia-smi 返回错误，监控已暂停。" : "nvidia-smi 未返回有效输出，监控已暂停。" });
    });
    // Account for cancellation between the initial check and listener registration.
    if (signal?.aborted) abort();
  });
}

function cleanOutput(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd();
}

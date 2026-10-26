import { Client, type ClientChannel } from "ssh2";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { cpuUsageBetween, type CpuSnapshot, type CpuUsage } from "./cpuUsage";
import { gpuServerSignature, type GpuServer } from "./gpuServerConfig";
import type { NvidiaSmiResult } from "./nvidiaSmi";

export interface RemoteGpuSample { gpu: NvidiaSmiResult; cpu: CpuUsage; connected?: boolean }
export interface GpuServerProbe { check(server: GpuServer, signal?: AbortSignal): Promise<boolean>; dispose(): void }
export interface RemoteGpuReader {
  read(server: GpuServer, signal?: AbortSignal): Promise<RemoteGpuSample>;
  reset(): void;
  dispose(): void;
}
export interface GpuHostKeyStore { verify(endpoint: string, fingerprint: string): Promise<boolean> }
interface KeyState { get<T>(key: string, fallback: T): T; update(key: string, value: unknown): PromiseLike<void> }

/** First-use host-key pinning; credentials are never written to extension storage. */
export class SavedGpuHostKeys implements GpuHostKeyStore {
  private pending = Promise.resolve();
  private memory: Record<string, string> = {};
  public constructor(private readonly state?: KeyState) {}
  public verify(endpoint: string, fingerprint: string): Promise<boolean> {
    const result = this.pending.then(async () => {
      const keys = { ...(this.state?.get<Record<string, string>>("gpu.sshHostKeys", {}) ?? this.memory) };
      if (keys[endpoint]) return keys[endpoint] === fingerprint;
      keys[endpoint] = fingerprint;
      for (const key of Object.keys(keys).slice(0, Math.max(0, Object.keys(keys).length - 200))) delete keys[key];
      if (this.state) await this.state.update("gpu.sshHostKeys", keys);
      else this.memory = keys;
      return true;
    });
    this.pending = result.then(() => {}, () => {});
    return result;
  }
}

const BEFORE = "__AGENT_CENTER_CPU_BEFORE_9F820A__";
const GPU = "__AGENT_CENTER_GPU_9F820A__";
const AFTER = "__AGENT_CENTER_CPU_AFTER_9F820A__";
const STATUS = "__AGENT_CENTER_STATUS_9F820A__";

/** Fixed read-only script. None of its text comes from the Markdown document. */
export function remoteGpuCommand(warmup: boolean): string {
  return ["export LC_ALL=C", "printf '\\n" + BEFORE + "\\n'", "cat /proc/stat 2>/dev/null",
    "printf '" + GPU + "\\n'", "nvidia-smi 2>&1", "agent_center_gpu_exit=$?",
    ...(warmup ? ["sleep 0.25"] : []), "printf '\\n" + AFTER + "\\n'", "cat /proc/stat 2>/dev/null",
    "printf '" + STATUS + ":%s\\n' \"$agent_center_gpu_exit\""].join("\n");
}

export function linuxCpuSnapshot(text: string): CpuSnapshot | undefined {
  const cores = text.match(/^cpu\d+\s/gm)?.length ?? 0;
  const line = /^cpu\s+(.+)$/m.exec(text);
  if (!cores || !line) return undefined;
  // guest/guest_nice are already included in user/nice; never count them twice.
  const values = line[1].trim().split(/\s+/).slice(0, 8).map(Number);
  if (values.length < 4 || values.some(value => !Number.isFinite(value) || value < 0)) return undefined;
  return { cores, total: values.reduce((sum, value) => sum + value, 0), idle: values[3] + (values[4] ?? 0) };
}

export function parseRemoteGpuSample(output: string, previous?: CpuSnapshot): RemoteGpuSample & { snapshot?: CpuSnapshot } {
  const before = output.indexOf(BEFORE + "\n"), gpu = output.indexOf(GPU + "\n", before), after = output.indexOf("\n" + AFTER + "\n", gpu);
  const status = output.indexOf(STATUS + ":", after);
  if (before < 0 || gpu <= before || after <= gpu || status <= after) return unavailable("远程采样结果不完整。");
  const first = linuxCpuSnapshot(output.slice(before + BEFORE.length + 1, gpu));
  const snapshot = linuxCpuSnapshot(output.slice(after + AFTER.length + 2, status));
  const cpu = snapshot && (previous || first) ? cpuUsageBetween(previous ?? first!, snapshot) : undefined;
  const text = clean(output.slice(gpu + GPU.length + 1, after));
  const code = output.slice(status + STATUS.length + 1).trim();
  const ok = code === "0" && Boolean(text);
  return { gpu: { ok, output: text, detail: ok ? "采样成功" : code === "127" ? "远程机器未找到 nvidia-smi。" : "远程 nvidia-smi 返回错误，监控已暂停。" },
    cpu: cpu ?? { state: "unavailable", logicalCores: snapshot?.cores ?? 0 }, snapshot };
}

class SafeGpuError extends Error {}

export class SshGpuReader implements RemoteGpuReader {
  private client: Client | undefined;
  private ready = false;
  private signature = "";
  private previous: CpuSnapshot | undefined;
  public constructor(private readonly keys: GpuHostKeyStore = new SavedGpuHostKeys()) {}

  public async read(server: GpuServer, signal?: AbortSignal): Promise<RemoteGpuSample> {
    if (signal?.aborted) return unavailable("已暂停");
    try {
      const signature = gpuServerSignature(server);
      if (this.signature !== signature) { this.reset(); this.signature = signature; }
      const client = await this.connect(server, signal);
      const output = await this.execute(client, remoteGpuCommand(!this.previous), signal);
      if (signal?.aborted || this.client !== client) return unavailable("已暂停");
      const sample = parseRemoteGpuSample(output, this.previous);
      this.previous = sample.snapshot;
      return { gpu: sample.gpu, cpu: sample.cpu, connected: true };
    } catch (error) {
      this.reset();
      return unavailable(error instanceof SafeGpuError ? error.message : "无法读取远程 GPU/CPU 状态。");
    }
  }

  public reset(): void {
    const client = this.client;
    this.client = undefined; this.ready = false; this.previous = undefined; this.signature = "";
    client?.destroy();
  }
  public dispose(): void { this.reset(); }

  public async checkConnection(server: GpuServer, signal?: AbortSignal): Promise<boolean> {
    try { await this.connect(server, signal); return !signal?.aborted; }
    catch { return false; }
    finally { this.reset(); }
  }

  private async connect(server: GpuServer, signal?: AbortSignal): Promise<Client> {
    if (this.client && this.ready) return this.client;
    let privateKey: Buffer | undefined;
    const candidates = server.privateKeyPath ? [server.privateKeyPath] : server.password ? [] : [path.join(os.homedir(), ".ssh", "id_ed25519"), path.join(os.homedir(), ".ssh", "id_rsa")];
    for (const candidate of candidates) {
      try {
        const file = candidate.replace(/^~(?=[/\\]|$)/, os.homedir());
        if ((await fs.stat(file)).size > 128 * 1024) throw new Error();
        privateKey = await fs.readFile(file); break;
      } catch { if (server.privateKeyPath) throw new SafeGpuError("无法读取当前扩展宿主中的 SSH 密钥文件。"); }
    }
    if (signal?.aborted) throw new SafeGpuError("已暂停");
    if (!server.password && !privateKey && !process.env.SSH_AUTH_SOCK) throw new SafeGpuError("服务器未配置密码或当前扩展宿主可用的 SSH 密钥。");
    const client = new Client();
    this.client = client;
    return new Promise((resolve, reject) => {
      let settled = false, keyMismatch = false;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const fail = (detail: string) => { if (settled) return; settled = true; cleanup(); client.destroy(); reject(new SafeGpuError(detail)); };
      const abort = () => fail("已暂停");
      const timer = setTimeout(() => fail("SSH 连接超时（12 秒）。"), 12000);
      signal?.addEventListener("abort", abort, { once: true });
      client.on("error", (error: Error & { level?: string; code?: string }) => {
        if (this.client === client) this.ready = false;
        fail(keyMismatch ? "SSH 主机密钥与首次连接记录不一致。" : error.level === "client-authentication" ? "SSH 登录失败，请检查可用服务器.md 中的登录信息。"
          : error.code === "ECONNREFUSED" ? "SSH 连接被拒绝，请检查可用服务器.md 中的端口及服务器 SSH 服务。"
          : error.code === "ENOTFOUND" ? "SSH 服务器地址无法解析。" : "SSH 连接失败，请检查服务器地址、端口和网络。");
      });
      client.on("close", () => {
        if (this.client === client) { this.client = undefined; this.ready = false; this.previous = undefined; }
        fail("SSH 连接已关闭。");
      });
      client.once("ready", () => {
        if (settled) return;
        settled = true; cleanup(); this.ready = true; resolve(client);
      });
      client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
        finish(server.password && prompts.length === 1 && !prompts[0].echo && /password|密码/i.test(prompts[0].prompt) ? [server.password] : []);
      });
      try {
        client.connect({ host: server.host, port: server.port, username: server.username, password: server.password, privateKey,
          agent: process.env.SSH_AUTH_SOCK, tryKeyboard: Boolean(server.password), readyTimeout: 10000, keepaliveInterval: 15000, keepaliveCountMax: 3,
          hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
            const endpoint = createHash("sha256").update(server.host + ":" + server.port).digest("hex");
            const fingerprint = createHash("sha256").update(key).digest("hex");
            void this.keys.verify(endpoint, fingerprint).then(valid => { keyMismatch = !valid; callback(valid && !signal?.aborted); }, () => callback(false));
          } });
      } catch { fail("SSH 登录配置不可用，请检查密码或密钥格式。"); }
      if (signal?.aborted) abort();
    });
  }

  private execute(client: Client, command: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false, size = 0, channel: ClientChannel | undefined;
      const chunks: Buffer[] = [];
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); client.removeListener("close", closed); };
      const fail = (detail: string) => { if (settled) return; settled = true; cleanup(); channel?.destroy(); client.destroy(); reject(new SafeGpuError(detail)); };
      const abort = () => fail("已暂停");
      const closed = () => fail("SSH 连接已关闭。");
      const timer = setTimeout(() => fail("远程采样超时（7 秒），监控已暂停。"), 7000);
      signal?.addEventListener("abort", abort, { once: true }); client.once("close", closed);
      if (signal?.aborted) { abort(); return; }
      client.exec(command, (error, stream) => {
        if (settled) { stream?.destroy(); return; }
        if (error) { fail("无法启动远程采样命令。"); return; }
        channel = stream;
        const collect = (data: Buffer, keep: boolean) => {
          size += data.length;
          if (size > 1024 * 1024) { fail("远程采样输出超过 1 MiB，监控已暂停。"); return; }
          if (keep) chunks.push(Buffer.from(data));
        };
        stream.on("data", (data: Buffer) => collect(data, true));
        stream.stderr.on("data", (data: Buffer) => collect(data, false));
        stream.on("error", () => fail("远程采样流已中断。"));
        stream.on("close", () => {
          if (settled) return;
          settled = true; cleanup(); resolve(Buffer.concat(chunks).toString("utf8"));
        });
      });
    });
  }
}

function unavailable(detail: string): RemoteGpuSample {
  return { gpu: { ok: false, output: "", detail }, cpu: { state: "unavailable", logicalCores: 0 }, connected: false };
}
function clean(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
}

/** Separate short-lived login checks never interrupt the selected host's sampler. */
export class SshGpuProbe implements GpuServerProbe {
  private readonly readers = new Set<SshGpuReader>();
  public constructor(private readonly keys: GpuHostKeyStore = new SavedGpuHostKeys()) {}
  public async check(server: GpuServer, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const reader = new SshGpuReader(this.keys); this.readers.add(reader);
    try { return await reader.checkConnection(server, signal); }
    finally { this.readers.delete(reader); reader.dispose(); }
  }
  public dispose(): void { for (const reader of this.readers) reader.dispose(); this.readers.clear(); }
}

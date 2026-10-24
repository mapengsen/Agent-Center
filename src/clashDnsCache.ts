import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { load, JSON_SCHEMA } from "js-yaml";
import { dnsPolicy, verifySubscriptionDns } from "./clashDns";
import { readClashDocument } from "./clashRuntime";

export const DNS_CACHE_INTERVAL_MS = 5 * 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;
const attempts = new Map<string, number>();
interface Source { key: string; url: string }
export interface CachedDns { dns: Record<string, unknown>; downloadedAt: string; fromCache: boolean }
export type DnsDownloader = (url: string, signal?: AbortSignal) => Promise<Record<string, unknown>>;

/** Cache DNS policy only, never nodes, subscription URLs or controller credentials. */
export class ClashDnsCache {
  public constructor(private readonly root: string, private readonly runtime: string, private readonly legacy: boolean,
    private readonly download: DnsDownloader = downloadDns, private readonly now: () => number = Date.now) {}

  private async source(): Promise<Source> {
    let url: string, name: string, type = "clash";
    if (this.legacy) {
      const env = await fs.readFile(path.join(this.root, ".env"), "utf8");
      const match = env.match(/^\s*(?:export\s+)?CLASH_CONFIG_URL\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#]+))\s*(?:#.*)?$/m);
      url = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
      name = "legacy";
    } else {
      const list = await readClashDocument(path.join(this.runtime, "subscriptions.yaml"));
      name = typeof list.active === "string" ? list.active : "";
      const source = record(list.sources) && Object.hasOwn(list.sources, name) ? list.sources[name] : undefined;
      if (!record(source) || source.enabled === false) throw new Error("DNS 暂无可用的当前订阅。");
      url = typeof source.url === "string" ? source.url : "";
      type = typeof source.type === "string" ? source.type : "clash";
    }
    try {
      const parsed = new URL(url);
      if (!["http:", "https:", "file:"].includes(parsed.protocol) || /[\x00-\x20\x7f]/.test(url) || url.length > 8192) throw new Error();
    } catch { throw new Error("DNS 当前订阅地址无法读取。"); }
    return { url, key: createHash("sha256").update(JSON.stringify([name, type, url])).digest("hex") };
  }

  private directory(): string { return path.join(this.runtime, ".agent-center-dns-cache"); }
  private file(source: Source): string { return path.join(this.directory(), source.key + ".json"); }

  private async read(source: Source): Promise<CachedDns | undefined> {
    try {
      if (!(await fs.lstat(this.directory())).isDirectory()) return undefined;
      const file = this.file(source);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (value.version !== 1 || value.sourceKey !== source.key || typeof value.downloadedAt !== "string" ||
          !Number.isFinite(Date.parse(value.downloadedAt)) || Date.parse(value.downloadedAt) > this.now() + 300000) return undefined;
      verifySubscriptionDns({ dns: value.dns }, { dns: value.dns });
      return { dns: dnsPolicy(value.dns), downloadedAt: new Date(value.downloadedAt).toISOString(), fromCache: true };
    } catch { return undefined; }
  }

  private async save(source: Source, dns: unknown, signal?: AbortSignal): Promise<CachedDns> {
    signal?.throwIfAborted();
    verifySubscriptionDns({ dns }, { dns });
    // A changed URL, source name, type or active source must not reuse this download.
    if ((await this.source()).key !== source.key) throw new Error("DNS 当前订阅已改变，请重试。");
    const result: CachedDns = { dns: dnsPolicy(dns), downloadedAt: new Date(this.now()).toISOString(), fromCache: false };
    const directory = this.directory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("DNS 缓存目录不能为符号链接。");
    await fs.chmod(directory, 0o700);
    const file = this.file(source), temporary = file + "." + randomBytes(8).toString("hex");
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, sourceKey: source.key, dns: result.dns, downloadedAt: result.downloadedAt }), { flag: "wx", mode: 0o600 });
      signal?.throwIfAborted();
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return result;
  }

  /** Manual action always tries a fresh download, even if the cache is recent. */
  public async resolve(signal?: AbortSignal): Promise<CachedDns> {
    const source = await this.source();
    try { return await this.save(source, (await this.download(source.url, signal)).dns, signal); }
    catch {
      signal?.throwIfAborted();
      if ((await this.source()).key !== source.key) throw new Error("DNS 当前订阅已改变，请重试。");
      const cached = await this.read(source);
      if (cached) return cached;
      throw new Error("DNS 订阅下载失败且没有当前订阅的有效缓存，请联网后重试。");
    }
  }

  /** Background refresh never applies DNS, restarts Clash or changes the active source. */
  public async refresh(signal?: AbortSignal): Promise<void> {
    const source = await this.source();
    const cached = await this.read(source);
    if (cached && this.now() - Date.parse(cached.downloadedAt) < DNS_CACHE_INTERVAL_MS) return;
    const key = this.runtime + ":" + source.key;
    const previous = attempts.get(key);
    if (previous !== undefined && this.now() >= previous && this.now() - previous < RETRY_MS) return;
    if (attempts.size >= 256) attempts.delete(attempts.keys().next().value!);
    attempts.set(key, this.now());
    await this.save(source, (await this.download(source.url, signal)).dns, signal);
  }

  /** An explicit native subscription update has already downloaded this source. */
  public async remember(dns: unknown): Promise<void> { await this.save(await this.source(), dns); }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function downloadDns(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let text: string;
  if (url.startsWith("file:")) {
    const file = fileURLToPath(url), stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("DNS 订阅文件无效。");
    text = await fs.readFile(file, { encoding: "utf8", signal });
  } else {
    const response = await axios.get<string>(url, { responseType: "text", transformResponse: [(data) => data],
      timeout: 15000, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      maxRedirects: 5, maxContentLength: MAX_BYTES, headers: { "User-Agent": "clash.meta" } });
    text = response.data;
  }
  const value: unknown = load(text, { schema: JSON_SCHEMA });
  if (!record(value)) throw new Error("DNS 订阅格式无效。");
  verifySubscriptionDns(value, value);
  return value;
}

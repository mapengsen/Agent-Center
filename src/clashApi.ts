import * as http from "node:http";
import * as https from "node:https";

export interface ClashProxy {
  type: string;
  now?: string;
  all?: string[];
  history?: Array<{ time?: string; delay?: number }>;
}
export type ClashProxies = Record<string, ClashProxy>;
export interface ClashState { proxies: ClashProxies; mode: string }
export interface ClashApiOptions { controller: string; secret: string; timeoutMs: number }
export type DelayResult = { ok: true; ms: number } | { ok: false; error: string };

export class ClashApiClient {
  public constructor(private readonly options: ClashApiOptions) {}

  public async getState(): Promise<ClashState> {
    const [proxies, config] = await Promise.all([this.getProxies(), this.request("/configs")]);
    if (!isRecord(config) || typeof config.mode !== "string") throw new Error("Clash 路由模式响应无效。");
    return { proxies, mode: config.mode.toLowerCase() };
  }

  public async getProxies(): Promise<ClashProxies> {
    const response = await this.request("/proxies");
    if (!isRecord(response) || !isRecord(response.proxies)) throw new Error("Clash 节点列表响应无效。");
    const proxies: ClashProxies = Object.create(null);
    for (const [name, value] of Object.entries(response.proxies)) {
      if (!isRecord(value) || typeof value.type !== "string") continue;
      proxies[name] = {
        type: value.type,
        now: typeof value.now === "string" ? value.now : undefined,
        all: Array.isArray(value.all) ? value.all.filter((name): name is string => typeof name === "string") : undefined,
        history: Array.isArray(value.history) ? value.history.filter(isRecord).map((entry) => ({
          delay: typeof entry.delay === "number" ? entry.delay : undefined,
          time: typeof entry.time === "string" ? entry.time : undefined,
        })) : undefined,
      };
    }
    return proxies;
  }

  public async select(group: string, node: string): Promise<void> {
    await this.request("/proxies/" + encodeURIComponent(group), "PUT", { name: node });
  }

  public async reloadConfig(configPath: string): Promise<void> {
    await this.request("/configs?force=true", "PUT", { path: configPath }, 30000);
  }

  public async flushDnsCache(): Promise<boolean> {
    try { await this.request("/cache/dns/flush", "POST"); return true; }
    catch { return false; } // Older Clash/Mihomo versions may not expose this API.
  }

  public async testDelay(node: string, url: string, timeoutMs: number): Promise<DelayResult> {
    try {
      const query = new URLSearchParams({ url, timeout: String(timeoutMs) });
      const response = await this.request(
        "/proxies/" + encodeURIComponent(node) + "/delay?" + query.toString(),
        "GET", undefined, timeoutMs + 1500,
      );
      if (!isRecord(response) || typeof response.delay !== "number" ||
          !Number.isFinite(response.delay) || response.delay <= 0) {
        throw new Error("Clash 未返回有效延迟。");
      }
      return { ok: true, ms: Math.round(response.delay) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async request(
    path: string, method = "GET", body?: unknown, timeoutMs = this.options.timeoutMs,
  ): Promise<unknown> {
    const target = new URL(this.options.controller.replace(/\/+$/, "") + path);
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("Clash 控制器必须使用 HTTP/HTTPS。");
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string | number> = { Accept: "application/json" };
    if (this.options.secret) headers.Authorization = "Bearer " + this.options.secret;
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    // The controller must bypass environment HTTP proxies, including Clash itself.
    return await new Promise((resolve, reject) => {
      const request = (target.protocol === "https:" ? https : http).request(target, { method, headers }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("error", reject);
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) request.destroy(new Error("Clash API 响应过大。"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(status === 401 || status === 403
              ? "Clash 控制器鉴权失败，请检查配置路径或 secret。"
              : "Clash API HTTP " + status));
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          try { resolve(text ? JSON.parse(text) : undefined); }
          catch { reject(new Error("Clash API 返回了无效 JSON。")); }
        });
      });
      const timer = setTimeout(() => request.destroy(new Error("Clash API 请求超时。")), timeoutMs);
      request.once("close", () => clearTimeout(timer));
      request.once("error", reject);
      request.end(payload);
    });
  }
}

export function isProxyGroup(proxy: ClashProxy | undefined): boolean {
  return Array.isArray(proxy?.all);
}

export function resolveProxyChain(proxies: ClashProxies, start: string): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = start;
  while (current && !visited.has(current) && chain.length < 32) {
    chain.push(current);
    visited.add(current);
    current = proxies[current]?.now;
  }
  return chain;
}

export function findActiveGroup(state: ClashState, configuredGroup = "", preferredGroups: string[] = []): string {
  if (state.mode === "global" && state.proxies.GLOBAL) return "GLOBAL";
  if (state.mode === "direct") return "DIRECT";
  if (configuredGroup) {
    if (!isProxyGroup(state.proxies[configuredGroup])) throw new Error("未找到配置的 Clash 代理组：" + configuredGroup);
    return configuredGroup;
  }
  const groups = Object.keys(state.proxies).filter((name) => name !== "GLOBAL" && isProxyGroup(state.proxies[name]));
  const ordered = [...preferredGroups, "🔰 节点选择", "节点选择", "PROXY", "Proxy", ...groups];
  const group = ordered.find((name) => groups.includes(name) && state.proxies[name].type === "Selector")
    ?? ordered.find((name) => groups.includes(name));
  if (!group) throw new Error("没有找到可用的 Clash 代理组。");
  return group;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

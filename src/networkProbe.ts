// Bare module names also pass through VS Code's per-extension transport hook.
import * as http from "http";
import * as https from "https";
import { performance } from "node:perf_hooks";

export const GOOGLE_WEB_URL = "https://www.google.com/";

export interface NetworkProbeResult {
  status: "available" | "error";
  detail: string;
  elapsedMs: number;
  httpStatus?: number;
}

export function probeGoogle(timeoutMs: number, signal?: AbortSignal): Promise<NetworkProbeResult> {
  return probeWebsite(GOOGLE_WEB_URL, timeoutMs, signal);
}

// Use Node's ordinary HTTP(S) transport so VS Code's extension-host proxy and
// certificate support can apply. Do not force the request through the Clash API.
export function probeWebsite(url: string, timeoutMs: number, signal?: AbortSignal): Promise<NetworkProbeResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    const controller = new AbortController();
    let request: http.ClientRequest | undefined;
    let finished = false;
    const elapsedMs = () => Math.max(1, Math.round(performance.now() - started));
    const finish = (result: Omit<NetworkProbeResult, "elapsedMs">) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve({ ...result, elapsedMs: elapsedMs() });
      controller.abort();
      request?.destroy();
    };
    const cancel = () => finish({ status: "error", detail: "已取消" });
    // A wall-clock deadline also bounds DNS, TLS and proxy lookup.
    const timer = setTimeout(() => {
      finish({ status: "error", detail: "超时" });
    }, timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }

    let target: URL;
    try {
      target = new URL(url);
      if (!isWebUrl(target)) throw new Error("Invalid website URL");
    } catch {
      finish({ status: "error", detail: "网址无效" });
      return;
    }

    try {
      const transport = target.protocol === "https:" ? https : http;
      request = transport.request(target, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "text/html", "User-Agent": "Agent-Center" },
      }, (response) => {
        // Every HTTP response counts, including redirects and 4xx/5xx.
        // Stop at headers without reading the page or following redirects.
        const status = response.statusCode ?? 0;
        response.on("error", () => {});
        response.destroy();
        finish({ status: "available", detail: "已收到 HTTP 响应", httpStatus: status });
      });
      request.on("error", (error: NodeJS.ErrnoException) => {
        finish({ status: "error", detail: networkError(error.code) });
      });
      request.end();
    } catch {
      finish({ status: "error", detail: "连接失败" });
    }
  });
}

function isWebUrl(url: URL): boolean {
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
}

function networkError(code?: string): string {
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS 解析失败";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "超时";
  if (code === "ECONNREFUSED") return "连接被拒绝";
  if (code === "ECONNRESET" || code === "EPIPE") return "连接被重置";
  if (code?.includes("CERT") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "TLS 证书错误";
  return "连接失败";
}

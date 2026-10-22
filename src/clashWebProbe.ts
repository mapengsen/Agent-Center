import { execFile } from "node:child_process";
import * as net from "node:net";

export interface ClashWebProbe { status: "success" | "failed" | "skipped"; detail: string; httpStatus?: number }

export function probeClashGoogle(config: Record<string, unknown>): Promise<ClashWebProbe> {
  if (Array.isArray(config.authentication) && config.authentication.length) {
    return Promise.resolve({ status: "skipped", detail: "本机代理启用了认证，请手动测试网页访问。" });
  }
  const mixed = Number(config["mixed-port"] || config.port);
  const socks = Number(config["socks-port"]);
  const port = mixed || socks;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve({ status: "skipped", detail: "未找到可用的本机 HTTP/SOCKS 代理端口，未检测网页。" });
  }
  const configuredHost = config["bind-address"];
  const host = typeof configuredHost === "string" && net.isIP(configuredHost) && !["0.0.0.0", "::"].includes(configuredHost) ? configuredHost : "127.0.0.1";
  const proxy = `${mixed ? "http" : "socks5h"}://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  return new Promise((resolve) => {
    // -q ignores .curlrc. Explicit proxy plus empty noproxy prevents silently
    // testing a direct route or another inherited HTTP_PROXY. No login/API data.
    execFile("curl", ["-q", "--proxy", proxy, "--noproxy", "", "--silent", "--show-error", "--location", "--max-redirs", "3",
      "--connect-timeout", "5", "--max-time", "15", "--max-filesize", "2097152", "--output", "/dev/null",
      "--write-out", "%{http_code} %{size_download}", "https://www.google.com/"],
    { windowsHide: true, shell: false, timeout: 18000, maxBuffer: 32 * 1024, encoding: "utf8" }, (error, stdout) => {
      const [code, bytes] = stdout.trim().split(/\s+/).map(Number);
      if (!error && code >= 200 && code < 300 && bytes > 0) {
        resolve({ status: "success", detail: "通过当前 Clash 代理下载 Google 网页成功。", httpStatus: code });
      } else if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        resolve({ status: "skipped", detail: "当前环境没有 curl，未检测网页。" });
      } else {
        resolve({ status: "failed", detail: code > 0 ? `Google 网页验证未通过（HTTP ${code}），请继续检查节点与路由。` : "Google 网页访问仍超时或连接失败，请继续检查节点与路由。", httpStatus: code > 0 ? code : undefined });
      }
    });
  });
}

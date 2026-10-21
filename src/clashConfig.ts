import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { JSON_SCHEMA, load } from "js-yaml";
import type { ClashApiOptions } from "./clashApi";
import { discoverClashConfigCandidates, type ClashDiscoveryOptions } from "./clashDiscovery";
import { clashInstallationConfigs } from "./clashLayout";

export const CLASH_TEST_URL = "https://www.gstatic.com/generate_204";
export interface ClashSettings {
  controller: string;
  secret: string;
  configPath: string;
  group: string;
  testTimeoutMs: number;
  updateIntervalSeconds: number;
  installDirectory?: string;
}
export interface ClashConnection extends ClashApiOptions {
  configPath: string;
  preferredGroups: string[];
}

export async function loadClashConnection(
  settings: ClashSettings, home = os.homedir(), discovery: ClashDiscoveryOptions = {},
): Promise<ClashConnection> {
  const configuredPath = settings.configPath.trim();
  const candidates = configuredPath ? [expandHome(configuredPath, home)] : [
    ...(settings.installDirectory?.trim()
      ? [...clashInstallationConfigs(expandHome(settings.installDirectory.trim(), home)),
        path.join(expandHome(settings.installDirectory.trim(), home), "resources", "runtime.yaml")] : []),
    ...await discoverClashConfigCandidates(home, discovery),
    path.join(home, "clash-for-linux", "runtime", "config.yaml"),
    path.join(home, ".config", "mihomo", "config.yaml"),
    path.join(home, ".config", "clash", "config.yaml"),
    "/opt/clash-for-linux/runtime/config.yaml",
    "/etc/mihomo/config.yaml",
    "/etc/clash/config.yaml",
  ];
  let config: Record<string, unknown> = {};
  let configPath = "";
  for (const candidate of new Set(candidates)) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Clash 配置文件过大或不是普通文件。");
      const text = await fs.readFile(candidate, "utf8");
      try {
        const data = load(text, { schema: JSON_SCHEMA });
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
        config = data as Record<string, unknown>;
      } catch {
        // Parser errors may include credential-bearing YAML snippets.
        throw new Error("无法解析 Clash 配置文件：" + candidate);
      }
      configPath = candidate;
      break;
    } catch (error) {
      if (!configuredPath && ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
  }
  const rawController = settings.controller.trim() ||
    stringValue(config["external-controller"]) || "http://127.0.0.1:9090";
  const controller = normalizeController(rawController);
  const secret = settings.secret || stringValue(config.secret);
  const preferredGroups = Array.isArray(config["proxy-groups"])
    ? (config["proxy-groups"] as Array<Record<string, unknown>>)
      .filter((entry) => entry && typeof entry.name === "string")
      .map((entry) => String(entry.name))
    : [];
  return { controller, secret, configPath, preferredGroups, timeoutMs: 5000 };
}

export function normalizeController(raw: string): string {
  const url = new URL(raw.includes("://") ? raw : "http://" + raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("Clash 控制器应为 http(s)://主机:端口。");
  }
  if (["0.0.0.0", "*"].includes(url.hostname)) url.hostname = "127.0.0.1";
  if (url.hostname === "[::]") url.hostname = "[::1]";
  return url.origin;
}

function expandHome(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") || value.startsWith("~\\")
    ? path.join(home, value.slice(2)) : value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

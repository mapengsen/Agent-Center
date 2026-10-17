import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import axios from "axios";
import { JSON_SCHEMA, load } from "js-yaml";
import { ClashApiClient, type ClashProxies } from "./clashApi";
import type { ClashConnection } from "./clashConfig";

export interface ClashSubscription { name: string; displayName: string; hostname?: string; enabled: boolean; type: string }
export interface SubscriptionList { active: string; sources: ClashSubscription[] }
export interface SubscriptionRemoval { active: string; stopped: boolean }
export type SubscriptionRunner = (root: string, action: "add" | "use" | "remove" | "start" | "stop", name: string, url?: string) => Promise<void>;

/** URLs stay in the native subscription file; list/diagnostic results never expose them. */
export class ClashSubscriptions {
  public constructor(public readonly root: string, private readonly run: SubscriptionRunner = runSubscriptionCommand) {}

  public async list(options: { resolveNames?: boolean } = {}): Promise<SubscriptionList> {
    const file = path.join(this.root, "runtime", "subscriptions.yaml");
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("订阅列表文件过大或无效。");
    let value: unknown;
    try { value = load(await fs.readFile(file, "utf8"), { schema: JSON_SCHEMA }); }
    catch { throw new Error("无法解析 Clash 订阅列表。"); }
    if (!record(value) || !record(value.sources)) throw new Error("Clash 订阅列表格式不兼容。");
    const entries = Object.entries(value.sources).filter(([, source]) => record(source));
    const sources: ClashSubscription[] = [];
    // Explicit pickers and adding a URL may contact providers; refreshes reuse names.
    for (let offset = 0; offset < entries.length; offset += 4) {
      sources.push(...await Promise.all(entries.slice(offset, offset + 4).map(async ([name, source]) => {
        const item = source as Record<string, unknown>;
        let url: string | undefined;
        let hostname: string | undefined;
        try {
          url = validateSubscriptionUrl(String(item.url ?? ""));
          hostname = new URL(url).hostname;
        } catch { /* Local files and legacy sources keep their saved names. */ }
        const title = url ? options.resolveNames ? await subscriptionTitle(url) : titleCache.get(url)?.title : undefined;
        return {
          name, displayName: title || hostname || name, hostname, enabled: item.enabled !== false,
          type: typeof item.type === "string" ? item.type : "clash",
        };
      })));
    }
    return {
      active: typeof value.active === "string" ? value.active : "",
      sources,
    };
  }

  public async suggestName(url: string): Promise<string> {
    const normalized = validateSubscriptionUrl(url);
    const title = await subscriptionTitle(normalized);
    const before = await this.list();
    return availableSubscriptionName(title || new URL(normalized).hostname, before.sources.map((source) => source.name));
  }

  public async add(name: string, url: string, options: { uniqueName?: boolean } = {}): Promise<string> {
    validateSubscriptionName(name);
    const normalized = validateSubscriptionUrl(url);
    return this.lock(async () => {
      const before = await this.list();
      // Recheck under the lock: another window may have saved the suggested name.
      if (options.uniqueName) name = availableSubscriptionName(name, before.sources.map((source) => source.name));
      if (before.sources.some((source) => source.name === name)) throw new Error("订阅名称已存在，请使用其他名称。");
      await this.run(this.root, "add", name, normalized);
      const after = await this.list();
      if (!after.sources.some((source) => source.name === name) || after.active !== before.active) {
        throw new Error("未能确认订阅保存结果，请检查 Clash 订阅列表。");
      }
      return name;
    });
  }

  public async use(name: string, connection: ClashConnection): Promise<void> {
    validateSubscriptionName(name);
    await this.lock(() => this.switchUnlocked(name, connection));
  }

  private async switchUnlocked(name: string, connection: ClashConnection): Promise<void> {
    const before = await this.list();
    if (!before.sources.find((source) => source.name === name)?.enabled) throw new Error("订阅不存在或已禁用，请刷新列表。");
    const previousActive = before.sources.some((source) => source.name === before.active) ? before.active : "";
    if (previousActive) validateSubscriptionName(previousActive);
    const api = new ClashApiClient(connection);
    let previousNodes: ClashProxies | undefined;
    if (previousActive) {
      try { previousNodes = await api.getProxies(); }
      catch { /* A stopped controller must still allow applying and starting a subscription. */ }
    }
    if (before.active === name && previousNodes) return;
    const file = path.join(this.root, "runtime", "subscriptions.yaml");
    const backup = await fs.readFile(file);
    try {
      await this.run(this.root, "use", name);
      if ((await this.list()).active !== name) throw new Error();
      if (!previousNodes) await this.run(this.root, "start", "");
      await this.waitForController(api);
    } catch {
      let restored = false;
      try {
        await atomicWrite(file, backup);
        if (previousActive) await this.run(this.root, "use", previousActive);
        if (previousNodes) {
          await this.waitForController(api);
          await this.restoreNodes(api, previousNodes);
        } else await this.run(this.root, "stop", "");
        restored = (await this.list()).active === before.active;
      } catch { /* Recovery errors must not expose native output or subscription URLs. */ }
      throw new Error(restored
        ? "切换订阅失败，已恢复原订阅和节点选择。请检查订阅是否可用。"
        : "切换订阅失败，自动恢复未完成。请在远程终端运行 clash use 恢复原订阅。");
    }
  }

  public async remove(name: string, connection: ClashConnection): Promise<SubscriptionRemoval> {
    validateSubscriptionName(name);
    return this.lock(async () => {
      const before = await this.list();
      const index = before.sources.findIndex((source) => source.name === name);
      if (index < 0) throw new Error("订阅不存在，请刷新列表。");
      const remaining = [...before.sources.slice(index + 1), ...before.sources.slice(0, index)];
      let active = before.active;
      let stopped = false;
      if (before.active === name || !remaining.some((source) => source.name === before.active)) {
        const next = remaining.find((source) => source.enabled);
        if (next) {
          // Apply and verify the replacement while the old source is still recoverable.
          await this.switchUnlocked(next.name, connection);
          active = next.name;
        } else {
          await this.run(this.root, "stop", "");
          active = "";
          stopped = true;
        }
      }
      await this.run(this.root, "remove", name);
      const after = await this.list();
      if (after.sources.some((source) => source.name === name) || after.active !== active) {
        throw new Error("未能确认订阅删除结果，请刷新订阅列表。");
      }
      return { active, stopped };
    });
  }

  private async restoreNodes(api: ClashApiClient, previous: ClashProxies): Promise<void> {
    const current = await api.getProxies();
    for (const [group, proxy] of Object.entries(previous)) {
      if (proxy.type !== "Selector" || !proxy.now || current[group]?.now === proxy.now) continue;
      if (!current[group]?.all?.includes(proxy.now)) throw new Error("原节点已不在订阅中。");
      await api.select(group, proxy.now);
    }
    const verified = await api.getProxies();
    for (const [group, proxy] of Object.entries(previous)) {
      if (proxy.type === "Selector" && proxy.now && verified[group]?.now !== proxy.now) throw new Error("节点恢复未确认。");
    }
  }

  private async waitForController(api: ClashApiClient): Promise<void> {
    const deadline = Date.now() + 15000;
    do {
      try { await api.getState(); return; }
      catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
    } while (Date.now() < deadline);
    throw new Error("Clash 重启后控制器尚未就绪。");
  }

  private async lock<T>(operation: () => Promise<T>): Promise<T> {
    const file = path.join(this.root, "runtime", ".agent-center-subscriptions.lock");
    let handle;
    try { handle = await fs.open(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("另一个窗口正在管理订阅，请稍后重试。");
      throw new Error("无法写入 Clash 目录，请检查当前远程用户权限。");
    }
    try { return await operation(); }
    finally { await handle.close(); await fs.unlink(file); }
  }
}

// Memory only: full URLs never enter displayed metadata or on-disk caches.
const titleCache = new Map<string, { title?: string; expiresAt: number }>();
const titleRequests = new Map<string, Promise<string | undefined>>();

async function subscriptionTitle(url: string): Promise<string | undefined> {
  const cached = titleCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.title;
  const pending = titleRequests.get(url);
  if (pending) return pending;
  const request = (async () => {
    let title: string | undefined;
    try {
      // GET for providers without HEAD support; stop the stream after headers.
      const response = await axios.get<Readable>(url, {
        responseType: "stream", timeout: 5000, signal: AbortSignal.timeout(5000), maxRedirects: 5,
        headers: { "User-Agent": "clash.meta" }, validateStatus: () => true,
      });
      response.data.destroy();
      if (response.status >= 200 && response.status < 300) {
        title = titleFromHeaders(response.headers["profile-title"], response.headers["content-disposition"]);
      }
    } catch { /* Metadata is optional; never surface request errors or URLs. */ }
    if (titleCache.size >= 128) titleCache.delete(titleCache.keys().next().value!);
    titleCache.set(url, { title, expiresAt: Date.now() + (title ? 3600000 : 300000) });
    return title;
  })().finally(() => titleRequests.delete(url));
  titleRequests.set(url, request);
  return request;
}

function titleFromHeaders(profile: unknown, disposition: unknown): string | undefined {
  if (typeof profile === "string") {
    const text = profile.startsWith("base64:") ? Buffer.from(profile.slice(7), "base64").toString("utf8") : profile;
    const title = cleanTitle(text);
    if (title) return title;
  }
  if (typeof disposition !== "string") return undefined;
  const encoded = disposition.match(/(?:^|;)\s*filename\*\s*=\s*"?UTF-8'[^']*'([^";]*)/i);
  if (encoded) {
    try { const title = cleanTitle(decodeURIComponent(encoded[1].trim())); if (title) return title; }
    catch { /* Fall back to the plain filename. */ }
  }
  const plain = disposition.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"\r\n]*)"|([^;\r\n]*))/i);
  return plain ? cleanTitle(plain[1] ?? plain[2]) : undefined;
}

function cleanTitle(text: string): string | undefined {
  const title = text.split(/[/\\]/).at(-1)!.replace(/\.(?:ya?ml|conf|txt)$/i, "")
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 128);
  return title && !title.includes("\ufffd") ? title : undefined;
}

function availableSubscriptionName(title: string, existing: string[]): string {
  const safe = title.normalize("NFKC").replace(/[^\p{L}\p{N}_. -]+/gu, "-")
    .replace(/ +/g, " ").replace(/^[^\p{L}\p{N}]+|[ .-]+$/gu, "");
  const base = Array.from(safe || "subscription").slice(0, 64).join("");
  const taken = new Set(existing);
  let name = base;
  for (let index = 2; taken.has(name); index++) {
    const suffix = "-" + index;
    name = Array.from(base).slice(0, 64 - suffix.length).join("") + suffix;
  }
  validateSubscriptionName(name);
  return name;
}

export async function discoverClashSubscriptions(
  configPath: string, installDirectory = "", home = os.homedir(),
): Promise<ClashSubscriptions> {
  if (process.platform === "win32") throw new Error("订阅管理需要运行于 Linux/WSL 的 clash-for-linux 环境，请在远程窗口使用。");
  const roots = installDirectory.trim() ? [expandHome(installDirectory.trim(), home)] : [
    ...(path.basename(path.dirname(configPath)) === "runtime" ? [path.dirname(path.dirname(configPath))] : []),
    path.join(home, "clash-for-linux"), path.join(home, ".local", "share", "clash-for-linux"), "/opt/clash-for-linux",
  ];
  for (const root of roots) {
    try {
      for (const rel of ["scripts/core/clashctl.sh", "scripts/core/config.sh", "runtime/bin/yq", "runtime/subscriptions.yaml"]) {
        if (!(await fs.stat(path.join(root, rel))).isFile()) throw new Error();
      }
      return new ClashSubscriptions(root);
    } catch { /* Try the next installation. */ }
  }
  throw new Error("未找到兼容的 clash-for-linux 订阅管理目录，请设置 agentStatus.clash.installDirectory。");
}

export function validateSubscriptionName(name: string): void {
  // Native scripts interpolate names into yq and cache filenames.
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,63}$/u.test(name)) {
    throw new Error("订阅名称须以字母、汉字或数字开头，最多 64 字，允许空格、下划线、连字符和点。");
  }
}

export function validateSubscriptionUrl(value: string): string {
  const text = value.trim();
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /[\x00-\x20\x7f]/.test(text) || text.length > 8192) throw new Error();
    return text;
  } catch { throw new Error("请输入有效的 HTTP/HTTPS 订阅链接。"); }
}

// Keep the URL off process arguments, terminals and error output. The add path
// uses the project's own writer without triggering a download or changing active.
const ADD_SCRIPT = [
  "set -euo pipefail",
  'PROJECT_DIR="$1"',
  'source "$PROJECT_DIR/scripts/core/common.sh"',
  'source "$PROJECT_DIR/scripts/core/config.sh"',
  'init_project_context "$PROJECT_DIR"',
  "load_env_if_exists",
  "detect_install_scope auto",
  "IFS= read -r agent_center_url",
  'set_subscription "$agent_center_url" clash "$2" false',
].join("\n");

// The caller has already switched to and verified the next source, or stopped
// the service. Remove storage only, avoiding native `default` protection and an
// unnecessary regeneration/restart when an inactive source is removed.
const REMOVE_SCRIPT = [
  "set -euo pipefail",
  'PROJECT_DIR="$1"',
  'source "$PROJECT_DIR/scripts/core/common.sh"',
  'source "$PROJECT_DIR/scripts/core/config.sh"',
  'init_project_context "$PROJECT_DIR"',
  "load_env_if_exists",
  "detect_install_scope auto",
  'NAME="$2" "$(yq_bin)" eval -i \'del(.sources[env(NAME)]) | with(select((.sources[.active] == null) or (.sources[.active].enabled == false)); .active = "")\' "$(subscriptions_file)"',
  'clear_subscription_health_all_fields "$2" || true',
].join("\n");

export async function runSubscriptionCommand(
  root: string, action: "add" | "use" | "remove" | "start" | "stop", name: string, url?: string,
): Promise<void> {
  const args = action === "add" ? ["-c", ADD_SCRIPT, "agent-center", root, name]
    : action === "use" ? [path.join(root, "scripts", "core", "clashctl.sh"), "use", name]
    : action === "remove" ? ["-c", REMOVE_SCRIPT, "agent-center", root, name]
    : [path.join(root, "scripts", "core", "clashctl.sh"), action === "start" ? "on" : "off"];
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env };
    // Do not inherit shell tracing/startup hooks which could print the URL.
    delete env.BASH_ENV;
    delete env.SHELLOPTS;
    delete env.BASHOPTS;
    const child = spawn("/bin/bash", args, { cwd: root, env, detached: true, stdio: ["pipe", "ignore", "ignore"] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
    }, 120000);
    child.on("error", () => { clearTimeout(timer); reject(new Error("无法启动 clash-for-linux 订阅命令。")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else reject(new Error(timedOut ? "订阅操作超时。" : "clash-for-linux 订阅命令执行失败。"));
    });
    child.stdin.on("error", () => { /* Child exit is reported by close. */ });
    child.stdin.end(action === "add" ? url + "\n" : undefined);
  });
}

async function atomicWrite(file: string, content: Buffer): Promise<void> {
  const temporary = file + ".agent-center-" + randomBytes(8).toString("hex");
  try {
    await fs.writeFile(temporary, content, { mode: (await fs.stat(file)).mode & 0o777, flag: "wx" });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function expandHome(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ClashApiClient } from "./clashApi";
import type { ClashConnection } from "./clashConfig";
import { discoverClashSubscriptions, runSubscriptionCommand, runClashBash, validateSubscriptionName, type ClashSubscriptions } from "./clashSubscriptions";
import { withClashLock, controllerListening, waitClashStopped, loadAndVerifyClashConfig, restoreClashSelections, snapshotClashFiles, restoreClashFiles, readClashDocument } from "./clashRuntime";
import { applySubscriptionDns, prepareDnsChange, subscriptionDnsEnabled, verifySubscriptionDns, verifyRestoredDns } from "./clashDns";
import { ClashDnsCache } from "./clashDnsCache";
import { probeClashGoogle, type ClashWebProbe } from "./clashWebProbe";

export type ClashControlAction = "start" | "stop" | "update" | "subscription-dns" | "restore-dns";
export type ClashControlRunner = (action: "start" | "stop" | "update") => Promise<void>;
export interface ClashControlResult {
  running: boolean;
  dns?: { mode: "subscription" | "local"; backupDirectory: string; web: ClashWebProbe; fromCache?: boolean; downloadedAt?: string };
}

export class ClashControl {
  public constructor(
    public readonly root: string, public readonly runtimeDirectory: string,
    public readonly configPath: string, private readonly run: ClashControlRunner,
    private readonly subscriptions?: ClashSubscriptions,
    private readonly webProbe: typeof probeClashGoogle = probeClashGoogle,
    private readonly dnsCache = new ClashDnsCache(root, runtimeDirectory, !subscriptions),
  ) {}

  public refreshDnsCache(signal?: AbortSignal): Promise<void> { return this.dnsCache.refresh(signal); }

  public async execute(action: ClashControlAction, connection: ClashConnection): Promise<ClashControlResult> {
    return withClashLock(this.runtimeDirectory, async () => {
      if (action === "stop") {
        await this.run("stop");
        await waitClashStopped(connection);
        return { running: false };
      }
      const dnsAction = action === "subscription-dns" || action === "restore-dns";
      const followDns = action === "subscription-dns" || action !== "restore-dns" && await subscriptionDnsEnabled(this.runtimeDirectory);
      let active = "";
      if (this.subscriptions) {
        const list = await this.subscriptions.list();
        if (!list.sources.find((source) => source.name === list.active)?.enabled) throw new Error("暂无可用的当前订阅，请先添加或切换订阅。");
        active = list.active;
        if (dnsAction || followDns) validateSubscriptionName(active);
      } else if (action === "update" || dnsAction) {
        const env = await fs.readFile(path.join(this.root, ".env"), "utf8");
        if (!/^\s*(?:export\s+)?CLASH_CONFIG_URL\s*=\s*["']?(?:https?|file):\/\//m.test(env)) throw new Error("旧版 Clash 未配置当前订阅地址。");
      }
      const wasRunning = await controllerListening(connection.controller);
      const previous = wasRunning ? await new ClashApiClient(connection).getProxies() : undefined;
      const stateFile = path.join(this.runtimeDirectory, "subscriptions.yaml");
      const beforeSources = this.subscriptions ? await readClashDocument(stateFile) : undefined;
      const legacy = !this.subscriptions;
      const cachedDns = action === "subscription-dns" ? await this.dnsCache.resolve() : undefined;
      const dns = dnsAction || followDns ? await prepareDnsChange(this.root, this.runtimeDirectory, legacy, action === "restore-dns") : undefined;
      const sourceFile = legacy ? path.join(this.runtimeDirectory, "config.yaml") : path.join(this.runtimeDirectory, "tmp", `source-${active}.yaml`);
      const files = await snapshotClashFiles([
        this.configPath, path.join(this.runtimeDirectory, "config.last.yaml"),
        ...(this.subscriptions ? [stateFile] : [path.join(this.runtimeDirectory, "config.yaml"), path.join(this.root, ".env")]),
        ...(dns ? [...dns.files, sourceFile] : []),
      ]);
      try {
        if (dns) await dns.apply(files);
        // DNS recovery must not depend on the native updater downloading nodes or rules.
        if (cachedDns) await applySubscriptionDns(this.configPath, sourceFile, cachedDns.dns);
        else await this.run(dnsAction ? "update" : action);
        const generated = await readClashDocument(this.configPath);
        if (followDns) verifySubscriptionDns(cachedDns ? { dns: cachedDns.dns } : await readClashDocument(sourceFile), generated);
        if (action === "restore-dns") await verifyRestoredDns(this.root, this.runtimeDirectory, legacy, generated);
        if (beforeSources) {
          const after = await readClashDocument(stateFile);
          if (after.active !== beforeSources.active || canonical(after.sources) !== canonical(beforeSources.sources)) throw new Error("更新意外改变了订阅列表。");
        }
        if (action === "update") {
          try { await this.dnsCache.remember((await readClashDocument(sourceFile)).dns); }
          catch { /* Optional caching must not turn a successful native update into a failure. */ }
        }
        if (action === "start" || wasRunning) {
          await loadAndVerifyClashConfig(connection, this.configPath);
          if (previous) await restoreClashSelections(connection, previous);
          if (dnsAction) await new ClashApiClient(connection).flushDnsCache();
          return { running: true, ...(dnsAction && dns ? { dns: { mode: action === "restore-dns" ? "local" as const : "subscription" as const,
            backupDirectory: dns.backupDirectory, web: await this.webProbe(generated),
            ...(cachedDns ? { fromCache: cachedDns.fromCache, downloadedAt: cachedDns.downloadedAt } : {}) } } : {}) };
        }
        // Preserve a stopped service while allowing its subscription to update.
        if (await controllerListening(connection.controller)) await this.run("stop");
        await waitClashStopped(connection);
        return { running: false, ...(dnsAction && dns ? { dns: { mode: action === "restore-dns" ? "local" as const : "subscription" as const,
          backupDirectory: dns.backupDirectory, web: { status: "skipped" as const, detail: "代理保持关闭，未检测网页。" },
          ...(cachedDns ? { fromCache: cachedDns.fromCache, downloadedAt: cachedDns.downloadedAt } : {}) } } : {}) };
      } catch (error) {
        let restored = false;
        try {
          await restoreClashFiles(files);
          if (wasRunning) {
            if (!await controllerListening(connection.controller)) await this.run("start");
            // Starting can regenerate files; restore again before loading the snapshot.
            await restoreClashFiles(files);
            await loadAndVerifyClashConfig(connection, this.configPath);
            if (previous) await restoreClashSelections(connection, previous);
          } else {
            if (await controllerListening(connection.controller)) await this.run("stop");
            await waitClashStopped(connection);
          }
          restored = true;
        } catch { /* Never surface command output or configuration credentials. */ }
        const reason = error instanceof Error && /^(?:DNS |Clash |clash-for-linux |更新意外|无法解析 Clash)/.test(error.message) && !/[\r\n]|https?:\/\//i.test(error.message)
          ? " 原因：" + error.message : "";
        throw new Error((restored
          ? "Clash 操作失败，已恢复原配置、节点选择和运行状态。"
          : "Clash 操作失败，自动恢复未完成，请检查原生 Clash 状态。") + reason + (dns ? ` DNS 备份：${dns.backupDirectory}` : ""));
      }
    });
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

export async function discoverClashControl(configPath: string, installDirectory = "", home = os.homedir()): Promise<ClashControl> {
  if (process.platform === "win32") throw new Error("代理开关和订阅更新需要在 Linux/WSL 的 Clash 安装环境中执行。");
  const legacyRoot = path.basename(path.dirname(configPath)) === "resources" ? path.dirname(path.dirname(configPath)) : "";
  if (legacyRoot) {
    const root = installDirectory.trim() ? path.resolve(installDirectory.replace(/^~(?=\/|$)/, home)) : legacyRoot;
    if (await fs.realpath(root) !== await fs.realpath(legacyRoot)) throw new Error("指定安装目录与运行配置不一致。");
    for (const rel of ["scripts/cmd/clashctl.sh", "scripts/cmd/common.sh", "bin/yq", ".env"]) {
      if (!(await fs.stat(path.join(root, rel))).isFile()) throw new Error("旧版 Clash 安装不完整。");
    }
    return new ClashControl(root, path.dirname(configPath), configPath, (action) => runClashBash(root, ["-c", LEGACY_SCRIPT, "agent-center", root, configPath, action]));
  }
  const manager = await discoverClashSubscriptions(configPath, installDirectory, home);
  return new ClashControl(manager.root, manager.runtimeDirectory, configPath || path.join(manager.runtimeDirectory, "config.yaml"),
    (action) => runSubscriptionCommand(manager.root, action, "", undefined, manager.runtimeDirectory), manager);
}

const LEGACY_SCRIPT = [
  "set -eo pipefail",
  'source "$1/scripts/cmd/clashctl.sh" || true',
  'declare -F clashon clashoff clashsub >/dev/null || exit 65',
  '[ "$CLASH_CONFIG_RUNTIME" -ef "$2" ] || exit 65',
  'case "$3" in',
  'start) clashon ;;',
  'stop) clashoff ;;',
  'update) clashsub update ;;',
  '*) exit 64 ;;',
  'esac',
].join("\n");

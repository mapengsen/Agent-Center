import * as vscode from "vscode";
import * as path from "node:path";
import { ClashApiClient, findActiveGroup, resolveProxyChain } from "./clashApi";
import { CLASH_TEST_URL, loadClashConnection, type ClashSettings } from "./clashConfig";
import { clashTooltip, clashControlLinks, commandLink, escapeMarkdown, formatClashDelay, nodeDelayText, type ClashSnapshot } from "./clashPresentation";
import { discoverClashSubscriptions, validateSubscriptionUrl } from "./clashSubscriptions";
import { discoverClashControl, type ClashControlAction } from "./clashControl";
import { controllerListening } from "./clashRuntime";
import { subscriptionDnsEnabled } from "./clashDns";
import type { ClashWebProbe } from "./clashWebProbe";
import { clashNodeNames, clashNodeTestContext, testClashNodes, type ClashNodeTests } from "./clashNodeTests";
import type { NetworkStatusPresentation } from "./networkStatus";

interface NodeSelection { group: string; node: string }
interface Pick { label: string; description?: string; detail?: string; value: string }

export class ClashStatusMonitor implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private snapshot: ClashSnapshot | undefined;
  private generation = 0;
  private disposed = false;
  private choosing = false;
  private lastError = "";
  private connectionFound = false;
  private noActiveSubscription = false;
  private proxyStopped = false;
  private configPath = "";
  private controller = "";
  private networkStatus: NetworkStatusPresentation | undefined;
  private clashView: { text: string; tooltip: string; warning: boolean } | undefined;
  private dnsVerification: { checkedAt: string; result: ClashWebProbe; backupDirectory: string } | undefined;
  private nodeTests: (ClashNodeTests & { context: string }) | undefined;
  private nodeTestAbort: AbortController | undefined;
  private nodeTestPending: Promise<void> | undefined;

  public constructor() {
    this.statusBar = vscode.window.createStatusBarItem("agentStatus.clash", vscode.StatusBarAlignment.Right, 70);
    this.statusBar.name = "Agent Center: Google connectivity and Clash latency";
    // Clicking focuses this status-bar entry; VS Code shows its existing hover.
    this.statusBar.command = "workbench.action.showHover";
    this.statusBar.text = "$(globe) Clash --";
  }

  public start(): void { this.reloadConfiguration(); }

  public setNetworkStatus(status: NetworkStatusPresentation | undefined): void {
    if (this.disposed) return;
    this.networkStatus = status;
    this.renderStatus();
  }

  public refresh(trigger: "automatic" | "manual" = "automatic"): Promise<void> {
    if (this.disposed || !enabled() || !vscode.workspace.isTrusted || this.choosing) return Promise.resolve();
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.pending = this.update(trigger, generation).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async update(trigger: "automatic" | "manual", generation: number): Promise<void> {
    const settings = readSettings();
    let discovered = false;
    if (trigger === "manual") {
      this.showClashStatus("$(sync~spin) Google 测速中…", this.clashView?.tooltip ?? "正在检测 Clash 节点延迟…");
    }
    try {
      const connection = await loadClashConnection(settings);
      discovered = Boolean(connection.configPath || settings.controller || settings.secret);
      let subscription: string | undefined;
      this.noActiveSubscription = false;
      try {
        const list = await (await discoverClashSubscriptions(connection.configPath, settings.installDirectory)).list();
        if (!this.active(generation)) return;
        if (!list.active) {
          this.nodeTests = undefined;
          this.noActiveSubscription = true;
          this.snapshot = undefined;
          this.lastError = "";
          this.connectionFound = true;
          this.controller = connection.controller;
          this.configPath = connection.configPath;
          this.showClashStatus("$(globe) Clash 已停止", "**Clash 已停止**\n\n暂无活动订阅，添加或切换订阅后可重新启动。\n\n" + clashControlLinks() + "\n\n" +
            commandLink("添加订阅", "agentStatus.addClashSubscription") + " · " +
            commandLink("切换订阅", "agentStatus.chooseClashSubscription") + " · " +
            commandLink("删除订阅", "agentStatus.removeClashSubscription"));
          return;
        }
        const source = list.sources.find((item) => item.name === list.active);
        subscription = source?.displayName && source.displayName !== list.active
          ? source.displayName + "（" + list.active + "）" : list.active;
      }
      catch { /* Node monitoring also works without clash-for-linux. */ }
      const api = new ClashApiClient(connection);
      const state = await api.getState();
      const group = findActiveGroup(state, settings.group, connection.preferredGroups);
      const chain = resolveProxyChain(state.proxies, group);
      // Match clashtest: test the selected entry, which may itself be an automatic group.
      const delay = await api.testDelay(state.proxies[group]?.now ?? group, CLASH_TEST_URL, settings.testTimeoutMs);
      if (!this.active(generation)) return;
      this.connectionFound = true;
      this.controller = connection.controller;
      this.configPath = connection.configPath;
      this.lastError = "";
      this.proxyStopped = false;
      const subscriptionDns = connection.configPath ? await subscriptionDnsEnabled(path.dirname(connection.configPath)) : false;
      if (!this.active(generation)) return;
      this.snapshot = { state, group, chain, delay, subscription, updatedAt: new Date(), subscriptionDns,
        dnsWebVerification: this.dnsVerification ? this.dnsVerification.result.detail + "（" + this.dnsVerification.checkedAt + "）" : undefined };
      if (this.nodeTests?.context !== clashNodeTestContext(connection.controller, connection.configPath, subscription, state.proxies)) this.nodeTests = undefined;
      this.renderSnapshot();
    } catch (error) {
      if (!this.active(generation)) return;
      this.lastError = message(error);
      if (discovered) {
        try {
          const connection = await loadClashConnection(settings);
          if (!this.active(generation)) return;
          if (!await controllerListening(connection.controller)) {
            if (!this.active(generation)) return;
            this.proxyStopped = true;
            this.snapshot = undefined;
            this.connectionFound = true;
            this.configPath = connection.configPath;
            this.controller = connection.controller;
            this.renderStopped();
            return;
          }
        } catch { /* Unreachable and stopped are different states. */ }
      }
      // Windows without Clash retry quietly, in case the service is started later.
      if (!discovered && !this.connectionFound && !settings.configPath && trigger === "automatic") this.hideClashStatus();
      else this.renderError();
    }
  }

  public testAllNodes(): Promise<void> {
    if (this.nodeTestPending) return this.nodeTestPending;
    if (this.disposed || !enabled() || !vscode.workspace.isTrusted || this.choosing) return Promise.resolve();
    this.choosing = true;
    const controller = new AbortController();
    this.nodeTestAbort = controller;
    this.nodeTestPending = this.runNodeTests(this.generation, controller).finally(() => {
      this.nodeTestPending = undefined;
      this.nodeTestAbort = undefined;
      this.choosing = false;
    });
    return this.nodeTestPending;
  }

  public cancelNodeTests(): void { this.nodeTestAbort?.abort(); }

  private async runNodeTests(generation: number, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    try {
      await this.pending;
      if (!this.active(generation) || signal.aborted) return;
      if (!this.snapshot) await this.update("automatic", generation);
      if (!this.active(generation) || signal.aborted) return;
      if (!this.snapshot || this.proxyStopped || this.noActiveSubscription) throw new Error("请先开启并连接 Clash 后再测速。");
      const settings = readSettings();
      const connection = await loadClashConnection(settings);
      const api = new ClashApiClient(connection);
      const state = await api.getState();
      if (!this.active(generation) || signal.aborted) return;
      const nodes = clashNodeNames(state.proxies);
      if (!nodes.length) { void vscode.window.showInformationMessage("当前 Clash 没有已加载的代理节点可测速。"); return; }
      const tests: ClashNodeTests & { context: string } = { total: nodes.length, results: [], startedAt: new Date(), running: true, cancelled: false,
        context: clashNodeTestContext(connection.controller, connection.configPath, this.snapshot.subscription, state.proxies) };
      this.nodeTests = tests;
      this.renderSnapshot();
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Clash：全部节点测速", cancellable: true }, async (progress, token) => {
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          if (token.isCancellationRequested) controller.abort();
          await testClashNodes(api, nodes, CLASH_TEST_URL, settings.testTimeoutMs, signal, (result) => {
            if (!this.active(generation)) { controller.abort(); return; }
            if (signal.aborted) return;
            tests.results.push(result);
            progress.report({ increment: 100 / nodes.length, message: tests.results.length + "/" + nodes.length });
            this.renderSnapshot();
          });
        } finally { cancellation.dispose(); }
      });
      if (!this.active(generation)) return;
      tests.running = false;
      tests.cancelled = signal.aborted;
      tests.finishedAt = new Date();
      if (!signal.aborted) {
        const latest = await api.getState();
        if (!this.active(generation)) return;
        if (tests.context !== clashNodeTestContext(connection.controller, connection.configPath, this.snapshot?.subscription, latest.proxies)) {
          this.nodeTests = undefined;
          this.renderSnapshot();
          void vscode.window.showWarningMessage("Clash 节点列表在测速期间发生变化，请重新测速。");
          return;
        }
      }
      this.renderSnapshot();
      const good = tests.results.filter((result) => result.delay.ok).length;
      void vscode.window.showInformationMessage(tests.cancelled
        ? "Clash 全部节点测速已取消，已完成 " + tests.results.length + "/" + tests.total + "。"
        : "Clash 全部节点测速完成：" + good + " 个可用，" + (tests.total - good) + " 个超时。结果已显示在右下角悬浮卡片。");
    } catch (error) {
      controller.abort();
      if (!this.active(generation)) return;
      this.nodeTests = undefined;
      this.renderSnapshot();
      void vscode.window.showErrorMessage("Clash 全部节点测速失败：" + message(error));
    }
  }

  public async manageControl(action: ClashControlAction): Promise<void> {
    if (this.disposed || !enabled() || !vscode.workspace.isTrusted || this.choosing) return;
    this.choosing = true;
    const generation = this.generation;
    let attempted = false;
    try {
      await this.pending;
      if (!this.active(generation)) return;
      const settings = readSettings();
      const connection = await loadClashConnection({ ...settings, configPath: settings.configPath || this.configPath });
      const control = await discoverClashControl(connection.configPath, settings.installDirectory);
      if (!this.active(generation)) return;
      const title = { start: "开启代理", stop: "关闭代理", update: "更新当前订阅", "subscription-dns": "让 DNS 使用订阅配置", "restore-dns": "恢复原 DNS 覆写" }[action];
      attempted = true;
      this.nodeTests = undefined;
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Clash：正在" + title + "…" },
        () => control.execute(action, connection),
      );
      if (!this.active(generation)) return;
      this.proxyStopped = !result.running;
      this.lastError = "";
      this.snapshot = undefined;
      this.connectionFound = true;
      this.configPath = control.configPath;
      this.controller = connection.controller;
      if (!result.running) this.renderStopped();
      if (result.dns) {
        this.dnsVerification = { checkedAt: new Date().toLocaleString(), result: result.dns.web, backupDirectory: result.dns.backupDirectory };
        const text = (result.dns.mode === "subscription" ? "DNS 已使用订阅配置并核验。" : "原 DNS 覆写已恢复。") + result.dns.web.detail + " 备份：" + result.dns.backupDirectory;
        if (result.dns.web.status === "failed") void vscode.window.showWarningMessage(text);
        else void vscode.window.showInformationMessage(text);
      } else void vscode.window.showInformationMessage(action === "update"
        ? "Clash 当前订阅已更新" + (result.running ? "并加载生效。" : "，代理保持关闭。")
        : action === "start" ? "Clash 代理已开启。" : "Clash 代理已关闭。");
    } catch (error) {
      if (this.active(generation)) void vscode.window.showErrorMessage("Clash 操作失败：" + message(error));
    } finally {
      this.choosing = false;
      if (attempted && this.active(generation)) await this.refresh();
    }
  }

  public async chooseNode(argument?: unknown): Promise<void> {
    if (this.disposed || !enabled() || !vscode.workspace.isTrusted || this.choosing) return;
    this.choosing = true;
    const generation = this.generation;
    let changed = false;
    try {
      await this.pending;
      if (!this.active(generation)) return;
      const settings = readSettings();
      const connection = await loadClashConnection(settings);
      const api = new ClashApiClient(connection);
      const state = await api.getState();
      let selection: NodeSelection;
      if (argument !== undefined) {
        if (!isSelection(argument)) throw new Error("节点选择参数无效。");
        selection = argument;
      } else {
        const active = findActiveGroup(state, settings.group, connection.preferredGroups);
        if (state.mode === "direct") throw new Error("当前是直连模式，请先在 Clash 中切换为规则或全局模式。");
        let group = active;
        if (state.proxies[group]?.type !== "Selector") {
          const selectors = Object.keys(state.proxies)
            .filter((name) => name !== "GLOBAL" && state.proxies[name].type === "Selector");
          const selected = await vscode.window.showQuickPick<Pick>(selectors.map((name) => ({
            label: name, value: name, description: state.proxies[name].now,
          })), { placeHolder: "当前组自动选择节点，请选择要手动切换的策略组" });
          if (!selected) return;
          group = selected.value;
        }
        const proxy = state.proxies[group];
        const selected = await vscode.window.showQuickPick<Pick>((proxy?.all ?? []).map((name) => ({
          label: name,
          value: name,
          description: (name === proxy.now ? "✓ 当前选择" : "") + nodeDelayText(this.nodeTests, name),
          detail: resolveProxyChain(state.proxies, name).join(" → "),
        })), { placeHolder: "选择 " + group + " 的节点", matchOnDetail: true });
        if (!selected) return;
        selection = { group, node: selected.value };
      }
      if (!this.active(generation)) return;
      // Re-read after the picker: subscriptions and routing mode can change meanwhile.
      const latest = await api.getState();
      if (!this.active(generation)) return;
      if (latest.mode === "direct") throw new Error("当前为直连模式，未切换节点。");
      const proxy = latest.proxies[selection.group];
      if (proxy?.type !== "Selector" || !proxy.all?.includes(selection.node)) {
        throw new Error("节点不在可切换策略组中，请刷新后重试。");
      }
      if (proxy.now !== selection.node) {
        await api.select(selection.group, selection.node);
        changed = true;
        const verified = await api.getProxies();
        if (verified[selection.group]?.now !== selection.node) throw new Error("Clash 未确认切换结果，请刷新检查。");
      }
      if (this.active(generation)) {
        this.lastError = "";
        if (changed) void vscode.window.showInformationMessage("Clash 已切换到：" + selection.node);
      }
    } catch (error) {
      if (!this.active(generation)) return;
      this.lastError = message(error);
      this.renderError();
      void vscode.window.showErrorMessage("Clash 操作失败：" + this.lastError);
    } finally {
      this.choosing = false;
      if (changed && this.active(generation)) await this.refresh();
    }
  }

  public async manageSubscriptions(action: "add" | "choose" | "remove"): Promise<void> {
    if (this.disposed || !enabled() || !vscode.workspace.isTrusted || this.choosing) return;
    this.choosing = true;
    const generation = this.generation;
    let attempted = false;
    try {
      await this.pending;
      if (!this.active(generation)) return;
      const settings = readSettings();
      const connection = await loadClashConnection(settings);
      const manager = await discoverClashSubscriptions(connection.configPath, settings.installDirectory);
      const list = action === "choose" || action === "remove"
        ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Clash：正在读取订阅名称…" },
          () => manager.list({ resolveNames: true }))
        : await manager.list();
      if (!this.active(generation)) return;
      if (action !== "add" && !list.sources.length) {
        void vscode.window.showInformationMessage("暂无订阅，请先添加订阅。");
        return;
      }
      if (action === "choose") {
        const selected = await vscode.window.showQuickPick<Pick>(list.sources.map((source) => ({
          label: source.displayName || source.name, value: source.name,
          description: source.name === list.active ? "✓ 当前订阅" : source.enabled ? undefined : "已禁用",
          detail: ["标识：" + source.name, source.hostname, "类型：" + source.type].filter(Boolean).join(" · "),
        })), { placeHolder: "选择订阅并应用到当前远程 Clash", matchOnDetail: true });
        if (!selected || !this.active(generation)) return;
        attempted = true;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Clash：正在切换订阅…" },
          () => manager.use(selected.value, connection));
        if (this.active(generation)) void vscode.window.showInformationMessage("Clash 当前订阅：" + selected.label);
      } else if (action === "remove") {
        const selected = await vscode.window.showQuickPick<Pick>(list.sources.map((source) => ({
          label: source.displayName || source.name, value: source.name,
          description: source.name === list.active ? "✓ 当前订阅（删除后自动切换）" : undefined,
          detail: ["标识：" + source.name, source.hostname, "类型：" + source.type].filter(Boolean).join(" · "),
        })), { placeHolder: "选择要删除的 Clash 订阅", matchOnDetail: true });
        if (!selected || !this.active(generation)) return;
        const index = list.sources.findIndex((source) => source.name === selected.value);
        const next = [...list.sources.slice(index + 1), ...list.sources.slice(0, index)].find((source) => source.enabled);
        const consequence = selected.value === list.active || !list.active
          ? next ? "将自动切换到“" + next.displayName + "”。" : "没有其他可用订阅，Clash 服务将停止。"
          : "当前使用的订阅保持不变。";
        const confirmed = await vscode.window.showWarningMessage(
          "确认删除 Clash 订阅“" + selected.label + "”？" + consequence + "此操作不可撤销。",
          { modal: true }, "删除订阅",
        );
        if (confirmed !== "删除订阅" || !this.active(generation)) return;
        attempted = true;
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Clash：正在删除订阅…" },
          () => manager.remove(selected.value, connection));
        if (this.active(generation)) void vscode.window.showInformationMessage("Clash 已删除订阅：" + selected.label +
          (result.stopped ? "，没有活动订阅，Clash 已停止。" : "，当前订阅：" + result.active));
      } else {
        const url = await vscode.window.showInputBox({
          title: "添加 Clash 订阅", prompt: "粘贴 HTTP/HTTPS Clash YAML 订阅链接，自动识别订阅名称", password: true, ignoreFocusOut: true,
          validateInput: (value) => { try { validateSubscriptionUrl(value); return undefined; } catch (error) { return message(error); } },
        });
        if (!url || !this.active(generation)) return;
        const name = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Clash：正在识别订阅名称…" },
          () => manager.suggestName(url),
        );
        if (!this.active(generation)) return;
        const mode = await vscode.window.showQuickPick<Pick>([
          { label: "保存订阅，保留当前连接", value: "save", detail: "订阅名称：" + name + " · 切换时才下载并应用配置" },
          { label: "保存并立即切换", value: "use", detail: "订阅名称：" + name + " · 下载订阅并应用配置" },
        ], { placeHolder: "已识别订阅：" + name });
        if (!mode || !this.active(generation)) return;
        attempted = true;
        let savedName = name;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Clash：正在添加订阅…" }, async () => {
          savedName = await manager.add(name, url, { uniqueName: true });
          if (mode.value === "use") await manager.use(savedName, connection);
        });
        if (this.active(generation)) void vscode.window.showInformationMessage(
          mode.value === "use" ? "Clash 已切换到订阅：" + savedName : "Clash 已保存订阅：" + savedName + "，当前连接保持原订阅。",
        );
      }
    } catch (error) {
      if (this.active(generation)) void vscode.window.showErrorMessage("Clash 订阅操作失败：" + message(error));
    } finally {
      this.choosing = false;
      if (attempted) this.nodeTests = undefined;
      if (attempted && this.active(generation)) await this.refresh();
    }
  }

  public reloadConfiguration(): void {
    this.cancelNodeTests();
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.snapshot = undefined;
    this.nodeTests = undefined;
    this.connectionFound = false;
    this.noActiveSubscription = false;
    this.controller = "";
    this.configPath = "";
    this.lastError = "";
    this.hideClashStatus();
    const generation = this.generation;
    if (!this.active(generation)) return;
    // Wait out the previous configuration's request before starting its replacement.
    void (async () => {
      await this.pending;
      await this.nodeTestPending;
      if (!this.active(generation)) return;
      await this.refresh();
      this.schedule(generation);
    })();
  }

  public getDiagnostics(): Record<string, unknown> {
    return {
      enabled: enabled(), trusted: vscode.workspace.isTrusted,
      extensionHost: vscode.env.remoteName ?? "local",
      controller: this.controller, configPath: this.configPath,
      dnsVerification: this.dnsVerification,
      nodeTests: this.nodeTests,
      group: this.snapshot?.group, mode: this.snapshot?.state.mode,
      chain: this.snapshot?.chain, delay: this.snapshot?.delay,
      subscription: this.snapshot?.subscription,
      proxyStopped: this.proxyStopped,
      updatedAt: this.snapshot?.updatedAt.toISOString(), lastError: this.lastError,
    };
  }

  public dispose(): void {
    this.cancelNodeTests();
    this.disposed = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.statusBar.dispose();
  }

  private active(generation: number): boolean {
    return !this.disposed && generation === this.generation && enabled() && vscode.workspace.isTrusted;
  }

  private schedule(generation: number): void {
    if (!this.active(generation)) return;
    this.timer = setTimeout(() => {
      if (!this.active(generation)) return;
      void this.refresh().finally(() => this.schedule(generation));
    }, readSettings().updateIntervalSeconds * 1000);
  }

  private renderSnapshot(): void {
    if (!this.snapshot) return;
    this.showClashStatus("$(globe) " + formatClashDelay(this.snapshot.delay), clashTooltip({ ...this.snapshot, nodeTests: this.nodeTests }), !this.snapshot.delay.ok);
  }

  private renderError(): void {
    this.showClashStatus("$(globe) Clash 未连接", "**Clash 暂不可用**\n\n" + escapeMarkdown(this.lastError) + "\n\n" +
      commandLink("重试测速", "agentStatus.refreshClash") + " · " + commandLink("设置", "agentStatus.openSettings") + "\n\n" +
      commandLink("切换订阅", "agentStatus.chooseClashSubscription") + " · " + commandLink("添加订阅", "agentStatus.addClashSubscription") + " · " +
      commandLink("删除订阅", "agentStatus.removeClashSubscription") + "\n\n" + clashControlLinks(), true);
  }

  private renderStopped(): void {
    this.nodeTests = undefined;
    this.showClashStatus("$(globe) Clash 已关闭", "**Clash 代理已关闭**\n\n" +
      "订阅配置已保留，可点击开启代理。\n\n" + clashControlLinks() + "\n\n" +
      commandLink("添加订阅", "agentStatus.addClashSubscription") + " · " +
      commandLink("切换订阅", "agentStatus.chooseClashSubscription") + " · " +
      commandLink("删除订阅", "agentStatus.removeClashSubscription"));
  }

  private showClashStatus(text: string, tooltip: string, warning = false): void {
    this.clashView = { text, tooltip, warning };
    this.renderStatus();
  }

  private hideClashStatus(): void {
    this.clashView = undefined;
    this.renderStatus();
  }

  private renderStatus(): void {
    if (this.disposed) return;
    const clash = enabled() ? this.clashView : undefined;
    const network = this.networkStatus;
    if (!vscode.workspace.isTrusted || (!clash && !network)) {
      this.statusBar.hide();
      return;
    }
    this.statusBar.text = [network?.icon, clash?.text].filter(Boolean).join(" ");
    this.statusBar.color = clash?.warning || network?.icon === "❌" ? new vscode.ThemeColor("editorWarning.foreground") : undefined;
    this.statusBar.tooltip = trustedMarkdown([network?.tooltip, clash?.tooltip].filter(Boolean).join("\n\n---\n\n"));
    this.statusBar.show();
  }
}

function trustedMarkdown(value: string): vscode.MarkdownString {
  const result = new vscode.MarkdownString(value);
  result.isTrusted = { enabledCommands: ["agentStatus.chooseClashNode", "agentStatus.refreshClash", "agentStatus.refreshNetwork", "agentStatus.openSettings",
    "agentStatus.chooseClashSubscription", "agentStatus.addClashSubscription", "agentStatus.removeClashSubscription",
    "agentStatus.startClash", "agentStatus.stopClash", "agentStatus.updateClashSubscription", "agentStatus.useSubscriptionDns", "agentStatus.restoreClashDns",
    "agentStatus.testAllClashNodes", "agentStatus.cancelClashNodeTests"] };
  return result;
}

function isSelection(value: unknown): value is NodeSelection {
  return Boolean(value && typeof value === "object" &&
    typeof (value as NodeSelection).group === "string" && typeof (value as NodeSelection).node === "string");
}
function enabled(): boolean { return vscode.workspace.getConfiguration("agentStatus.clash").get("enabled", true); }
function readSettings(): ClashSettings {
  const config = vscode.workspace.getConfiguration("agentStatus.clash");
  return {
    controller: config.get("controller", "").trim(), secret: config.get("secret", ""),
    configPath: config.get("configPath", "").trim(), group: config.get("group", "").trim(),
    installDirectory: config.get("installDirectory", "").trim(),
    testTimeoutMs: clamp(config.get("testTimeoutMs", 8000), 1000, 30000, 8000),
    updateIntervalSeconds: clamp(config.get("updateIntervalSeconds", 300), 30, 3600, 300),
  };
}
function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

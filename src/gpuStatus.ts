import * as vscode from "vscode";
import { readNvidiaSmi, type NvidiaSmiResult } from "./nvidiaSmi";
import { CpuUsageSampler, type CpuReader, type CpuUsage } from "./cpuUsage";
import { commandLink, escapeMarkdown } from "./clashPresentation";
import { gpuServerSignature, type GpuServer } from "./gpuServerConfig";
import type { GpuServerCatalog } from "./gpuServerCatalog";
import type { RemoteGpuReader, GpuServerProbe } from "./gpuSsh";

const INTERVAL_MS = 2000;

export class GpuStatusMonitor implements vscode.Disposable {
  private readonly bar: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private pendingGeneration = -1;
  private abort: AbortController | undefined;
  private generation = 0;
  private disposed = false;
  private watching = false;
  private result: NvidiaSmiResult | undefined;
  private cpu: CpuUsage | undefined;
  private updatedAt: Date | undefined;
  private selected: GpuServer | undefined;
  private readonly catalogSubscription: vscode.Disposable | undefined;
  private readonly connections = new Map<string, { ok: boolean; signature: string; order: number }>();
  private connectionOrder = 0;
  private probeGeneration = 0;
  private probeAbort: AbortController | undefined;

  public constructor(private readonly cpuSampler: CpuReader = new CpuUsageSampler(), private readonly catalog?: GpuServerCatalog,
    private readonly remote?: RemoteGpuReader, private readonly connectivity?: GpuServerProbe) {
    this.bar = vscode.window.createStatusBarItem("agentStatus.gpu", vscode.StatusBarAlignment.Right, 69);
    this.bar.name = "Agent Center: GPU / CPU";
    this.bar.text = "$(chip) GPU";
    this.bar.command = "agentStatus.showGpuMonitor";
    this.bar.accessibilityInformation = { label: "GPU / CPU 监控，悬停查看，每 2 秒更新" };
    this.catalogSubscription = this.catalog?.onDidChange(() => this.serversChanged());
  }

  // Native status-bar hovers have no visibility event. Keep a current snapshot
  // available so hovering works without requiring a click first.
  public start(): void { this.resume(); this.render(); void this.catalog?.reload(); }

  public async reloadServers(): Promise<void> {
    if (!this.active(this.generation)) return;
    const probeGeneration = this.probeGeneration;
    await this.catalog?.reload();
    if (probeGeneration === this.probeGeneration) await this.checkServers();
  }

  public selectServer(value: unknown): void {
    if (!this.active(this.generation) || typeof value !== "string") return;
    const server = value === "local" ? undefined : this.catalog?.servers.find(entry => entry.id === value);
    if (value !== "local" && (!server || !this.remote)) return;
    if (this.selected?.id === server?.id) { this.resume(); return; }
    this.pause(); this.selected = server;
    this.result = undefined; this.cpu = undefined; this.updatedAt = undefined;
    this.resume();
  }

  private serversChanged(): void {
    if (this.disposed) return;
    if (this.selected) {
      const updated = this.catalog?.servers.find(server => server.id === this.selected!.id);
      if (!updated || gpuServerSignature(updated) !== gpuServerSignature(this.selected)) {
        const watching = this.watching;
        this.pause(); this.selected = updated;
        this.result = undefined; this.cpu = undefined; this.updatedAt = undefined;
        if (watching) this.resume();
      }
    }
    void this.checkServers();
    this.render();
  }

  private markConnection(server: GpuServer, ok: boolean, order: number): void {
    const signature = gpuServerSignature(server);
    if (!this.catalog?.servers.some(entry => entry.id === server.id && gpuServerSignature(entry) === signature)) return;
    if ((this.connections.get(server.id)?.order ?? -1) > order) return;
    this.connections.set(server.id, { ok, signature, order });
  }

  private async checkServers(): Promise<void> {
    this.probeAbort?.abort();
    const generation = ++this.probeGeneration;
    const servers = [...this.catalog?.servers ?? []];
    for (const [id, state] of this.connections) {
      if (!servers.some(server => server.id === id && gpuServerSignature(server) === state.signature)) this.connections.delete(id);
    }
    if (!this.active(this.generation) || !this.connectivity || !servers.length) return;
    const controller = this.probeAbort = new AbortController();
    let next = 0;
    const worker = async () => {
      while (!controller.signal.aborted && next < servers.length) {
        const server = servers[next++], order = ++this.connectionOrder;
        const ok = await this.connectivity!.check(server, controller.signal).catch(() => false);
        if (controller.signal.aborted || generation !== this.probeGeneration || !this.active(this.generation)) return;
        this.markConnection(server, ok, order); this.render();
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, servers.length) }, worker));
    if (this.probeAbort === controller) this.probeAbort = undefined;
  }

  public async show(): Promise<void> {
    if (!this.active(this.generation)) return;
    this.resume();
    await vscode.commands.executeCommand("workbench.action.showHover");
  }

  private resume(): void {
    if (!this.active(this.generation) || this.watching) return;
    this.cpuSampler.reset();
    this.watching = true;
    this.render();
    void this.refresh();
  }

  public refresh(): Promise<void> {
    if (!this.active(this.generation)) return Promise.resolve();
    if (this.pending) {
      if (this.pendingGeneration === this.generation) return this.pending;
      const generation = this.generation;
      return this.pending.then(() => { if (this.active(generation)) return this.refresh(); });
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const generation = this.generation;
    this.pendingGeneration = generation;
    const controller = new AbortController();
    this.abort = controller;
    this.pending = (async () => {
      let result: NvidiaSmiResult, cpu: CpuUsage;
      const server = this.selected, order = ++this.connectionOrder;
      let connected: boolean | undefined;
      if (this.selected && this.remote) {
        try { const sample = await this.remote.read(this.selected, controller.signal); result = sample.gpu; cpu = sample.cpu; connected = sample.connected ?? sample.gpu.ok; }
        catch { result = { ok: false, output: "", detail: "无法读取远程 GPU/CPU 状态。" }; cpu = { state: "unavailable", logicalCores: 0 }; connected = false; }
      } else {
        try { result = await readNvidiaSmi(vscode.workspace.getConfiguration("agentStatus.gpu").get<string>("nvidiaSmiPath", ""), controller.signal); }
        catch { result = { ok: false, output: "", detail: "无法读取 nvidia-smi，监控已暂停。" }; }
        if (!this.active(generation) || controller.signal.aborted) return;
        // Preserve child-exit ordering when pause/resume races an in-flight read.
        cpu = await this.cpuSampler.read(controller.signal).catch((): CpuUsage => ({ state: "unavailable", logicalCores: 0 }));
      }
      if (!this.active(generation) || controller.signal.aborted) return;
      if (server && connected !== undefined) this.markConnection(server, connected, order);
      this.result = result;
      this.cpu = cpu;
      this.updatedAt = new Date();
      if (!result.ok) { this.watching = false; this.remote?.reset(); }
      this.render();
    })().finally(() => {
      this.pending = undefined;
      this.abort = undefined;
      if (this.active(generation) && this.watching) this.timer = setTimeout(() => { void this.refresh(); }, INTERVAL_MS);
    });
    return this.pending;
  }

  public pause(): void {
    this.watching = false;
    this.generation++;
    this.cpuSampler.reset();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.remote?.reset();
    this.render();
  }

  public reloadConfiguration(): void {
    this.pause();
    this.result = undefined;
    this.cpu = undefined;
    this.updatedAt = undefined;
    this.start();
  }

  public getDiagnostics(): Record<string, unknown> {
    return { enabled: enabled(), trusted: vscode.workspace.isTrusted, extensionHost: vscode.env.remoteName ?? "local",
      watching: this.watching, pending: Boolean(this.pending), presentation: "native-hover",
      serverCount: this.catalog?.servers.length ?? 0, selectedServerId: this.selected?.id ?? "local",
      unreachableServers: [...this.connections.values()].filter(state => !state.ok).length,
      ok: this.result?.ok, detail: this.result?.detail, cpu: this.cpu, updatedAt: this.updatedAt?.toISOString(), intervalSeconds: INTERVAL_MS / 1000 };
  }

  public dispose(): void {
    this.disposed = true; this.probeAbort?.abort(); this.probeGeneration++;
    this.pause(); this.catalogSubscription?.dispose(); this.catalog?.dispose(); this.remote?.dispose(); this.connectivity?.dispose(); this.bar.dispose();
  }

  private active(generation: number): boolean {
    return !this.disposed && generation === this.generation && enabled() && vscode.workspace.isTrusted;
  }

  private render(): void {
    if (!this.active(this.generation)) { if (!this.disposed) this.bar.hide(); return; }
    const lines: string[] = [];
    if (this.catalog) {
      const button = (id: string, name: string, unreachable = false) => {
        const status = unreachable ? '<span style="color:#f14c4c;">(不能连接)</span>' : "";
        // Keep only the fixed failure marker as HTML; escape server names and
        // encode the opaque ID so the whole label remains a safe retry link.
        const label = "[\\[ " + escapeMarkdown(name) + status + " \\]](command:agentStatus.selectGpuServer?" +
          encodeURIComponent(JSON.stringify([id])) + ")";
        return (this.selected?.id ?? "local") === id ? "**✓ " + label + "**" : label;
      };
      lines.push([button("local", "当前机器"), ...this.catalog.servers.map(server =>
        button(server.id, server.name, this.connections.get(server.id)?.ok === false)),
        commandLink("重读服务器列表", "agentStatus.reloadGpuServers")].join("　"));
    }
    if (this.catalog?.detail) lines.push(escapeMarkdown(this.catalog.detail));
    const cpu = this.cpu;
    if (cpu?.state === "ready" && [cpu.totalPercent, cpu.coresUsed, cpu.machinePercent, cpu.logicalCores].every(Number.isFinite)) {
      lines.push('<h3><code>CPU 总占用：<span style="color:#007acc;">' + cpu.totalPercent!.toFixed(1) + "%</span></code></h3>",
        "<pre><code>约 " + cpu.coresUsed!.toFixed(2) + " 个满载逻辑核心 / " + cpu.logicalCores + " 个逻辑核心 · 全机 " + cpu.machinePercent!.toFixed(1) + "%</code></pre>");
    } else lines.push("```text\n" + (cpu ? "CPU 暂不可用" : "CPU 采样中…") + "\n```");
    if (!this.watching) lines.push("监控已暂停，保留最后一次结果。");
    lines.push((this.watching ? commandLink("暂停监控", "agentStatus.pauseGpuMonitor") : commandLink("继续 / 重试", "agentStatus.showGpuMonitor")) + " · " +
      commandLink("刷新一次", "agentStatus.refreshGpuMonitor") + " · " + commandLink("设置", "agentStatus.openSettings"));
    if (this.result && !this.result.ok) lines.push("**" + escapeMarkdown(this.result.detail) + "**");
    if (this.result?.output) {
      // Tokenize only nvidia-smi's first line (normally its timestamp) to activate
      // VS Code's wider native hover. Keep CPU details and GPU columns at the
      // compact hover font size instead of the potentially larger editor font.
      const text = this.result.output.slice(0, 64000);
      const newline = text.indexOf("\n");
      const firstLine = newline < 0 ? text : text.slice(0, newline);
      // Use a fence longer than any sampled backtick run so output stays text.
      const fence = "`".repeat(Math.max(3, ...[...firstLine.matchAll(/`+/g)].map(match => match[0].length + 1)));
      lines.push(fence + "text\n" + firstLine + "\n" + fence);
      const escaped = (newline < 0 ? "" : text.slice(newline + 1)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      if (escaped) lines.push("<pre><code>" + escaped + "</code></pre>");
      if (this.result.output.length > text.length) lines.push("输出过长，仅显示前 64000 个字符。");
    } else if (this.watching && !this.result) lines.push("正在读取 nvidia-smi…");
    const tooltip = new vscode.MarkdownString(lines.join("\n\n"));
    tooltip.supportHtml = true;
    tooltip.isTrusted = { enabledCommands: ["agentStatus.showGpuMonitor", "agentStatus.pauseGpuMonitor", "agentStatus.refreshGpuMonitor", "agentStatus.openSettings",
      "agentStatus.selectGpuServer", "agentStatus.reloadGpuServers"] };
    this.bar.tooltip = tooltip;
    this.bar.show();
  }
}

function enabled(): boolean { return vscode.workspace.getConfiguration("agentStatus.gpu").get<boolean>("enabled", true); }

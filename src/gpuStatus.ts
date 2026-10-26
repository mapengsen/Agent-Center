import * as vscode from "vscode";
import * as os from "node:os";
import { readNvidiaSmi, type NvidiaSmiResult } from "./nvidiaSmi";
import { commandLink, escapeMarkdown } from "./clashPresentation";

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
  private updatedAt: Date | undefined;

  public constructor() {
    this.bar = vscode.window.createStatusBarItem("agentStatus.gpu", vscode.StatusBarAlignment.Right, 69);
    this.bar.name = "Agent Center: NVIDIA GPU";
    this.bar.text = "$(chip) GPU";
    this.bar.command = "agentStatus.showGpuMonitor";
    this.bar.accessibilityInformation = { label: "NVIDIA GPU 监控，点击查看 nvidia-smi" };
  }

  public start(): void { this.render(); }

  /** A status-bar click keeps that entry focused for VS Code's native hover action. */
  public async show(): Promise<void> {
    if (!this.active(this.generation)) return;
    if (!this.watching) {
      this.watching = true;
      this.render();
      void this.refresh();
    }
    // Do not wait for the first command; the already-open hover updates on arrival.
    await vscode.commands.executeCommand("workbench.action.showHover");
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
      let result: NvidiaSmiResult;
      try { result = await readNvidiaSmi(vscode.workspace.getConfiguration("agentStatus.gpu").get<string>("nvidiaSmiPath", ""), controller.signal); }
      catch { result = { ok: false, output: "", detail: "无法读取 nvidia-smi，监控已暂停。" }; }
      if (!this.active(generation) || controller.signal.aborted) return;
      this.result = result;
      this.updatedAt = new Date();
      if (!result.ok) this.watching = false;
      this.render();
    })().finally(() => {
      this.pending = undefined;
      this.abort = undefined;
      if (this.active(generation) && this.watching) this.timer = setTimeout(() => { void this.refresh(); }, 1000);
    });
    return this.pending;
  }

  public pause(): void {
    this.watching = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.render();
  }

  public reloadConfiguration(): void {
    this.pause();
    this.result = undefined;
    this.updatedAt = undefined;
    this.render();
  }

  public getDiagnostics(): Record<string, unknown> {
    return { enabled: enabled(), trusted: vscode.workspace.isTrusted, extensionHost: vscode.env.remoteName ?? "local",
      watching: this.watching, pending: Boolean(this.pending), ok: this.result?.ok, detail: this.result?.detail,
      updatedAt: this.updatedAt?.toISOString(), intervalSeconds: 1 };
  }

  public dispose(): void { this.disposed = true; this.pause(); this.bar.dispose(); }

  private active(generation: number): boolean {
    return !this.disposed && generation === this.generation && enabled() && vscode.workspace.isTrusted;
  }

  private render(): void {
    if (!this.active(this.generation)) { if (!this.disposed) this.bar.hide(); return; }
    const lines = ["**NVIDIA GPU · nvidia-smi**",
      "当前机器：" + escapeMarkdown(os.hostname()) + " · " + (vscode.env.remoteName ? "远程扩展宿主（" + escapeMarkdown(vscode.env.remoteName) + "）" : "本地扩展宿主"),
      this.watching ? "每 1 秒刷新，效果相当于 `watch -n 1 nvidia-smi`。" : this.result ? "监控已暂停，保留最后一次结果。" : "点击 GPU 按钮开始每秒监控。",
    ];
    lines.push((this.watching ? commandLink("暂停监控", "agentStatus.pauseGpuMonitor") : commandLink("继续 / 重试", "agentStatus.showGpuMonitor")) + " · " +
      commandLink("刷新一次", "agentStatus.refreshGpuMonitor") + " · " + commandLink("设置", "agentStatus.openSettings"));
    if (this.updatedAt) lines.push("更新于 " + this.updatedAt.toLocaleString());
    if (this.result && !this.result.ok) lines.push("**" + escapeMarkdown(this.result.detail) + "**");
    if (this.result?.output) {
      const text = this.result.output.slice(0, 64000);
      // HTML pre preserves table columns; tokenized Markdown fences wrap in native hovers.
      // Escape every HTML metacharacter so process names stay literal, including links.
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      lines.push("<pre><code>" + escaped + "</code></pre>");
      if (this.result.output.length > text.length) lines.push("输出过长，仅显示前 64000 个字符。");
    } else if (this.watching) lines.push("正在读取 nvidia-smi…");
    if (this.watching) lines.push("关闭悬浮卡片后继续刷新；点击“暂停监控”停止执行。");
    const tooltip = new vscode.MarkdownString(lines.join("\n\n"));
    tooltip.supportHtml = true;
    tooltip.isTrusted = { enabledCommands: ["agentStatus.showGpuMonitor", "agentStatus.pauseGpuMonitor", "agentStatus.refreshGpuMonitor", "agentStatus.openSettings"] };
    this.bar.tooltip = tooltip;
    this.bar.show();
  }
}

function enabled(): boolean { return vscode.workspace.getConfiguration("agentStatus.gpu").get<boolean>("enabled", true); }

import * as vscode from "vscode";
import { commandLink, escapeMarkdown } from "./clashPresentation";
import { GOOGLE_WEB_URL, probeGoogle, type NetworkProbeResult } from "./networkProbe";

const DEFAULT_CHECK_INTERVAL_SECONDS = 5 * 60 * 60;

export interface NetworkStatusPresentation {
  icon: "✅️" | "❌";
  tooltip: string;
}

export class NetworkStatusMonitor implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private generation = 0;
  private disposed = false;
  private result: NetworkProbeResult | undefined;
  private updatedAt: Date | undefined;

  public constructor(private readonly onChange: (value: NetworkStatusPresentation | undefined) => void) {}

  public start(): void { this.reloadConfiguration(); }

  public refresh(_trigger: "automatic" | "manual" = "automatic"): Promise<void> {
    if (!this.active(this.generation)) return Promise.resolve();
    if (this.pending) return this.pending;
    const generation = this.generation;
    const controller = new AbortController();
    this.abort = controller;
    this.pending = this.update(generation, controller.signal).finally(() => {
      this.pending = undefined;
      this.abort = undefined;
    });
    return this.pending;
  }

  private async update(generation: number, signal: AbortSignal): Promise<void> {
    let result: NetworkProbeResult;
    try {
      result = await probeGoogle(numberSetting("testTimeoutMs", 15000, 1000, 60000), signal);
    } catch {
      result = { status: "error", detail: "连接失败", elapsedMs: 0 };
    }
    if (!this.active(generation)) return;
    this.result = result;
    this.updatedAt = new Date();
    const http = result.httpStatus === undefined ? "" : "HTTP " + result.httpStatus;
    const tooltip = [
      "**VS Code 扩展宿主 · Google 联网检测**",
      "**" + escapeMarkdown(result.detail) + "**" + (http ? " · " + http : ""),
      result.status === "error" ? "检测耗时：" + result.elapsedMs + " ms" : "网页响应耗时：" + result.elapsedMs + " ms",
      "检测地址：" + GOOGLE_WEB_URL,
      "检测位置：" + (vscode.env.remoteName ? "远程扩展宿主（" + escapeMarkdown(vscode.env.remoteName) + "）" : "本地扩展宿主"),
      "收到任意 HTTP 响应即显示 ✅️，包括跳转、403 和 5xx；仅代表收到响应，不保证网页功能可用。沿用当前扩展宿主的 VS Code/环境代理设置，独立于 Clash 节点测速。",
      "更新于 " + this.updatedAt.toISOString() + " · " + intervalLabel(),
      commandLink("立即检测联网", "agentStatus.refreshNetwork") + " · " + commandLink("设置", "agentStatus.openSettings"),
    ].filter(Boolean).join("\n\n");
    this.onChange({ icon: result.status === "available" ? "✅️" : "❌", tooltip });
  }

  public reloadConfiguration(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.result = undefined;
    this.updatedAt = undefined;
    this.onChange(undefined);
    const generation = this.generation;
    if (!this.active(generation)) return;
    void (async () => {
      await this.pending;
      if (!this.active(generation)) return;
      await this.refresh();
      this.schedule(generation);
    })();
  }

  public getDiagnostics(): Record<string, unknown> {
    return {
      enabled: enabled(), trusted: vscode.workspace.isTrusted,
      extensionHost: vscode.env.remoteName ?? "local",
      url: GOOGLE_WEB_URL, result: this.result,
      updatedAt: this.updatedAt?.toISOString(),
      httpProxyConfigured: Boolean(vscode.workspace.getConfiguration("http").get<string>("proxy", "")),
      proxySupport: vscode.workspace.getConfiguration("http").get<string>("proxySupport", "default"),
    };
  }

  public dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.abort?.abort();
    this.onChange(undefined);
  }

  private active(generation: number): boolean {
    return !this.disposed && generation === this.generation && enabled() && vscode.workspace.isTrusted;
  }

  private schedule(generation: number): void {
    if (!this.active(generation)) return;
    this.timer = setTimeout(() => {
      if (!this.active(generation)) return;
      void this.refresh().finally(() => this.schedule(generation));
    }, numberSetting("updateIntervalSeconds", DEFAULT_CHECK_INTERVAL_SECONDS, 30, 86400) * 1000);
  }
}

function enabled(): boolean {
  return vscode.workspace.getConfiguration("agentStatus.network").get<boolean>("enabled", true);
}

function numberSetting(key: string, fallback: number, min: number, max: number): number {
  const value = vscode.workspace.getConfiguration("agentStatus.network").get<number>(key, fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function intervalLabel(): string {
  const seconds = numberSetting("updateIntervalSeconds", DEFAULT_CHECK_INTERVAL_SECONDS, 30, 86400);
  return seconds % 3600 === 0 ? "每 " + seconds / 3600 + " 小时检测" : "每 " + seconds + " 秒检测";
}

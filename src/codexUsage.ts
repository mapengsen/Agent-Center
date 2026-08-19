import * as vscode from "vscode";
import { getProviderSetting, hasLegacyQuotaConfiguration } from "./configuration";
import {
  DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS,
  formatQuotaStatus,
  formatResetDuration,
  UsageRefreshCadence,
  type CodexUsageSnapshot,
  type CodexUsageWindow,
  type UsageDisplayMode,
} from "./core";
import { fetchCodexUsage } from "./usageService";

export class CodexUsageMonitor implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private snapshot: CodexUsageSnapshot | undefined;
  private lastError = "";
  private displayMode: UsageDisplayMode = getDisplayMode();
  private readonly refreshCadence = new UsageRefreshCadence();

  public constructor() {
    this.statusBar = vscode.window.createStatusBarItem(
      "agentStatus.codexUsage",
      vscode.StatusBarAlignment.Right,
      90,
    );
    this.statusBar.name = "Agent Status: Codex quota";
    this.statusBar.command = "agentStatus.refreshCodexUsage";
    this.statusBar.text = "$(agent-status-codex-blossom) Codex --";
    this.statusBar.tooltip = "Codex 额度正在加载…";
  }

  public start(): void {
    if (!isEnabled()) {
      this.statusBar.hide();
      return;
    }
    void this.refresh().finally(() => this.scheduleNext());
  }

  public async refresh(): Promise<void> {
    if (this.inFlight || !isEnabled()) return;
    this.inFlight = true;
    this.renderRefreshing();
    try {
      const result = await fetchCodexUsage({
        credentialsPath: getProviderSetting("codex", "credentialsPath", "").trim(),
        proxyUrl: getProviderSetting("codex", "proxyUrl", "").trim(),
      });
      if (!result.ok) {
        this.snapshot = undefined;
        this.lastError = result.error.message;
        if (result.error.category === "auth") this.renderAuthRequired();
        else this.renderError();
        return;
      }

      this.snapshot = result.snapshot;
      this.lastError = "";
      this.renderSnapshot(result.snapshot);
    } catch (error) {
      this.snapshot = undefined;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.renderError();
    } finally {
      this.inFlight = false;
    }
  }

  public async chooseDisplayMode(): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      {
        label: "Remaining",
        description: "Show the percentage that is still available (default)",
        value: "remaining" as const,
      },
      {
        label: "Used",
        description: "Show the percentage that has already been used",
        value: "used" as const,
      },
    ], { placeHolder: "Choose the Codex quota display" });
    if (!selected) return;
    await vscode.workspace
      .getConfiguration("agentStatus.codex")
      .update("usageDisplayMode", selected.value, vscode.ConfigurationTarget.Global);
  }

  public reloadConfiguration(): void {
    this.displayMode = getDisplayMode();
    if (!isEnabled()) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.statusBar.hide();
      return;
    }
    if (this.snapshot) this.renderSnapshot(this.snapshot);
    this.scheduleNext();
  }

  public getDiagnostics(): Record<string, unknown> {
    return {
      enabled: isEnabled(),
      hasSnapshot: Boolean(this.snapshot),
      lastError: this.lastError,
      extensionHost: vscode.env.remoteName ?? "local",
      displayMode: this.displayMode,
      legacyConfigurationUsed: hasLegacyQuotaConfiguration("codex"),
      startupRefreshesRemaining: this.refreshCadence.startupRefreshesRemaining,
      updatedAt: this.snapshot?.updatedAt.toISOString() ?? "",
      primaryRemainingPercent: this.snapshot?.primary?.remainingPercent,
      secondaryRemainingPercent: this.snapshot?.secondary?.remainingPercent,
    };
  }

  public dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.statusBar.dispose();
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!isEnabled()) return;
    const regularIntervalSeconds = getProviderSetting(
      "codex",
      "usageUpdateIntervalSeconds",
      DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS,
    );
    const seconds = this.refreshCadence.getDelaySeconds(regularIntervalSeconds);
    this.timer = setTimeout(() => {
      this.refreshCadence.consumeScheduledRefresh();
      void this.refresh().finally(() => this.scheduleNext());
    }, seconds * 1000);
  }

  private renderSnapshot(snapshot: CodexUsageSnapshot): void {
    const primary = snapshot.primary ?? snapshot.secondary;
    const displayPercent = primary ? getDisplayPercent(primary, this.displayMode) : undefined;
    const presentation = primary && displayPercent !== undefined
      ? formatQuotaStatus(displayPercent, this.displayMode, primary.resetsInSeconds, snapshot.updatedAt)
      : undefined;
    this.statusBar.text = presentation
      ? `$(agent-status-codex-blossom) ${presentation.statusText}`
      : "$(agent-status-codex-blossom) Codex --";
    this.statusBar.show();
    this.statusBar.color = undefined;
    this.statusBar.backgroundColor = undefined;
    this.statusBar.tooltip = buildTooltip(snapshot, this.displayMode);
  }

  private renderRefreshing(): void {
    this.statusBar.text = "$(sync~spin) Codex 刷新中…";
    this.statusBar.show();
    this.statusBar.color = undefined;
    this.statusBar.backgroundColor = undefined;
    this.statusBar.tooltip = "正在当前工作区环境中刷新 Codex 额度…";
  }

  private renderAuthRequired(): void {
    this.statusBar.text = "$(agent-status-codex-blossom) Codex --";
    this.statusBar.hide();
    this.statusBar.color = new vscode.ThemeColor("editorWarning.foreground");
    this.statusBar.tooltip = "当前工作区环境中未找到或无法使用 Codex 登录信息。请在该环境运行 codex login。";
  }

  private renderError(): void {
    this.statusBar.text = "$(agent-status-codex-blossom) Codex ?";
    this.statusBar.show();
    this.statusBar.color = new vscode.ThemeColor("editorWarning.foreground");
    this.statusBar.tooltip = `无法读取 Codex 额度。点击刷新重试。\n\n${this.lastError}`;
  }
}

function buildTooltip(snapshot: CodexUsageSnapshot, displayMode: UsageDisplayMode): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.isTrusted = true;
  const displayLabel = displayMode === "remaining" ? "剩余" : "已使用";
  tooltip.appendMarkdown(`**Codex ${displayLabel}额度**\n\n`);
  const primary = snapshot.primary ?? snapshot.secondary;
  const primaryLabel = snapshot.primary ? "短窗口" : "长窗口";
  if (primary) appendStatusMeaning(tooltip, primaryLabel, primary, displayMode, snapshot.updatedAt);
  tooltip.appendMarkdown(`账户：${escapeMarkdown(snapshot.email)}\n\n`);
  tooltip.appendMarkdown(`套餐：${escapeMarkdown(snapshot.planType)}\n\n`);
  tooltip.appendMarkdown("> 这里显示的是当前时间窗口的百分比，不是绝对请求数或 Token 数。\n\n");
  appendWindow(tooltip, "短窗口", snapshot.primary, displayMode);
  appendWindow(tooltip, "长窗口", snapshot.secondary, displayMode);
  tooltip.appendMarkdown(`\n最后更新：${snapshot.updatedAt.toLocaleTimeString()}（当前运行环境时区）\n\n`);
  tooltip.appendMarkdown("[立即刷新](command:agentStatus.refreshCodexUsage) · [切换显示](command:agentStatus.chooseCodexUsageDisplayMode) · [打开设置](command:agentStatus.openSettings)");
  return tooltip;
}

function appendStatusMeaning(
  tooltip: vscode.MarkdownString,
  windowLabel: string,
  window: CodexUsageWindow,
  displayMode: UsageDisplayMode,
  updatedAt: Date,
): void {
  const presentation = formatQuotaStatus(
    getDisplayPercent(window, displayMode),
    displayMode,
    window.resetsInSeconds,
    updatedAt,
  );
  if (!presentation) return;
  const percentageMeaning = displayMode === "remaining"
    ? `当前${windowLabel}还剩 ${presentation.percentageText} 可用额度`
    : `当前${windowLabel}已经使用 ${presentation.percentageText} 额度`;
  const resetMeaning = presentation.resetDateTime
    ? `当前${windowLabel}的重置时间，按 Agent Status 运行环境的时区显示`
    : `额度接口暂未提供当前${windowLabel}的重置时间`;
  tooltip.appendMarkdown("**状态栏含义**\n\n");
  tooltip.appendMarkdown(`\`${presentation.statusText}\`\n\n`);
  tooltip.appendMarkdown(`- \`${presentation.percentageText} ${presentation.modeLabel}\`：${percentageMeaning}。\n\n`);
  tooltip.appendMarkdown(`- \`${presentation.resetDateTime ?? "--"}\`：${resetMeaning}。\n\n`);
  tooltip.appendMarkdown("> Codex 状态栏优先展示短窗口；短窗口不可用时才展示长窗口。\n\n");
}

function appendWindow(
  tooltip: vscode.MarkdownString,
  label: string,
  window: CodexUsageWindow | undefined,
  displayMode: UsageDisplayMode,
): void {
  if (!window) return;
  const duration = window.windowMinutes === undefined
    ? "未知窗口"
    : window.windowMinutes >= 1440
      ? `${Math.round(window.windowMinutes / 1440)} 天`
      : `${Math.round(window.windowMinutes / 60)} 小时`;
  const reset = window.resetsInSeconds === undefined
    ? "未知"
    : formatResetDuration(window.resetsInSeconds);
  const displayLabel = displayMode === "remaining" ? "剩余" : "已使用";
  const otherLabel = displayMode === "remaining" ? "已使用" : "剩余";
  const displayPercent = getDisplayPercent(window, displayMode);
  const otherPercent = getDisplayPercent(window, displayMode === "remaining" ? "used" : "remaining");
  tooltip.appendMarkdown(`**${label}（${duration}）**：${displayLabel} **${displayPercent.toFixed(1)}%**，${otherLabel} ${otherPercent.toFixed(1)}%，${reset} 后重置。\n\n`);
}

function isEnabled(): boolean {
  return getProviderSetting("codex", "enabled", true, false);
}

function getDisplayMode(): UsageDisplayMode {
  return getProviderSetting<UsageDisplayMode>("codex", "usageDisplayMode", "remaining") === "used"
    ? "used"
    : "remaining";
}

function getDisplayPercent(window: CodexUsageWindow, mode: UsageDisplayMode): number {
  return mode === "remaining" ? window.remainingPercent : window.usedPercent;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|<>-]/g, "\\$&");
}

import * as vscode from "vscode";
import { getProviderSetting, hasLegacyQuotaConfiguration } from "./configuration";
import {
  DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS,
  formatQuotaStatus,
  formatResetDuration,
  UsageRefreshCadence,
  type ClaudeUsageSnapshot,
  type ClaudeUsageWindow,
  type UsageDisplayMode,
} from "./core";
import { fetchClaudeUsage } from "./usageService";

type RefreshTrigger = "automatic" | "manual";
type RefreshOutcome = "success" | "failure" | "skipped";

export class ClaudeUsageMonitor implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private snapshot: ClaudeUsageSnapshot | undefined;
  private lastError = "";
  private displayMode: UsageDisplayMode = getDisplayMode();
  private readonly refreshCadence = new UsageRefreshCadence();

  public constructor() {
    this.statusBar = vscode.window.createStatusBarItem(
      "agentStatus.claudeUsage",
      vscode.StatusBarAlignment.Right,
      86,
    );
    this.statusBar.name = "Agent Center: Claude quota";
    this.statusBar.command = "agentStatus.refreshClaudeUsage";
    this.statusBar.text = "$(sparkle) Claude --";
    this.statusBar.tooltip = "Claude 额度正在加载…";
  }

  public start(): void {
    if (!isEnabled()) {
      this.statusBar.hide();
      return;
    }
    void this.refresh("automatic").finally(() => this.scheduleNext());
  }

  public async refresh(trigger: RefreshTrigger = "automatic"): Promise<RefreshOutcome> {
    if (this.inFlight || !isEnabled()) return "skipped";
    this.inFlight = true;
    if (trigger === "manual") this.renderRefreshing();
    try {
      const result = await fetchClaudeUsage({
        credentialsPath: getProviderSetting("claude", "credentialsPath", "").trim(),
        proxyUrl: getProviderSetting("claude", "proxyUrl", "").trim(),
      });
      if (!result.ok) {
        this.snapshot = undefined;
        this.lastError = result.error.message;
        if (result.error.category === "auth") this.renderAuthRequired();
        else this.renderError();
        return "failure";
      }

      this.snapshot = result.snapshot;
      this.lastError = "";
      this.renderSnapshot(result.snapshot);
      return "success";
    } catch (error) {
      this.snapshot = undefined;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.renderError();
      return "failure";
    } finally {
      this.inFlight = false;
    }
  }

  public async chooseDisplayMode(): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      {
        label: "Remaining",
        description: "Show the Claude percentage that is still available (default)",
        value: "remaining" as const,
      },
      {
        label: "Used",
        description: "Show the Claude percentage that has already been used",
        value: "used" as const,
      },
    ], { placeHolder: "Choose the Claude quota display" });
    if (!selected) return;
    await vscode.workspace
      .getConfiguration("agentStatus.claude")
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
      legacyConfigurationUsed: hasLegacyQuotaConfiguration("claude"),
      startupRefreshesRemaining: this.refreshCadence.startupRefreshesRemaining,
      regularRefreshAttempts: this.refreshCadence.regularRefreshAttemptsCount,
      updatedAt: this.snapshot?.updatedAt.toISOString() ?? "",
      fiveHourRemainingPercent: this.snapshot?.fiveHour?.remainingPercent,
      sevenDayRemainingPercent: this.snapshot?.sevenDay?.remainingPercent,
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
      "claude",
      "usageUpdateIntervalSeconds",
      DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS,
    );
    const seconds = this.refreshCadence.getDelaySeconds(regularIntervalSeconds);
    this.timer = setTimeout(() => {
      const isStartupRefresh = this.refreshCadence.consumeScheduledRefresh();
      void this.refresh("automatic")
        .then((outcome) => {
          if (!isStartupRefresh && outcome !== "skipped") {
            this.refreshCadence.recordRegularRefreshResult(outcome === "success");
          }
        })
        .finally(() => this.scheduleNext());
    }, seconds * 1000);
  }

  private renderSnapshot(snapshot: ClaudeUsageSnapshot): void {
    const primary = snapshot.fiveHour ?? snapshot.sevenDay ?? snapshot.sevenDayOpus ?? snapshot.sevenDaySonnet;
    const displayPercent = primary ? getDisplayPercent(primary, this.displayMode) : undefined;
    const presentation = primary && displayPercent !== undefined
      ? formatQuotaStatus(displayPercent, this.displayMode, primary.resetsInSeconds, snapshot.updatedAt)
      : undefined;
    this.statusBar.text = presentation
      ? `$(sparkle) ${presentation.statusText}`
      : "$(sparkle) Claude --";
    this.statusBar.show();
    this.statusBar.color = undefined;
    this.statusBar.backgroundColor = undefined;
    this.statusBar.tooltip = buildTooltip(snapshot, this.displayMode);
  }

  private renderRefreshing(): void {
    this.statusBar.text = "$(sync~spin) Claude 刷新中…";
    this.statusBar.show();
    this.statusBar.color = undefined;
    this.statusBar.backgroundColor = undefined;
    this.statusBar.tooltip = "正在当前工作区环境中刷新 Claude 额度…";
  }

  private renderAuthRequired(): void {
    this.statusBar.text = "$(sparkle) Claude --";
    this.statusBar.hide();
    this.statusBar.color = new vscode.ThemeColor("editorWarning.foreground");
    this.statusBar.tooltip = "当前工作区环境中未找到或无法使用 Claude OAuth 登录信息。请在该环境运行 claude /login。";
  }

  private renderError(): void {
    this.statusBar.text = "$(sparkle) Claude ?";
    this.statusBar.show();
    this.statusBar.color = new vscode.ThemeColor("editorWarning.foreground");
    this.statusBar.tooltip = `无法读取 Claude 额度。点击刷新重试。\n\n${this.lastError}`;
  }
}

function buildTooltip(snapshot: ClaudeUsageSnapshot, displayMode: UsageDisplayMode): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = true;
  const displayLabel = displayMode === "remaining" ? "剩余" : "已使用";
  tooltip.appendMarkdown(`### $(sparkle) Claude ${displayLabel}额度\n\n`);
  const primary = snapshot.fiveHour ?? snapshot.sevenDay ?? snapshot.sevenDayOpus ?? snapshot.sevenDaySonnet;
  const primaryLabel = snapshot.fiveHour
    ? "5 小时窗口"
    : snapshot.sevenDay
      ? "7 天窗口"
      : snapshot.sevenDayOpus
        ? "7 天 Opus 窗口"
        : "7 天 Sonnet 窗口";
  if (primary) appendStatusMeaning(tooltip, primaryLabel, primary, displayMode, snapshot.updatedAt);
  tooltip.appendMarkdown("$(account) **账户**：当前工作区 Claude Code OAuth 会话\n\n");
  tooltip.appendMarkdown(`$(credit-card) **套餐**：${escapeMarkdown(snapshot.subscriptionType ?? "未提供")}\n\n`);
  tooltip.appendMarkdown("> $(info) 额度信息来自当前工作区环境中的 Claude Code OAuth 会话及 Anthropic 额度接口。\n\n");
  appendWindow(tooltip, "clock", "5 小时窗口", snapshot.fiveHour, displayMode);
  appendWindow(tooltip, "calendar", "7 天窗口", snapshot.sevenDay, displayMode);
  appendWindow(tooltip, "calendar", "7 天 Opus", snapshot.sevenDayOpus, displayMode);
  appendWindow(tooltip, "calendar", "7 天 Sonnet", snapshot.sevenDaySonnet, displayMode);
  tooltip.appendMarkdown(`$(history) **最后更新**：${snapshot.updatedAt.toLocaleTimeString()}（当前运行环境时区）\n\n`);
  tooltip.appendMarkdown("$(refresh) [立即刷新](command:agentStatus.refreshClaudeUsage) · $(eye) [切换显示](command:agentStatus.chooseClaudeUsageDisplayMode) · $(settings-gear) [打开设置](command:agentStatus.openSettings)");
  return tooltip;
}

function appendStatusMeaning(
  tooltip: vscode.MarkdownString,
  windowLabel: string,
  window: ClaudeUsageWindow,
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
    ? `当前${windowLabel}的重置时间，按 Agent Center 运行环境的时区显示`
    : `额度接口暂未提供当前${windowLabel}的重置时间`;
  tooltip.appendMarkdown(`$(layout-statusbar) **状态栏含义**：\`${presentation.statusText}\`\n\n`);
  tooltip.appendMarkdown(`- $(pie-chart) \`${presentation.percentageText} ${presentation.modeLabel}\`：${percentageMeaning}。\n\n`);
  tooltip.appendMarkdown(`- $(calendar) \`${presentation.resetDateTime ?? "--"}\`：${resetMeaning}。\n\n`);
  tooltip.appendMarkdown("> $(info) Claude 状态栏优先展示 5 小时窗口；不可用时依次展示 7 天、Opus 和 Sonnet 窗口。\n\n");
}

function appendWindow(
  tooltip: vscode.MarkdownString,
  icon: "clock" | "calendar",
  label: string,
  window: ClaudeUsageWindow | undefined,
  displayMode: UsageDisplayMode,
): void {
  if (!window) return;
  const displayLabel = displayMode === "remaining" ? "剩余" : "已使用";
  const otherLabel = displayMode === "remaining" ? "已使用" : "剩余";
  const displayPercent = getDisplayPercent(window, displayMode);
  const otherPercent = getDisplayPercent(window, displayMode === "remaining" ? "used" : "remaining");
  const reset = window.resetsInSeconds === undefined
    ? "重置时间未知"
    : `${formatResetDuration(window.resetsInSeconds)} 后重置`;
  tooltip.appendMarkdown(`$(${icon}) **${label}**：${displayLabel} **${displayPercent.toFixed(1)}%**，${otherLabel} ${otherPercent.toFixed(1)}%（${reset}）。\n\n`);
}

function isEnabled(): boolean {
  return getProviderSetting("claude", "enabled", true, false);
}

function getDisplayMode(): UsageDisplayMode {
  return getProviderSetting<UsageDisplayMode>("claude", "usageDisplayMode", "remaining") === "used"
    ? "used"
    : "remaining";
}

function getDisplayPercent(window: ClaudeUsageWindow, mode: UsageDisplayMode): number {
  return mode === "remaining" ? window.remainingPercent : window.usedPercent;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|<>-]/g, "\\$&");
}

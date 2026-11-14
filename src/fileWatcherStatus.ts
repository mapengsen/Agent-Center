import * as vscode from "vscode";
import { commandLink } from "./clashPresentation";
import { findFileWatcherFailure, resolveFileWatcherLog, type FileWatcherFailure } from "./fileWatcherLog";
import { probeFileWatchers, type FileWatcherProbeResult } from "./fileWatcherProbe";

// Remote workspaces on shared storage can need over a minute to register watches.
const STARTUP_DELAY_MS = 90_000;
const RELOAD_COMMAND = "agentStatus.reloadWindowForFileWatcher";

export class FileWatcherStatusMonitor implements vscode.Disposable {
  private readonly bar = vscode.window.createStatusBarItem("agentStatus.fileWatcher", vscode.StatusBarAlignment.Right, 95);
  private readonly reloadAction = vscode.commands.registerCommand(RELOAD_COMMAND, () => this.reloadWindow());
  private timer: NodeJS.Timeout | undefined;
  private generation = 0;
  private abort: AbortController | undefined;
  private logFile: string | undefined;
  private failure: FileWatcherFailure | undefined;
  private results: FileWatcherProbeResult[] = [];
  private logStatus: string | undefined;
  private status = "initializing";
  private disposed = false;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.bar.name = "Agent Center · 文件监视异常";
    this.bar.text = "$(warning) 文件监视异常";
    this.bar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.bar.command = "workbench.action.showHover";
  }

  public scheduleStartupCheck(): void {
    if (this.disposed) return;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.logFile = undefined;
    this.abort?.abort();
    this.results = [];
    this.failure = undefined;
    this.logStatus = undefined;
    this.bar.hide();
    if (!vscode.workspace.getConfiguration("agentStatus.fileWatcher").get("enabled", true)) {
      this.status = "disabled";
      return;
    }
    if (!vscode.workspace.isTrusted) {
      this.status = "workspace not trusted";
      return;
    }
    this.status = "waiting for startup check";
    this.timer = setTimeout(() => this.check(generation), STARTUP_DELAY_MS).unref();
  }

  private async check(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    this.timer = undefined;
    const remote = Boolean(vscode.env.remoteName);
    const roots = (vscode.workspace.workspaceFolders ?? [])
      .filter(({ uri }) => uri.scheme === "file" || (remote && uri.scheme === "vscode-remote"))
      .map(({ uri }) => uri);
    if (!roots.length) {
      this.status = "no disk workspace";
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    this.status = "running file watcher probe";
    try {
      const results = await probeFileWatchers(roots, abort.signal);
      if (generation !== this.generation) return;
      this.results = results;
      const failed = results.filter(result => result.status === "no event").map(result => result.root);
      if (!failed.length) {
        this.status = results.every(result => result.status === "passed") ? "passed" : "probe unavailable";
        return;
      }
      this.status = "no file event received";
      await this.explainFailure(failed, remote, generation);
    } catch {
      if (generation === this.generation) this.status = "probe unavailable";
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }

  private async explainFailure(failed: readonly string[], remote: boolean, generation: number): Promise<void> {
    const filename = resolveFileWatcherLog(this.context.logUri.fsPath, remote);
    this.logFile = filename;
    let failure: FileWatcherFailure | undefined;
    let logStatus = "no matching error in current connection";
    try {
      if (filename) failure = await findFileWatcherFailure(filename, remote, failed);
      else logStatus = "watcher log location unavailable";
    } catch {
      logStatus = "watcher log unavailable";
    }
    if (generation !== this.generation) return;
    this.failure = failure;
    this.logStatus = failure ? "matching error found" : logStatus;
    this.show(failed, failure);
  }

  public getDiagnostics(): object {
    return { status: this.status, results: this.results, logFile: this.logFile, logStatus: this.logStatus, failure: this.failure };
  }

  public dispose(): void {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.timer);
    this.abort?.abort();
    this.reloadAction.dispose();
    this.bar.dispose();
  }

  private show(failed: readonly string[], failure: FileWatcherFailure | undefined): void {
    const tooltip = new vscode.MarkdownString("**VS Code 文件监视异常**\n\n");
    tooltip.appendText("工作区自检未收到文件变更事件。");
    for (const root of failed) tooltip.appendMarkdown("\n\n").appendText(root);
    if (failure) {
      tooltip.appendMarkdown("\n\n").appendText(`日志中的监视目录：${failure.root}`);
      if (failure.failedPath) tooltip.appendMarkdown("\n\n").appendText(`失败路径：${failure.failedPath}`);
      tooltip.appendMarkdown("\n\n").appendText(`原因：${failure.reason}`);
      tooltip.appendMarkdown("\n\n").appendText(`日志时间：${new Date(failure.timestamp).toLocaleString()}`);
    } else {
      tooltip.appendMarkdown("\n\n").appendText("当前连接中没有可用于定位原因的日志。");
    }
    tooltip.appendMarkdown("\n\n磁盘上的修改可能暂时无法同步到编辑器。\n\n" + commandLink("重新加载窗口", RELOAD_COMMAND));
    tooltip.isTrusted = { enabledCommands: [RELOAD_COMMAND] };
    this.bar.tooltip = tooltip;
    this.bar.show();
  }

  private async reloadWindow(): Promise<void> {
    if (this.status !== "no file event received") return;
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

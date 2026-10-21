import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { getApiProvider, isApiUrl, parseCodexConfig, validateProviderId, type NewApiProvider } from "./codexProviderConfig";
import { readCodexConfig, resolveCodexHome, switchCodexProvider, type ProviderSwitchResult } from "./codexProviderService";

export class CodexProviderSwitcher implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem("agentStatus.codexProvider", vscode.StatusBarAlignment.Right, 89);
  private readonly home = resolveCodexHome();
  private readonly configPath = path.join(this.home, "config.toml");
  private busy = false;
  private provider = "openai";
  private lastError = "";
  private lastResult: ProviderSwitchResult | undefined;
  private disposed = false;
  private readonly onConfigChanged = (): void => { void this.refresh(); };

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar.name = "Agent Center: Codex provider";
    this.statusBar.command = "agentStatus.switchCodexProvider";
  }

  public start(): void {
    fs.watchFile(this.configPath, { persistent: false, interval: 5000 }, this.onConfigChanged);
    void this.refresh();
  }

  public async refresh(): Promise<void> {
    if (this.disposed) return;
    try {
      const config = parseCodexConfig(await readCodexConfig(this.home));
      this.provider = typeof config.model_provider === "string" ? config.model_provider : "openai";
      this.lastError = "";
    } catch {
      this.lastError = "无法读取 Codex 服务商配置。";
    }
    if (this.disposed) return;
    this.statusBar.text = `$(server-environment) ${this.lastError ? "Codex 服务商 ?" : this.provider === "openai" ? "OpenAI 官方" : this.provider.slice(0, 32)}`;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = { enabledCommands: ["agentStatus.switchCodexProvider"] };
    tooltip.appendText(`Codex 服务商：${this.provider}\n当前环境：${vscode.env.remoteName ?? "local"}\n`);
    tooltip.appendText("切换后，全部已索引本地聊天对所选服务商可见；原有归档和工作区筛选保留。\n");
    if (this.lastError) tooltip.appendText(this.lastError + "\n");
    if (this.lastResult) tooltip.appendText(`上次处理 ${this.lastResult.threadCount} 条历史。备份：${this.lastResult.backupDirectory}\n`);
    tooltip.appendMarkdown("\n[切换服务商](command:agentStatus.switchCodexProvider)");
    this.statusBar.tooltip = tooltip;
    this.statusBar.accessibilityInformation = { label: `Codex 服务商 ${this.provider}，点击切换` };
    if (vscode.workspace.getConfiguration("agentStatus.codexProvider").get("enabled", true)) this.statusBar.show();
    else this.statusBar.hide();
  }

  public async choose(): Promise<void> {
    if (this.busy) return;
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("请先信任当前工作区，再切换 Codex 服务商。");
      return;
    }
    const selection = await vscode.window.showQuickPick([
      { label: "OpenAI 官方（ChatGPT 登录）", description: this.provider === "openai" ? "当前服务商" : "使用已有 ChatGPT 登录", value: "official" },
      { label: "自定义 API", description: "自己输入 model_provider 的 ID，例如 beeapi", value: "api" },
    ], { title: "切换 Codex 服务商 · 全部历史共用", placeHolder: "切换后重新加载窗口生效；请先停止正在进行的 Codex 回复。" });
    if (!selection) return;
    this.busy = true;
    try {
      let provider = "openai";
      let newProvider: NewApiProvider | undefined;
      if (selection.value === "api") {
        const entered = await vscode.window.showInputBox({
          title: "自定义 API 服务商 ID",
          prompt: '请输入 model_provider 的值。例如配置为 model_provider = "beeapi"，这里只填 beeapi。',
          placeHolder: "beeapi",
          value: this.provider === "openai" ? "" : this.provider,
          validateInput: (value) => validateProviderId(value.trim()),
          ignoreFocusOut: true,
        });
        if (entered === undefined) return;
        provider = entered.trim();
        const config = parseCodexConfig(await readCodexConfig(this.home));
        if (!getApiProvider(config, provider)) {
          const baseUrl = await vscode.window.showInputBox({
            title: `新增 API 服务商：${provider}`,
            prompt: "未找到对应配置，请输入兼容 Responses API 的接口地址（Base URL）。",
            placeHolder: "https://api.example.com/v1", ignoreFocusOut: true,
            validateInput: (value) => isApiUrl(value.trim()) ? undefined : "请输入 HTTP/HTTPS 地址，不要在地址中填写密钥或账户密码。",
          });
          if (baseUrl === undefined) return;
          const apiKey = await vscode.window.showInputBox({
            title: `API Key：${provider}`,
            prompt: "将保存到当前环境的 Codex config.toml，不会写入 VS Code 设置或日志。",
            password: true, ignoreFocusOut: true,
            validateInput: (value) => value.trim() ? undefined : "API Key 不能为空。",
          });
          if (apiKey === undefined) return;
          newProvider = { baseUrl: baseUrl.trim(), apiKey };
        }
      }
      if (this.disposed || !vscode.workspace.isTrusted) return;
      this.lastResult = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "切换 Codex 服务商", cancellable: false },
        (progress) => switchCodexProvider({
          home: this.home, provider, newProvider,
          scriptPath: this.context.asAbsolutePath("resources/codex_provider_history.py"),
          pythonPath: vscode.workspace.getConfiguration("agentStatus.codexProvider").get<string>("pythonPath", ""),
          onProgress: (message) => progress.report({ message }),
        }));
      if (this.disposed) return;
      await this.refresh();
      const action = await vscode.window.showInformationMessage(
        `已设置 ${provider === "openai" ? "OpenAI 官方（ChatGPT 登录）" : provider}，${this.lastResult.threadCount} 条历史已共用。重新加载窗口后生效${provider === "openai" ? "；若未登录，请在 Codex 中完成 ChatGPT 登录" : ""}。`,
        "重新加载窗口", "稍后",
      );
      if (action === "重新加载窗口") await vscode.commands.executeCommand("workbench.action.reloadWindow");
    } catch (error) {
      // All service errors are sanitized; never log config, API keys or helper stdin.
      this.lastError = error instanceof Error ? error.message : "服务商切换失败。";
      const action = await vscode.window.showErrorMessage(this.lastError, "打开 Codex 配置");
      if (action === "打开 Codex 配置") await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(this.configPath));
    } finally {
      this.busy = false;
    }
  }

  public getDiagnostics(): Record<string, unknown> {
    return { provider: this.provider, codexHome: this.home, busy: this.busy, lastError: this.lastError,
      lastSwitch: this.lastResult ? { ...this.lastResult } : undefined };
  }

  public dispose(): void {
    this.disposed = true;
    fs.unwatchFile(this.configPath, this.onConfigChanged);
    this.statusBar.dispose();
  }
}

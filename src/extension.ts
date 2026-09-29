import * as vscode from "vscode";
import { ClaudeUsageMonitor } from "./claudeUsage";
import { CodexUsageMonitor } from "./codexUsage";
import { CodexImageLinkMonitor } from "./codexImageLinks";

export function activate(context: vscode.ExtensionContext): void {
  const codexUsage = new CodexUsageMonitor();
  const claudeUsage = new ClaudeUsageMonitor();
  const codexImageLinks = new CodexImageLinkMonitor(context);
  const diagnostics = vscode.window.createOutputChannel("Agent Center");

  context.subscriptions.push(
    codexUsage,
    claudeUsage,
    codexImageLinks,
    diagnostics,
    vscode.commands.registerCommand("agentStatus.refreshCodexUsage", () => codexUsage.refresh("manual")),
    vscode.commands.registerCommand("agentStatus.restartCodexImageLinks", () => codexImageLinks.restart()),
    vscode.commands.registerCommand(
      "agentStatus.chooseCodexUsageDisplayMode",
      () => codexUsage.chooseDisplayMode(),
    ),
    vscode.commands.registerCommand("agentStatus.refreshClaudeUsage", () => claudeUsage.refresh("manual")),
    vscode.commands.registerCommand(
      "agentStatus.chooseClaudeUsageDisplayMode",
      () => claudeUsage.chooseDisplayMode(),
    ),
    vscode.commands.registerCommand("agentStatus.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:pengsen.codex-claude-agent-status"),
    ),
    vscode.commands.registerCommand("agentStatus.showDiagnostics", () => {
      diagnostics.clear();
      diagnostics.appendLine("Agent Center diagnostics");
      diagnostics.appendLine(JSON.stringify({
        extensionHost: vscode.env.remoteName ?? "local",
        codex: codexUsage.getDiagnostics(),
        claude: claudeUsage.getDiagnostics(),
        codexImageLinks: codexImageLinks.getDiagnostics(),
      }, null, 2));
      diagnostics.show(true);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("agentStatus.codexImageLinks") ||
          event.affectsConfiguration("codexImageOpener.enabled")) {
        void codexImageLinks.restart();
      }
      const codexChanged = event.affectsConfiguration("agentStatus.codex") ||
        event.affectsConfiguration("codexTaskCompanion.codex.credentialsPath") ||
        event.affectsConfiguration("codexTaskCompanion.codex.usageUpdateIntervalSeconds") ||
        event.affectsConfiguration("codexTaskCompanion.codex.usageDisplayMode") ||
        event.affectsConfiguration("codexTaskCompanion.codex.proxyUrl");
      if (codexChanged) {
        codexUsage.reloadConfiguration();
        if (event.affectsConfiguration("agentStatus.codex.enabled") ||
            event.affectsConfiguration("agentStatus.codex.credentialsPath") ||
            event.affectsConfiguration("agentStatus.codex.proxyUrl") ||
            event.affectsConfiguration("codexTaskCompanion.codex.credentialsPath") ||
            event.affectsConfiguration("codexTaskCompanion.codex.proxyUrl")) {
          void codexUsage.refresh();
        }
      }

      const claudeChanged = event.affectsConfiguration("agentStatus.claude") ||
        event.affectsConfiguration("codexTaskCompanion.claude.credentialsPath") ||
        event.affectsConfiguration("codexTaskCompanion.claude.usageUpdateIntervalSeconds") ||
        event.affectsConfiguration("codexTaskCompanion.claude.usageDisplayMode") ||
        event.affectsConfiguration("codexTaskCompanion.claude.proxyUrl");
      if (claudeChanged) {
        claudeUsage.reloadConfiguration();
        if (event.affectsConfiguration("agentStatus.claude.enabled") ||
            event.affectsConfiguration("agentStatus.claude.credentialsPath") ||
            event.affectsConfiguration("agentStatus.claude.proxyUrl") ||
            event.affectsConfiguration("codexTaskCompanion.claude.credentialsPath") ||
            event.affectsConfiguration("codexTaskCompanion.claude.proxyUrl")) {
          void claudeUsage.refresh();
        }
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { void codexImageLinks.restart(); }),
    vscode.extensions.onDidChange(() => { void codexImageLinks.restart(); }),
  );

  codexUsage.start();
  claudeUsage.start();
  void codexImageLinks.restart();
}

export function deactivate(): void {
  // VS Code disposes all extension-context subscriptions.
}

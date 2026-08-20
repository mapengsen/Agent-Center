import * as vscode from "vscode";
import { ClaudeUsageMonitor } from "./claudeUsage";
import { CodexUsageMonitor } from "./codexUsage";

export function activate(context: vscode.ExtensionContext): void {
  const codexUsage = new CodexUsageMonitor();
  const claudeUsage = new ClaudeUsageMonitor();
  const diagnostics = vscode.window.createOutputChannel("Agent Status");

  context.subscriptions.push(
    codexUsage,
    claudeUsage,
    diagnostics,
    vscode.commands.registerCommand("agentStatus.refreshCodexUsage", () => codexUsage.refresh("manual")),
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
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:pengsen.agent-status"),
    ),
    vscode.commands.registerCommand("agentStatus.showDiagnostics", () => {
      diagnostics.clear();
      diagnostics.appendLine("Agent Status diagnostics");
      diagnostics.appendLine(JSON.stringify({
        extensionHost: vscode.env.remoteName ?? "local",
        codex: codexUsage.getDiagnostics(),
        claude: claudeUsage.getDiagnostics(),
      }, null, 2));
      diagnostics.show(true);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
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
  );

  codexUsage.start();
  claudeUsage.start();
}

export function deactivate(): void {
  // VS Code disposes all extension-context subscriptions.
}

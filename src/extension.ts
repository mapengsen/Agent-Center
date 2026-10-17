import * as vscode from "vscode";
import { ClaudeUsageMonitor } from "./claudeUsage";
import { CodexUsageMonitor } from "./codexUsage";
import { CodexImageLinkMonitor } from "./codexImageLinks";
import { ClashStatusMonitor } from "./clashStatus";
import { NetworkStatusMonitor } from "./networkStatus";

export function activate(context: vscode.ExtensionContext): void {
  const codexUsage = new CodexUsageMonitor();
  const claudeUsage = new ClaudeUsageMonitor();
  const codexImageLinks = new CodexImageLinkMonitor(context);
  const clashStatus = new ClashStatusMonitor();
  const networkStatus = new NetworkStatusMonitor((status) => clashStatus.setNetworkStatus(status));
  const diagnostics = vscode.window.createOutputChannel("Agent Center");

  context.subscriptions.push(
    codexUsage,
    claudeUsage,
    codexImageLinks,
    clashStatus,
    networkStatus,
    diagnostics,
    vscode.commands.registerCommand("agentStatus.refreshCodexUsage", () => codexUsage.refresh("manual")),
    vscode.commands.registerCommand("agentStatus.restartCodexImageLinks", () => codexImageLinks.restart()),
    vscode.commands.registerCommand("agentStatus.refreshClash", () => clashStatus.refresh("manual")),
    vscode.commands.registerCommand("agentStatus.refreshNetwork", () => networkStatus.refresh("manual")),
    vscode.commands.registerCommand("agentStatus.chooseClashNode", (selection?: unknown) => clashStatus.chooseNode(selection)),
    vscode.commands.registerCommand("agentStatus.addClashSubscription", () => clashStatus.manageSubscriptions("add")),
    vscode.commands.registerCommand("agentStatus.chooseClashSubscription", () => clashStatus.manageSubscriptions("choose")),
    vscode.commands.registerCommand("agentStatus.removeClashSubscription", () => clashStatus.manageSubscriptions("remove")),
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
        clash: clashStatus.getDiagnostics(),
        network: networkStatus.getDiagnostics(),
        codexImageLinks: codexImageLinks.getDiagnostics(),
      }, null, 2));
      diagnostics.show(true);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("agentStatus.codexImageLinks") ||
          event.affectsConfiguration("codexImageOpener.enabled")) {
        void codexImageLinks.restart();
      }
      if (event.affectsConfiguration("agentStatus.clash")) clashStatus.reloadConfiguration();
      if (event.affectsConfiguration("agentStatus.network") || event.affectsConfiguration("http")) {
        networkStatus.reloadConfiguration();
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
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void codexImageLinks.restart();
      clashStatus.reloadConfiguration();
      networkStatus.reloadConfiguration();
    }),
    vscode.extensions.onDidChange(() => { void codexImageLinks.restart(); }),
  );

  codexUsage.start();
  claudeUsage.start();
  void codexImageLinks.restart();
  clashStatus.start();
  networkStatus.start();
}

export function deactivate(): void {
  // VS Code disposes all extension-context subscriptions.
}

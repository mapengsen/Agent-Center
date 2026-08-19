import * as vscode from "vscode";

export type Provider = "codex" | "claude";

export function getProviderSetting<T>(
  provider: Provider,
  key: string,
  defaultValue: T,
  allowLegacy = true,
): T {
  const current = explicitValue(
    vscode.workspace.getConfiguration(`agentStatus.${provider}`).inspect<T>(key),
  );
  if (current.found) return current.value as T;

  if (allowLegacy) {
    const legacy = explicitValue(
      vscode.workspace.getConfiguration(`codexTaskCompanion.${provider}`).inspect<T>(key),
    );
    if (legacy.found) return legacy.value as T;
  }

  return vscode.workspace
    .getConfiguration(`agentStatus.${provider}`)
    .get<T>(key, defaultValue);
}

export function hasLegacyQuotaConfiguration(provider: Provider): boolean {
  return [
    "credentialsPath",
    "usageUpdateIntervalSeconds",
    "usageDisplayMode",
    "proxyUrl",
  ].some((key) => explicitValue(
    vscode.workspace.getConfiguration(`codexTaskCompanion.${provider}`).inspect<unknown>(key),
  ).found && !explicitValue(
    vscode.workspace.getConfiguration(`agentStatus.${provider}`).inspect<unknown>(key),
  ).found);
}

function explicitValue<T>(inspection: {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
} | undefined): { found: boolean; value?: T } {
  if (!inspection) return { found: false };
  if (inspection.workspaceFolderValue !== undefined) {
    return { found: true, value: inspection.workspaceFolderValue };
  }
  if (inspection.workspaceValue !== undefined) {
    return { found: true, value: inspection.workspaceValue };
  }
  if (inspection.globalValue !== undefined) {
    return { found: true, value: inspection.globalValue };
  }
  return { found: false };
}

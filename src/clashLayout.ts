import * as os from "node:os";
import * as path from "node:path";

export interface ClashInstallationLayout {
  root: string;
  runtimeDirectory: string;
  host?: string;
}

/** Recognize supported layouts without searching unrelated ancestor directories. */
export function clashInstallationLayout(configPath: string): ClashInstallationLayout | undefined {
  if (!configPath || !path.isAbsolute(configPath)) return undefined;
  const runtimeDirectory = path.dirname(path.normalize(configPath));
  if (path.basename(runtimeDirectory) === "runtime") {
    return { root: path.dirname(runtimeDirectory), runtimeDirectory };
  }
  const hosts = path.dirname(runtimeDirectory);
  const runtime = path.dirname(hosts);
  if (path.basename(hosts) === "hosts" && path.basename(runtime) === "runtime") {
    return { root: path.dirname(runtime), runtimeDirectory, host: path.basename(runtimeDirectory) };
  }
  return undefined;
}

export function clashInstallationConfigs(root: string, hostname = os.hostname()): string[] {
  const host = hostname.split(".")[0];
  return [
    ...(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)
      ? [path.join(root, "runtime", "hosts", host, "config.yaml")] : []),
    path.join(root, "runtime", "config.yaml"),
  ];
}

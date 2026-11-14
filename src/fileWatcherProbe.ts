import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import { fileWatcherPathKey } from "./fileWatcherLog";

export interface FileWatcherProbeResult {
  root: string;
  status: "passed" | "no event" | "unavailable";
  error?: string;
}

export async function probeFileWatchers(roots: readonly vscode.Uri[], signal: AbortSignal, timeoutMs = 5000): Promise<FileWatcherProbeResult[]> {
  const name = `.agent-center-watch-${randomUUID()}`;
  // A string glob filters existing workspace events. RelativePattern can start a new watcher.
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${name}`, false, true, true);
  const listeners = new Map<string, () => void>();
  const subscription = watcher.onDidCreate(uri => listeners.get(fileWatcherPathKey(uri.fsPath))?.());
  try {
    return await Promise.all(roots.map(async (root): Promise<FileWatcherProbeResult> => {
      const target = vscode.Uri.joinPath(root, name).fsPath;
      const key = fileWatcherPathKey(target);
      const received = new Promise<true>(resolve => listeners.set(key, () => resolve(true)));
      const timeout = new AbortController();
      let created = false;
      try {
        signal.throwIfAborted();
        // Direct disk I/O avoids VS Code's synthetic file service events.
        const file = await fs.open(target, "wx", 0o600);
        created = true;
        await file.close();
        const notified = await Promise.race([received, delay(timeoutMs, false, { signal: AbortSignal.any([signal, timeout.signal]) })]);
        return { root: root.fsPath, status: notified ? "passed" : "no event" };
      } catch (error) {
        return { root: root.fsPath, status: "unavailable", error: (error as NodeJS.ErrnoException).code ?? "probe failed" };
      } finally {
        timeout.abort();
        listeners.delete(key);
        if (created) await fs.unlink(target).catch(() => undefined);
      }
    }));
  } finally {
    subscription.dispose();
    watcher.dispose();
  }
}

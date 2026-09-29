import * as path from "node:path";
import * as vscode from "vscode";
import { DEFAULT_LINK_EXTENSIONS, isSupportedLinkPath } from "./linkFormats";

export interface TextEditorLinkResult {
  status: "opened" | "failed";
  path: string;
  error?: string;
}

export interface TextEditorLinkOptions {
  extensions?: readonly string[];
  isActive(): boolean;
  // Resolve the CLI before closing anything, so missing launchers leave the tab intact.
  prepare(target: string): Promise<() => Promise<void>>;
  onResult(result: TextEditorLinkResult): void;
}

export class TextEditorLinkRecovery implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[];
  private readonly handledTabs = new WeakSet<vscode.Tab>();
  private readonly recent = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private disposed = false;

  public constructor(private readonly options: TextEditorLinkOptions) {
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.tabGroups.onDidChangeTabs(event => {
        for (const tab of [...event.opened, ...event.changed]) {
          if (tab.input instanceof vscode.TabInputCustom || tab.input instanceof vscode.TabInputNotebook) {
            this.recent.delete(tab.input.uri.toString());
          }
        }
        this.schedule();
      }),
    ];
    this.schedule();
  }

  public getDiagnostics(): object {
    return { enabled: !this.disposed, busy: this.busy, formats: [...(this.options.extensions ?? DEFAULT_LINK_EXTENSIONS)], scope: "clean active text tabs from any source" };
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.disposed) return;
    // showTextDocument and tab updates can arrive separately. Wait for both.
    this.timer = setTimeout(() => { void this.recoverActiveEditor(); }, 120);
    this.timer.unref();
  }

  private candidate(): { tab: vscode.Tab; document: vscode.TextDocument; key: string } | undefined {
    if (this.disposed || !this.options.isActive()) return undefined;
    const editor = vscode.window.activeTextEditor;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!editor || !tab || !(tab.input instanceof vscode.TabInputText)) return undefined;
    const document = editor.document;
    const uri = document.uri;
    if (document.isClosed || document.isDirty || tab.isDirty ||
        !isSupportedLinkPath(uri.path, this.options.extensions ?? DEFAULT_LINK_EXTENSIONS)) return undefined;
    if (uri.scheme !== "file" && !(uri.scheme === "vscode-remote" && vscode.env.remoteName)) return undefined;
    if (!path.isAbsolute(uri.fsPath) || tab.input.uri.toString() !== uri.toString()) return undefined;
    return { tab, document, key: uri.toString() };
  }

  public async recoverActiveEditor(): Promise<void> {
    if (this.busy) return;
    const candidate = this.candidate();
    if (!candidate || this.handledTabs.has(candidate.tab)) return;
    const { tab, document, key } = candidate;
    const previous = this.recent.get(key);
    if (previous !== undefined && Date.now() - previous < 5000) {
      // If the CLI itself returns a text tab (e.g. no PDF viewer), keep that
      // tab usable rather than creating an endless close/reopen loop.
      this.handledTabs.add(tab);
      return;
    }
    this.busy = true;
    try {
      const open = await this.options.prepare(document.uri.fsPath);
      const current = this.candidate();
      if (!current || current.tab !== tab) return;
      const textTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(
        item => item.input instanceof vscode.TabInputText && item.input.uri.toString() === key,
      );
      // Another text tab for this file would otherwise be reused by code -r.
      // Preserve all unsaved work, custom viewers, diffs and unrelated files.
      if (!textTabs.includes(tab) || textTabs.some(item => item.isDirty) || document.isDirty) return;
      textTabs.forEach(item => this.handledTabs.add(item));
      this.recent.set(key, Date.now());
      if (this.recent.size > 256) this.recent.delete(this.recent.keys().next().value!);
      const closed = await vscode.window.tabGroups.close(textTabs, true);
      if (!closed) throw new Error("The text tab could not be closed; code -r was not run.");
      if (this.disposed || !this.options.isActive()) return;
      await open();
      // Start suppression after the CLI finishes too: a slow launch may take
      // longer than the original interval, especially on remote machines.
      if (this.recent.has(key)) this.recent.set(key, Date.now());
      for (const item of vscode.window.tabGroups.all.flatMap(group => group.tabs)) {
        if (item.input instanceof vscode.TabInputText && item.input.uri.toString() === key) this.handledTabs.add(item);
      }
      if (!this.disposed) this.options.onResult({ status: "opened", path: document.uri.fsPath });
    } catch (error) {
      this.handledTabs.add(tab);
      if (!this.disposed) this.options.onResult({
        status: "failed", path: document.uri.fsPath,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.busy = false;
      // Re-evaluate a newly active tab, but do not poll a blocked/dirty duplicate.
      if (this.candidate()?.tab !== tab) this.schedule();
    }
  }

  public dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.recent.clear();
  }
}

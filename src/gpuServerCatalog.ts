import * as vscode from "vscode";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { parseGpuServers, type GpuServer } from "./gpuServerConfig";

export interface GpuServerCatalog {
  readonly servers: readonly GpuServer[];
  readonly detail: string;
  onDidChange(listener: () => void): vscode.Disposable;
  reload(): Promise<void>;
  dispose(): void;
}

export class WorkspaceGpuServers implements GpuServerCatalog {
  public servers: readonly GpuServer[] = [];
  public detail = "";
  private readonly changed = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private folder: string | undefined;
  private signature = "";
  private generation = 0;
  private disposed = false;

  public constructor() {
    this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.reload(); }),
      vscode.window.onDidChangeActiveTextEditor(() => { if (this.root()?.uri.toString() !== this.folder) void this.reload(); }));
  }

  private root(): vscode.WorkspaceFolder | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined) ?? vscode.workspace.workspaceFolders?.[0];
  }

  public async reload(): Promise<void> {
    const generation = ++this.generation;
    const root = this.root(), folder = root?.uri.toString();
    if (this.disposed) return;
    if (this.folder !== folder) {
      this.folder = folder;
      this.watcher?.dispose(); this.watcher = undefined;
      if (root) {
        const watcher = this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "可用服务器.md"));
        watcher.onDidChange(() => { void this.reload(); });
        watcher.onDidCreate(() => { void this.reload(); });
        watcher.onDidDelete(() => { void this.reload(); });
      }
    }
    let servers: GpuServer[] = [], detail = "", signature = "";
    if (root && vscode.workspace.isTrusted && vscode.workspace.getConfiguration("agentStatus.gpu").get("enabled", true)) {
      const uri = vscode.Uri.joinPath(root.uri, "可用服务器.md");
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 256 * 1024) detail = "可用服务器.md 超过 256 KiB，未读取。";
        else {
          const data = await vscode.workspace.fs.readFile(uri);
          if (data.byteLength > 256 * 1024) detail = "可用服务器.md 超过 256 KiB，未读取。";
          else {
            const parsed = parseGpuServers(Buffer.from(data).toString("utf8"), uri.toString());
            servers = parsed.servers.map(server => server.privateKeyPath && !path.isAbsolute(server.privateKeyPath) && !server.privateKeyPath.startsWith("~/")
              ? { ...server, privateKeyPath: path.resolve(root.uri.fsPath, server.privateKeyPath) } : server);
            if (parsed.invalidLines.length) detail = "可用服务器.md 有 " + parsed.invalidLines.length + " 行 SSH 配置未识别。";
            signature = createHash("sha256").update(uri.toString()).update(data).digest("hex");
          }
        }
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) detail = "无法读取可用服务器.md。";
      }
    }
    if (this.disposed || generation !== this.generation) return;
    signature += "|" + (folder ?? "") + "|" + detail;
    if (signature === this.signature) return;
    this.signature = signature; this.servers = servers; this.detail = detail;
    this.changed.fire();
  }

  public dispose(): void {
    this.disposed = true; this.generation++;
    this.watcher?.dispose(); this.changed.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.servers = [];
  }
}

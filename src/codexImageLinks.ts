import * as path from "node:path";
import * as vscode from "vscode";
import { ImageLinkRecovery } from "./imageLinkRecovery";
import { LogTail } from "./logTail";

interface RecoveryEvent {
  at: string;
  status: "opened" | "missing" | "failed";
  path: string;
  error?: string;
}

export class CodexImageLinkMonitor implements vscode.Disposable {
  private generation = 0;
  private disposed = false;
  private timer: NodeJS.Timeout | undefined;
  private tail: LogTail | undefined;
  private state = "starting";
  private opened = 0;
  private readonly recentEvents: RecoveryEvent[] = [];

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getDiagnostics(): object {
    return {
      status: this.state,
      logFile: this.tail?.filename,
      extensionHost: vscode.env.remoteName ?? "local",
      codexVersion: vscode.extensions.getExtension("openai.chatgpt")?.packageJSON.version,
      focused: vscode.window.state.focused,
      opened: this.opened,
      recentEvents: [...this.recentEvents],
    };
  }

  public async restart(): Promise<void> {
    const run = ++this.generation;
    clearInterval(this.timer);
    this.timer = undefined;
    this.tail = undefined;
    this.state = "starting";
    if (this.disposed) { this.state = "disposed"; return; }
    const config = vscode.workspace.getConfiguration("agentStatus.codexImageLinks");
    if (!config.get<boolean>("enabled", true)) { this.state = "disabled"; return; }
    if (!vscode.workspace.isTrusted) { this.state = "disabled in untrusted workspace"; return; }
    // Avoid two readers opening the same image if the prototype is installed.
    if (vscode.extensions.getExtension("local-tools.codex-image-opener") &&
        vscode.workspace.getConfiguration("codexImageOpener").get<boolean>("enabled", true)) {
      this.state = "disabled while standalone Codex Image Opener is enabled; disable or uninstall it to use Agent Center";
      return;
    }
    const setting = config.get<unknown>("logFile", "");
    if (typeof setting !== "string" || (setting.trim() && !path.isAbsolute(setting.trim()))) {
      this.state = "logFile must be an absolute path in this extension host";
      return;
    }
    // Both extensions must use the same host/window. Never search another
    // window's logs or reinterpret paths from a different remote environment.
    const filename = setting.trim() || path.join(
      path.dirname(this.context.logUri.fsPath), "openai.chatgpt", "Codex.log",
    );
    const tail = new LogTail(filename);
    this.tail = tail;
    const current = () => !this.disposed && this.generation === run;
    const recovery = new ImageLinkRecovery({
      isActive: () => current() && vscode.workspace.isTrusted && vscode.window.state.focused,
      isFile: async (target) => {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(target));
        return (stat.type & vscode.FileType.File) !== 0;
      },
      open: (target) => vscode.commands.executeCommand("vscode.open", vscode.Uri.file(target), { preview: false }),
    });
    try {
      await tail.prime();
    } catch (error) {
      if (current()) this.state = `Cannot read Codex log: ${errorMessage(error)}`;
      return;
    }
    if (!current()) return;
    this.state = tail.status;
    let ticking = false;
    const tick = async () => {
      if (ticking || !current()) return;
      ticking = true;
      try {
        const lines = await tail.readNewLines();
        if (!current()) return;
        this.state = tail.status;
        for (const line of lines) {
          if (!current()) break;
          const result = await recovery.handle(line);
          if (!current()) break;
          if (result.status === "opened" || result.status === "missing" || result.status === "failed") {
            if (result.status === "opened") this.opened++;
            // Diagnostics stay in bounded memory, not an additional log file.
            this.recentEvents.push({ at: new Date().toISOString(), ...result });
            if (this.recentEvents.length > 40) this.recentEvents.shift();
          }
        }
      } catch (error) {
        if (current()) this.state = `Cannot read Codex log: ${errorMessage(error)}`;
      } finally {
        ticking = false;
      }
    };
    this.timer = setInterval(() => { void tick(); }, 500);
    this.timer.unref();
  }

  public dispose(): void {
    this.disposed = true;
    this.generation++;
    clearInterval(this.timer);
    this.state = "disposed";
    this.recentEvents.length = 0;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

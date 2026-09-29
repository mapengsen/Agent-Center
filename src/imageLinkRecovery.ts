import * as path from "node:path";

export function parseCodexImageOpenFailure(
  line: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  // Match only the known absolute-file opener failure, not arbitrary path
  // mentions, relative paths with an unknown cwd, or reveal-in-OS requests.
  const match = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ \[error\] Failed to handle absolute path actionVerb=open normalized=(.*)$/.exec(line);
  if (!match) return undefined;
  let target: unknown = match[1];
  if (match[1].startsWith('"')) {
    try { target = JSON.parse(match[1]); } catch { return undefined; }
  } else if (/\s/.test(match[1])) {
    return undefined;
  }
  if (typeof target !== "string" || /[\x00-\x1f]/.test(target)) return undefined;
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(target) || !/\.(?:png|jpe?g|gif|webp|bmp|ico)$/i.test(target)) return undefined;
  // Do not accidentally treat a Linux server path as a Windows drive-relative path.
  if (platform === "win32" && !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\|\/\/[^/]+\/)/i.test(target)) return undefined;
  return target;
}

export type ImageRecoveryResult =
  | { status: "ignored" | "duplicate" }
  | { status: "opened" | "missing"; path: string }
  | { status: "failed"; path: string; error: string };

export interface ImageRecoveryOptions {
  platform?: NodeJS.Platform;
  isActive(): boolean;
  isFile(path: string): Promise<boolean>;
  open(path: string): PromiseLike<unknown>;
  now?(): number;
}

export class ImageLinkRecovery {
  private readonly recent = new Map<string, number>();

  public constructor(private readonly options: ImageRecoveryOptions) {}

  public async handle(line: string): Promise<ImageRecoveryResult> {
    const target = parseCodexImageOpenFailure(line, this.options.platform);
    if (!target || !this.options.isActive()) return { status: "ignored" };
    const now = this.options.now?.() ?? Date.now();
    const previous = this.recent.get(target);
    if (previous !== undefined && now - previous < 1000) return { status: "duplicate" };
    this.recent.set(target, now);
    if (this.recent.size > 256) this.recent.delete(this.recent.keys().next().value!);
    try {
      if (!await this.options.isFile(target)) return { status: "missing", path: target };
      if (!this.options.isActive()) return { status: "ignored" };
      await this.options.open(target);
      return { status: "opened", path: target };
    } catch (error) {
      return { status: "failed", path: target, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename } from "node:path";

export class LogTail {
  public status: "initializing" | "watching" | `waiting for ${string}` = "initializing";
  private offset = 0;
  private identity: string | undefined;
  private partial: Buffer = Buffer.alloc(0);
  private discardLine = false;
  private busy = false;

  public constructor(public readonly filename: string) {}

  private identityOf(stat: Stats): string {
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  }

  public async prime(lookbackBytes = 0): Promise<void> {
    let file: fs.FileHandle | undefined;
    try {
      file = await fs.open(this.filename, "r");
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Log is not a regular file");
      this.offset = Math.max(0, stat.size - lookbackBytes);
      this.identity = this.identityOf(stat);
      if (this.offset) {
        const last = Buffer.alloc(1);
        await file.read(last, 0, 1, this.offset - 1);
        this.discardLine = last[0] !== 10;
      }
      this.status = "watching";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.status = `waiting for ${basename(this.filename)}`;
    } finally {
      await file?.close();
    }
  }

  private consume(bytes: Buffer): string[] {
    const buffer = Buffer.concat([this.partial, bytes]);
    const lines: string[] = [];
    let start = 0;
    let end: number;
    while ((end = buffer.indexOf(10, start)) !== -1) {
      if (!this.discardLine && end - start <= 65536) {
        lines.push(buffer.subarray(start, end).toString("utf8").replace(/\r$/, ""));
      }
      this.discardLine = false;
      start = end + 1;
    }
    this.partial = Buffer.from(buffer.subarray(start));
    if (this.partial.length > 65536) {
      this.partial = Buffer.alloc(0);
      this.discardLine = true;
    }
    return lines;
  }

  public async readNewLines(): Promise<string[]> {
    if (this.busy) return [];
    this.busy = true;
    let file: fs.FileHandle | undefined;
    try {
      file = await fs.open(this.filename, "r");
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Log is not a regular file");
      const identity = this.identityOf(stat);
      if (identity !== this.identity || stat.size < this.offset) {
        this.offset = 0;
        this.partial = Buffer.alloc(0);
        this.discardLine = false;
      }
      this.identity = identity;
      this.status = "watching";
      // Bound work per poll. Remaining data is consumed on subsequent polls.
      const size = Math.min(256 * 1024, stat.size - this.offset);
      if (size <= 0) return [];
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, this.offset);
      this.offset += bytesRead;
      return this.consume(buffer.subarray(0, bytesRead));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.status = `waiting for ${basename(this.filename)}`;
      return [];
    } finally {
      try { await file?.close(); } finally { this.busy = false; }
    }
  }
}

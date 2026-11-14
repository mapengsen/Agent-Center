import * as path from "node:path";
import { LogTail } from "./logTail";

export interface FileWatcherFailure {
  root: string;
  timestamp: number;
  reason: string;
  failedPath?: string;
}

export type FileWatcherEvent = FileWatcherFailure | Pick<FileWatcherFailure, "root" | "timestamp">;

const LOG_BYTES = 256 * 1024;
const LOG_DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/;
const NEW_CONNECTION = /^\S+ \S+ \[info\] (?:\[[^\]]*\])*\[ExtensionHostConnection\] New connection established\.?$/;

async function readLogEnd(filename: string): Promise<string[]> {
  const tail = new LogTail(filename);
  await tail.prime(LOG_BYTES);
  return tail.readNewLines();
}

export async function findFileWatcherFailure(filename: string, remote: boolean, roots: readonly string[]): Promise<FileWatcherFailure | undefined> {
  const lines = await readLogEnd(filename);
  let start = 0;
  let earliest = 0;
  if (remote) {
    let connection = lines.length - 1;
    while (connection >= 0 && !NEW_CONNECTION.test(lines[connection])) connection--;
    if (connection < 0) return;
    start = connection + 1;
  } else {
    const renderer = await readLogEnd(path.join(path.dirname(filename), "renderer.log"));
    const launch = renderer.reverse().find(line => line.endsWith(` [info] Started local extension host with pid ${process.pid}.`));
    const date = launch?.match(LOG_DATE)?.[0];
    if (!date) return;
    earliest = new Date(date.replace(" ", "T")).getTime();
    if (!Number.isFinite(earliest)) return;
  }
  const keys = new Set(roots.map(root => fileWatcherPathKey(root)));
  const latestByRoot = new Map<string, FileWatcherEvent>();
  for (const line of lines.slice(start)) {
    const event = parseFileWatcherEvent(line);
    if (!event || event.timestamp < earliest) continue;
    const key = fileWatcherPathKey(event.root);
    if (keys.has(key)) latestByRoot.set(key, event);
  }
  let failure: FileWatcherFailure | undefined;
  for (const event of latestByRoot.values()) {
    if ("reason" in event && (!failure || event.timestamp >= failure.timestamp)) failure = event;
  }
  return failure;
}

export function resolveFileWatcherLog(logPath: string, remote: boolean, paths = path): string | undefined {
  if (!paths.isAbsolute(logPath)) return;
  const host = paths.dirname(logPath);
  const parent = paths.dirname(host);
  if (remote && /^exthost\d*$/.test(paths.basename(host))) {
    return paths.join(parent, "remoteagent.log");
  }
  if (!remote && paths.basename(host) === "exthost" && /^window\d+$/.test(paths.basename(parent))) {
    return paths.join(parent, "fileWatcher.log");
  }
}

export function fileWatcherPathKey(value: string, paths = path): string {
  const normalized = paths.resolve(value);
  return paths.sep === "\\" ? normalized.toLowerCase() : normalized;
}

export function parseFileWatcherEvent(line: string, paths = path): FileWatcherEvent | undefined {
  const record = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[(error|warning|trace)\] \[File Watcher \('parcel'\)\] (.+)$/.exec(line);
  if (!record) return;
  const [, date, level, message] = record;
  const timestamp = new Date(date.replace(" ", "T")).getTime();
  if (!Number.isFinite(timestamp)) return;

  if (level === "trace") {
    const started = /^Started watching: '(.+)' with backend '/.exec(message)?.[1];
    if (started && paths.isAbsolute(started)) return { root: started, timestamp };
    return;
  }
  // A failed stop is a cleanup error. Root deletion is logged as a warning.
  if (message.startsWith("Unexpected error stopping watcher:") ||
      (level === "warning" && !message.startsWith("Watcher shutdown because watched path got deleted"))) return;
  const watched = /^(.+) \(path: (.+)\)$/.exec(message);
  if (!watched || !paths.isAbsolute(watched[2])) return;
  const [, reason, root] = watched;
  const registration = /^Unexpected error: inotify_add_watch on '(.+)' failed: (.+)$/.exec(reason);
  if (registration && paths.isAbsolute(registration[1])) {
    return { root, timestamp, failedPath: registration[1], reason: registration[2].slice(0, 600) };
  }
  return { root, timestamp, reason: reason.slice(0, 600) };
}

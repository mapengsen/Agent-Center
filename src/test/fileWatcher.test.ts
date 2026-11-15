import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as vm from "node:vm";
import { findFileWatcherFailure, parseFileWatcherEvent, resolveFileWatcherLog } from "../fileWatcherLog";
import type { probeFileWatchers } from "../fileWatcherProbe";
import type { FileWatcherStatusMonitor } from "../fileWatcherStatus";

const date = "2026-11-13 06:30:50.000";
const timestamp = new Date(date.replace(" ", "T")).getTime();
const record = (detail: string, level = "error") => `${date} [${level}] [File Watcher ('parcel')] ${detail}\n`;
const failure = (root: string) => record(`Inotify limit reached (ENOSPC) (path: ${root})`);
const connection = `${date} [info] [127.0.0.1][12345678][ExtensionHostConnection] New connection established.\n`;
const uri = (fsPath: string) => ({ scheme: "file", fsPath });

test("resolves only the current remote session or local window watcher log", () => {
  assert.equal(resolveFileWatcherLog("/server/data/logs/session/exthost4/pengsen.agent-center", true, path.posix),
    "/server/data/logs/session/remoteagent.log");
  assert.equal(resolveFileWatcherLog("D:\\Logs\\session\\window3\\exthost\\pengsen.agent-center", false, path.win32),
    "D:\\Logs\\session\\window3\\fileWatcher.log");
  assert.equal(resolveFileWatcherLog("/server/data/logs/session/exthost4/pengsen.agent-center", false, path.posix), undefined);
  assert.equal(resolveFileWatcherLog("logs/exthost4/pengsen.agent-center", true, path.posix), undefined);
});

test("extracts the watched workspace and failed directory from the reported inotify error", () => {
  const root = "/cyk/mps/project (draft)";
  const failedPath = `${root}/write_paper/mapengsen-skills`;
  const line = record(`Unexpected error: inotify_add_watch on '${failedPath}' failed: No such file or directory (EUNKNOWN) (path: ${root})`).trimEnd();
  assert.deepEqual(parseFileWatcherEvent(line, path.posix), { root, failedPath, timestamp, reason: "No such file or directory (EUNKNOWN)" });
  assert.equal(parseFileWatcherEvent(line.replace("[error]", "[info]"), path.posix), undefined);
  assert.equal(parseFileWatcherEvent(line.replace("[File Watcher ('parcel')]", "[Git]"), path.posix), undefined);
  assert.equal(parseFileWatcherEvent(record(`Unexpected error stopping watcher: Invalid argument (path: ${root})`).trimEnd(), path.posix), undefined);
  assert.deepEqual(parseFileWatcherEvent(record(`Watcher shutdown because watched path got deleted (path: ${root})`, "warning").trimEnd(), path.posix),
    { root, timestamp, reason: "Watcher shutdown because watched path got deleted" });
});

test("restricts remote error details to the latest connection and the affected root", async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-center-watcher-log-test-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, "workspace");
  const other = workspace + "-other";
  const log = path.join(temporary, "remoteagent.log");
  await fs.writeFile(log, failure(workspace));
  assert.equal(await findFileWatcherFailure(log, true, [workspace]), undefined);
  await fs.appendFile(log, connection + failure(workspace) + connection + failure(other));
  assert.equal(await findFileWatcherFailure(log, true, [workspace]), undefined);
  await fs.appendFile(log, failure(workspace) + failure(other));
  assert.equal((await findFileWatcherFailure(log, true, [workspace]))?.root, workspace);
});

test("probe subscribes to existing workspace events and removes its temporary files", async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-center-watcher-probe-test-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  let created: (resource: ReturnType<typeof uri>) => void;
  let disposed = 0;
  const entry = require.resolve("../fileWatcherProbe");
  const nativeRequire = createRequire(entry);
  const module = { exports: {} as { probeFileWatchers: typeof probeFileWatchers } };
  vm.runInNewContext(await fs.readFile(entry, "utf8"), {
    exports: module.exports,
    AbortSignal, AbortController,
    require: (id: string) => {
      if (id === "node:fs/promises") return {
        ...fs,
        open: async (target: string, flags: string, mode: number) => {
          const handle = await fs.open(target, flags, mode);
          created(uri(target + "-other"));
          if (emitEvent) created(uri(target));
          return handle;
        },
      };
      if (id !== "vscode") return nativeRequire(id);
      return {
        Uri: { joinPath: (root: ReturnType<typeof uri>, name: string) => uri(path.join(root.fsPath, name)) },
        workspace: {
          createFileSystemWatcher: (glob: string, ignoreCreate: boolean, ignoreChange: boolean, ignoreDelete: boolean) => {
            assert.match(glob, /^\*\*\/\.agent-center-watch-/);
            assert.deepEqual([ignoreCreate, ignoreChange, ignoreDelete], [false, true, true]);
            return {
              onDidCreate: (listener: typeof created) => { created = listener; return { dispose: () => disposed++ }; },
              dispose: () => disposed++,
            };
          },
        },
      };
    },
  });
  const roots = [uri(temporary)] as unknown as Parameters<typeof probeFileWatchers>[0];
  let emitEvent = true;
  const probe = () => module.exports.probeFileWatchers(roots, new AbortController().signal, 25);
  assert.equal((await probe())[0].status, "passed");
  assert.deepEqual(await fs.readdir(temporary), []);
  emitEvent = false;
  assert.equal((await probe())[0].status, "no event");
  assert.deepEqual(await fs.readdir(temporary), []);
  assert.equal(disposed, 4);
});

test("startup uses bounded backoff, retries unresolved roots and clears warnings when events arrive", async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-center-watcher-test-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, "workspace");
  const other = path.join(temporary, "other");
  const log = path.join(temporary, "remoteagent.log");
  await fs.writeFile(log, failure(workspace) + connection);

  let visible = false;
  let enabled = true;
  let pendingCheck: { check: () => Promise<void>; delay: number } | undefined;
  let reload: () => Promise<void>;
  const invoked: string[] = [];
  let logReads = 0;
  const testedRoots: string[][] = [];
  const bar = { text: "", show() { visible = true; }, hide() { visible = false; }, dispose() {} };
  let probeStatus: Awaited<ReturnType<typeof probeFileWatchers>>[number]["status"] = "passed";
  const entry = require.resolve("../fileWatcherStatus");
  const nativeRequire = createRequire(entry);
  const module = { exports: {} as { FileWatcherStatusMonitor: typeof FileWatcherStatusMonitor } };
  vm.runInNewContext(await fs.readFile(entry, "utf8"), {
    exports: module.exports,
    AbortController,
    require: (id: string) => id === "vscode" ? {
      StatusBarAlignment: { Right: 2 },
      ThemeColor: class {},
      MarkdownString: class {
        public appendText() { return this; }
        public appendMarkdown() { return this; }
      },
      window: { createStatusBarItem: () => bar },
      env: { remoteName: "ssh-remote" },
      workspace: {
        workspaceFolders: [{ uri: uri(workspace) }, { uri: uri(other) }],
        isTrusted: true,
        getConfiguration: () => ({ get: () => enabled }),
      },
      commands: {
        registerCommand: (_: string, action: typeof reload) => { reload = action; return { dispose() {} }; },
        executeCommand: async (command: string) => invoked.push(command),
      },
    } : id === "./fileWatcherProbe" ? {
      probeFileWatchers: async (roots: Parameters<typeof probeFileWatchers>[0]) => {
        testedRoots.push(Array.from(roots, root => root.fsPath));
        return roots.map(root => ({ root: root.fsPath, status: root.fsPath === workspace ? probeStatus : "passed" }));
      },
    } : id === "./fileWatcherLog" ? {
      fileWatcherPathKey: nativeRequire("./fileWatcherLog").fileWatcherPathKey,
      resolveFileWatcherLog,
      findFileWatcherFailure: (...args: Parameters<typeof findFileWatcherFailure>) => { logReads++; return findFileWatcherFailure(...args); },
    } : nativeRequire(id),
    setTimeout: (callback: () => Promise<void>, delay: number) => {
      pendingCheck = { check: callback, delay };
      return { unref() { return this; } };
    },
    clearTimeout() { pendingCheck = undefined; },
  });

  const monitor = new module.exports.FileWatcherStatusMonitor({
    logUri: { fsPath: path.join(temporary, "exthost3", "pengsen.agent-center") },
  } as unknown as ConstructorParameters<typeof FileWatcherStatusMonitor>[0]);
  t.after(() => monitor.dispose());

  const runTimer = async (delay: number) => {
    const timer = pendingCheck;
    assert.ok(timer);
    assert.equal(timer.delay, delay);
    pendingCheck = undefined;
    await timer.check();
  };
  const startup = () => {
    monitor.scheduleStartupCheck();
    assert.equal(visible, false);
    return runTimer(90_000);
  };
  const status = () => (monitor.getDiagnostics() as { status: string }).status;

  await startup();
  assert.equal(visible, false);
  assert.equal(logReads, 0);
  assert.equal(status(), "passed");
  assert.equal(pendingCheck, undefined);

  probeStatus = "no event";
  await startup();
  assert.equal(visible, true);
  assert.equal(status(), "waiting for file events");
  assert.equal(bar.text, "$(clock) 等待文件监视");
  assert.equal(logReads, 1);
  assert.equal((monitor.getDiagnostics() as { failure?: unknown }).failure, undefined);
  await reload!();
  assert.deepEqual(invoked, []);

  await fs.appendFile(log, failure(workspace));
  await runTimer(30_000);
  assert.deepEqual(testedRoots.at(-1), [workspace]);
  assert.equal(bar.text, "$(warning) 文件监视异常");
  assert.equal((monitor.getDiagnostics() as { failure: { root: string } }).failure.root, workspace);
  await reload!();
  assert.deepEqual(invoked, ["workbench.action.reloadWindow"]);

  probeStatus = "passed";
  await runTimer(60_000);
  assert.equal(visible, false);
  assert.equal(status(), "passed");
  assert.equal(pendingCheck, undefined);
  assert.equal(logReads, 2);
  assert.equal((monitor.getDiagnostics() as { failure?: unknown }).failure, undefined);

  await fs.appendFile(log, connection);
  probeStatus = "no event";
  await startup();
  for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000]) await runTimer(delay);
  assert.equal(status(), "file events unconfirmed");
  assert.equal(bar.text, "$(info) 文件监视未确认");
  assert.equal(pendingCheck, undefined);

  probeStatus = "unavailable";
  await startup();
  assert.equal(visible, false);
  assert.equal(logReads, 8);
  assert.equal(status(), "probe unavailable");

  probeStatus = "no event";
  await startup();
  assert.ok(pendingCheck);
  enabled = false;
  monitor.scheduleStartupCheck();
  assert.equal(visible, false);
  assert.equal(pendingCheck, undefined);
  assert.equal(status(), "disabled");
});

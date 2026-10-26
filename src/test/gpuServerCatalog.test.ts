import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as vm from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import * as path from "node:path";

async function harness() {
  const events = new EventEmitter(), watchers: EventEmitter[] = [];
  const uri = (value: string) => ({ fsPath: value, toString: () => value });
  const folder = (value: string) => ({ uri: uri(value), name: value, index: 0 });
  const roots = [folder("/workspace/a"), folder("/workspace/b")];
  let active = roots[0], text = "40901: ssh root@host -p 22 密码：private", exists = true, size = 100, reads = 0, enabled = true;
  let read: (() => Promise<Uint8Array>) | undefined;
  const listen = (event: string, listener: () => void) => { events.on(event, listener); return { dispose: () => events.off(event, listener) }; };
  class FileSystemError extends Error { public code = "FileNotFound"; }
  const vscode = {
    FileSystemError,
    Uri: { joinPath: (base: any, name: string) => uri(base.fsPath + "/" + name) },
    RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
    EventEmitter: class {
      private listeners = new Set<() => void>();
      public event = (listener: () => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
      public fire() { for (const listener of this.listeners) listener(); }
      public dispose() { this.listeners.clear(); }
    },
    window: { activeTextEditor: { document: { uri: roots[0].uri } }, onDidChangeActiveTextEditor: (listener: () => void) => listen("editor", listener) },
    workspace: { isTrusted: true, workspaceFolders: roots, getWorkspaceFolder: () => active, getConfiguration: () => ({ get: () => enabled }),
      onDidChangeWorkspaceFolders: (listener: () => void) => listen("folders", listener),
      fs: { stat: async () => { if (!exists) throw new FileSystemError(); return { size }; }, readFile: async () => { reads++; return read ? read() : Buffer.from(text); } },
      createFileSystemWatcher: () => {
        const emitter = new EventEmitter(); watchers.push(emitter);
        const on = (event: string) => (listener: () => void) => { emitter.on(event, listener); return { dispose: () => emitter.off(event, listener) }; };
        return { onDidChange: on("change"), onDidCreate: on("create"), onDidDelete: on("delete"), dispose: () => emitter.removeAllListeners() };
      } },
  };
  const entry = require.resolve("../gpuServerCatalog"), realRequire = createRequire(entry);
  const module = { exports: {} as typeof import("../gpuServerCatalog") };
  vm.runInNewContext(await fs.readFile(entry, "utf8"), { module, exports: module.exports, Buffer,
    require: (name: string) => name === "vscode" ? vscode : realRequire(name) });
  const catalog = new module.exports.WorkspaceGpuServers();
  return { catalog, vscode, events, watchers, reads: () => reads, setText: (value: string) => { text = value; },
    setRead: (value: typeof read) => { read = value; }, setSize: (value: number) => { size = value; },
    setExists: (value: boolean) => { exists = value; }, setEnabled: (value: boolean) => { enabled = value; },
    changeRoot: () => { active = roots[1]; events.emit("editor"); } };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("catalog reads the current root, watches edits/deletes and reports only safe parser errors", async t => {
  const h = await harness(); t.after(() => h.catalog.dispose());
  let changes = 0; h.catalog.onDidChange(() => changes++);
  await h.catalog.reload(); assert.equal(h.catalog.servers[0].name, "40901"); assert.equal(changes, 1);
  await h.catalog.reload(); assert.equal(changes, 1);
  h.setText('new: ssh -i "private keys/id_rsa" user@host -p 22\nbad: ssh root@host -p 0 密码：private');
  h.watchers[0].emit("change"); await flush();
  assert.equal(h.catalog.servers[0].privateKeyPath, path.resolve("/workspace/a", "private keys/id_rsa"));
  assert.match(h.catalog.detail, /1 行/); assert.doesNotMatch(h.catalog.detail, /密码|private/);
  h.setExists(false); h.watchers[0].emit("delete"); await flush();
  assert.equal(h.catalog.servers.length, 0); assert.equal(h.catalog.detail, "");
});

test("catalog rejects oversized files, skips untrusted/disabled reads and discards stale workspace results", async t => {
  const h = await harness(); t.after(() => h.catalog.dispose());
  h.vscode.workspace.isTrusted = false; await h.catalog.reload(); assert.equal(h.reads(), 0);
  h.vscode.workspace.isTrusted = true; h.setEnabled(false); await h.catalog.reload(); assert.equal(h.reads(), 0);
  h.setEnabled(true); h.setSize(300000); await h.catalog.reload(); assert.equal(h.reads(), 0); assert.match(h.catalog.detail, /256 KiB/);
  h.setSize(100);
  let finish!: (value: Uint8Array) => void;
  h.setRead(() => new Promise(resolve => { finish = resolve; }));
  const old = h.catalog.reload(); await flush();
  h.setRead(undefined); h.setText("new: ssh root@new-host -p 22 密码：private");
  h.changeRoot(); await flush();
  finish(Buffer.from("old: ssh root@old-host -p 22 密码：private")); await old;
  assert.equal(h.catalog.servers[0].name, "new"); assert.equal(h.watchers[0].listenerCount("change"), 0);
  h.catalog.dispose(); await h.catalog.reload(); assert.equal(h.catalog.servers.length, 0);
});

import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as vm from "node:vm";
import { createRequire } from "node:module";
import type { TextEditorLinkOptions, TextEditorLinkRecovery, TextEditorLinkResult } from "../textEditorLinks";
import { DEFAULT_LINK_EXTENSIONS } from "../linkFormats";

class Resource {
  public readonly fsPath: string;
  public readonly path: string;
  constructor(public readonly name: string, public readonly scheme = "file") {
    this.fsPath = path.join(os.tmpdir(), name);
    this.path = this.fsPath.replaceAll("\\", "/");
  }
  toString(): string { return `${this.scheme}:${this.path}`; }
}
class TextInput { constructor(public readonly uri: Resource) {} }
class CustomInput { constructor(public readonly uri: Resource) {} }
class NotebookInput { constructor(public readonly uri: Resource) {} }
class DiffInput { constructor(public readonly modified: Resource) {} }
interface Tab { input: TextInput | CustomInput | NotebookInput | DiffInput; isDirty: boolean }
interface Document { uri: Resource; isDirty: boolean; isClosed: boolean }

async function setup(t: TestContext, extension = "pdf", extensions?: readonly string[]) {
  const resource = new Resource(`论文 图 & special.${extension}`);
  const document: Document = { uri: resource, isDirty: false, isClosed: false };
  const original: Tab = { input: new TextInput(resource), isDirty: false };
  const state = {
    active: true, now: 10000, prepared: [] as string[], opened: [] as string[],
    closed: [] as Tab[][], results: [] as TextEditorLinkResult[], order: [] as string[],
    closeAllowed: true, prepareError: false, openError: false,
    onPrepare: async () => {}, onOpen: () => {}, onClose: () => {},
  };
  const activeEvents = new Set<() => void>();
  const tabEvents = new Set<(event: { opened: Tab[]; changed: Tab[] }) => void>();
  let pending: (() => void) | undefined;
  const group = { activeTab: original as Tab | undefined, tabs: [original] };
  const window = {
    activeTextEditor: { document } as { document: Document } | undefined,
    onDidChangeActiveTextEditor: (listener: () => void) => {
      activeEvents.add(listener); return { dispose: () => activeEvents.delete(listener) };
    },
    tabGroups: {
      activeTabGroup: group, all: [group],
      onDidChangeTabs: (listener: (event: { opened: Tab[]; changed: Tab[] }) => void) => {
        tabEvents.add(listener); return { dispose: () => tabEvents.delete(listener) };
      },
      close: async (tabs: Tab[], preserveFocus: boolean) => {
        assert.equal(preserveFocus, true);
        state.order.push("close");
        state.closed.push([...tabs]);
        if (!state.closeAllowed) return false;
        group.tabs = group.tabs.filter(tab => !tabs.includes(tab));
        group.activeTab = undefined;
        window.activeTextEditor = undefined;
        state.onClose();
        return true;
      },
    },
  };
  const vscode = { window, env: { remoteName: "ssh-remote" }, TabInputText: TextInput, TabInputCustom: CustomInput, TabInputNotebook: NotebookInput };
  const entry = path.resolve(__dirname, "../textEditorLinks.js");
  const nativeRequire = createRequire(entry);
  const module = { exports: {} as { TextEditorLinkRecovery: new (options: TextEditorLinkOptions) => TextEditorLinkRecovery } };
  vm.runInNewContext(await fs.readFile(entry, "utf8"), {
    module, exports: module.exports,
    require: (name: string) => name === "vscode" ? vscode : nativeRequire(name),
    setTimeout: (callback: () => void) => { pending = callback; return { unref() {} }; },
    clearTimeout: () => { pending = undefined; },
    Date: class extends Date { static now() { return state.now; } },
  }, { filename: entry });
  const listener = new module.exports.TextEditorLinkRecovery({
    extensions,
    isActive: () => state.active,
    prepare: async target => {
      state.order.push("prepare"); state.prepared.push(target);
      await state.onPrepare();
      if (state.prepareError) throw new Error("CLI not found");
      return async () => {
        state.order.push("code -r"); state.opened.push(target);
        if (state.openError) throw new Error("CLI disconnected");
        state.onOpen();
      };
    },
    onResult: result => state.results.push(result),
  });
  t.after(() => listener.dispose());
  return {
    listener, state, window, group, original, document, resource, activeEvents, tabEvents,
    hasPending: () => !!pending,
    showText: () => {
      const tab = { input: new TextInput(resource), isDirty: false };
      group.tabs.push(tab); group.activeTab = tab;
      window.activeTextEditor = { document: { uri: resource, isDirty: false, isClosed: false } };
      activeEvents.forEach(event => event());
      return tab;
    },
  };
}

test("all supported formats opened as text are closed before CLI recovery without a failure log", async t => {
  for (const format of DEFAULT_LINK_EXTENSIONS.map(extension => extension.slice(1))) {
    const h = await setup(t, format);
    const duplicate: Tab = { input: new TextInput(h.resource), isDirty: false };
    const unrelated: Tab = { input: new TextInput(new Resource("source.ts")), isDirty: false };
    const viewer: Tab = { input: new CustomInput(h.resource), isDirty: false };
    const diff: Tab = { input: new DiffInput(h.resource), isDirty: false };
    h.group.tabs.push(duplicate, unrelated, viewer, diff);
    assert.equal(h.hasPending(), true);
    await h.listener.recoverActiveEditor();
    assert.deepEqual(h.state.order, ["prepare", "close", "code -r"]);
    assert.deepEqual(h.state.closed[0], [h.original, duplicate]);
    assert.deepEqual(h.group.tabs, [unrelated, viewer, diff]);
    assert.deepEqual(h.state.opened, [h.resource.fsPath]);
    assert.equal(h.state.results[0].status, "opened");
  }
});

test("dirty documents, dirty duplicate tabs, custom editors and diffs stay untouched", async t => {
  for (const scenario of ["dirty-document", "dirty-tab", "dirty-duplicate", "custom", "notebook", "diff", "inactive", "other-format", "virtual-uri"]) {
    const h = await setup(t);
    if (scenario === "dirty-document") h.document.isDirty = true;
    if (scenario === "dirty-tab") h.original.isDirty = true;
    if (scenario === "dirty-duplicate") h.group.tabs.push({ input: new TextInput(h.resource), isDirty: true });
    if (scenario === "custom") h.original.input = new CustomInput(h.resource);
    if (scenario === "notebook") h.original.input = new NotebookInput(h.resource);
    if (scenario === "diff") h.original.input = new DiffInput(h.resource);
    if (scenario === "inactive") h.state.active = false;
    if (scenario === "other-format") h.document.uri = new Resource("source.ts");
    if (scenario === "virtual-uri") h.document.uri = new Resource("figure.pdf", "git");
    await h.listener.recoverActiveEditor();
    assert.equal(h.state.closed.length, 0, scenario);
    assert.equal(h.state.opened.length, 0, scenario);
  }
});

test("a focus change, edit or disable while preparing cancels recovery before closing", async t => {
  for (const scenario of ["disable", "edit", "switch-tab"]) {
    const h = await setup(t);
    h.state.onPrepare = async () => {
      if (scenario === "disable") h.state.active = false;
      if (scenario === "edit") h.document.isDirty = true;
      if (scenario === "switch-tab") h.group.activeTab = { input: new TextInput(new Resource("another.pdf")), isDirty: false };
    };
    await h.listener.recoverActiveEditor();
    assert.equal(h.state.closed.length, 0, scenario);
    assert.equal(h.state.opened.length, 0, scenario);
  }
});

test("a missing CLI preserves the source tab and a cancelled close never launches code", async t => {
  const missing = await setup(t);
  missing.state.prepareError = true;
  await missing.listener.recoverActiveEditor();
  assert.equal(missing.state.closed.length, 0);
  assert.equal(missing.state.results[0].status, "failed");
  const cancelled = await setup(t);
  cancelled.state.closeAllowed = false;
  await cancelled.listener.recoverActiveEditor();
  assert.equal(cancelled.state.opened.length, 0);
  assert.equal(cancelled.state.results[0].status, "failed");
});

test("a CLI that returns another text tab cannot create a close/reopen loop", async t => {
  for (const extension of ["pdf", "md", "csv", "toml", "json", "txt"]) {
    const h = await setup(t, extension);
    h.state.onOpen = () => { h.state.now += 6000; h.showText(); };
    await h.listener.recoverActiveEditor();
    await h.listener.recoverActiveEditor();
    h.state.now += 6000;
    await h.listener.recoverActiveEditor();
    assert.equal(h.state.opened.length, 1, extension);
    assert.equal(h.state.closed.length, 1, extension);
  }
});

test("formats removed from the configured list are not closed or reopened", async t => {
  for (const extensions of [[], [".pdf"]]) {
    const h = await setup(t, "toml", extensions);
    await h.listener.recoverActiveEditor();
    assert.equal(h.state.closed.length, 0);
    assert.equal(h.state.opened.length, 0);
  }
});

test("native notebook results allow another text-open request without touching the notebook", async t => {
  const h = await setup(t, "ipynb");
  h.state.onOpen = () => {
    const notebook = { input: new NotebookInput(h.resource), isDirty: false };
    h.group.tabs.push(notebook); h.group.activeTab = notebook;
    h.tabEvents.forEach(event => event({ opened: [notebook], changed: [] }));
  };
  await h.listener.recoverActiveEditor();
  h.showText();
  await h.listener.recoverActiveEditor();
  assert.equal(h.state.opened.length, 2);
  assert.ok(h.state.closed.every(tabs => tabs.every(tab => tab.input instanceof TextInput)));
});

test("a successful viewer allows another Codex text-open to be recovered immediately", async t => {
  const h = await setup(t);
  h.state.onOpen = () => {
    const viewer = { input: new CustomInput(h.resource), isDirty: false };
    h.group.tabs.push(viewer); h.group.activeTab = viewer;
    h.tabEvents.forEach(event => event({ opened: [viewer], changed: [] }));
  };
  await h.listener.recoverActiveEditor();
  h.showText();
  await h.listener.recoverActiveEditor();
  assert.equal(h.state.opened.length, 2);
});

test("concurrent events are deduplicated and disposal cancels pending work", async t => {
  const h = await setup(t);
  let finish: (() => void) | undefined;
  h.state.onPrepare = () => new Promise<void>(resolve => { finish = resolve; });
  const first = h.listener.recoverActiveEditor();
  await h.listener.recoverActiveEditor();
  h.listener.dispose();
  finish!();
  await first;
  assert.equal(h.state.prepared.length, 1);
  assert.equal(h.state.closed.length, 0);
  assert.equal(h.hasPending(), false);
  assert.equal(h.activeEvents.size, 0);
  assert.equal(h.tabEvents.size, 0);
});

test("CLI errors are recorded without repeated attempts on the same tab", async t => {
  const h = await setup(t);
  h.state.openError = true;
  await h.listener.recoverActiveEditor();
  assert.equal(h.state.results[0].status, "failed");
  assert.match(h.state.results[0].error!, /CLI disconnected/);
  await h.listener.recoverActiveEditor();
  assert.equal(h.state.opened.length, 1);
});

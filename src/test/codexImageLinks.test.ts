import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { createRequire } from "node:module";
import { parseCodexImageOpenFailure, ImageLinkRecovery } from "../imageLinkRecovery";
import { LogTail } from "../logTail";
import { DEFAULT_LINK_EXTENSIONS, normalizeLinkExtensions, isSupportedLinkPath } from "../linkFormats";
import type { CodexImageLinkMonitor } from "../codexImageLinks";

const failure = (target: string) => `2026-09-29 12:00:00.000 [error] Failed to handle absolute path actionVerb=open normalized=${/\s/.test(target) ? JSON.stringify(target) : target}`;

async function temporary(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-center-images-test-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("agent-center-images-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return root;
}

test("recognizes only exact absolute-image failures, including spaces and Unicode", () => {
  for (const name of ["image.png", "图 表.PNG", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.bmp", "a.ico", "论文 图.PDF", "a.svg"]) {
    const target = "/project/" + name;
    assert.equal(parseCodexImageOpenFailure(failure(target), "linux"), target);
  }
  for (const target of ["C:\\My Figures\\图 one.png", "C:\\figures\\plot.png", "\\\\server\\share\\plot.png"]) {
    assert.equal(parseCodexImageOpenFailure(failure(target), "win32"), target);
  }
  assert.equal(parseCodexImageOpenFailure(failure("/project/image.png"), "win32"), undefined);
  for (const target of ["relative.png", "/a/source.py", "/a/image.png.exe", "https://example.org/a.png", "/a/a\n.png", "/a/a.pdf.exe", "https://example.org/a.svg"]) {
    assert.equal(parseCodexImageOpenFailure(failure(target), "linux"), undefined, target);
  }
  for (const line of [
    failure("/a.png").replace("actionVerb=open", "actionVerb=reveal"),
    failure("/a.png").replace("[error]", "[info]"),
    "mentioned " + failure("/a.png"),
    failure("/a.png") + " extra=field",
    failure("/a.png").replace("/a.png", '"/broken.png'),
  ]) assert.equal(parseCodexImageOpenFailure(line, "linux"), undefined);
});

test("every requested format is enabled in both runtime and settings defaults", async () => {
  const expected = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf", ".svg",
    ".md", ".markdown", ".mdx", ".rst", ".csv", ".tsv", ".html", ".htm", ".ipynb",
    ".tex", ".bib", ".txt", ".log", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml",
    ".docx", ".xlsx", ".pptx"];
  assert.deepEqual(DEFAULT_LINK_EXTENSIONS, expected);
  const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, "../../package.json"), "utf8"));
  assert.deepEqual(manifest.contributes.configuration.properties["agentStatus.codexImageLinks.extensions"].default, expected);
  assert.equal(DEFAULT_LINK_EXTENSIONS.filter(ext => ext === ".toml").length, 1);
  for (const extension of expected) {
    const target = "/project/中文 文件" + extension.toUpperCase();
    assert.equal(parseCodexImageOpenFailure(failure(target), "linux"), target);
  }
});

test("custom extension lists normalize case and dots and exclude removed formats", async () => {
  const extensions = normalizeLinkExtensions([" TOML ", ".toml", ".CSV", "csv", "", "../bad", "a/b", "*", null]);
  assert.deepEqual(extensions, [".toml", ".csv"]);
  assert.equal(isSupportedLinkPath("C:\\工作\\config.TOML", extensions), true);
  assert.equal(parseCodexImageOpenFailure(failure("/project/a.csv"), "linux", extensions), "/project/a.csv");
  assert.equal(parseCodexImageOpenFailure(failure("/project/a.pdf"), "linux", extensions), undefined);
  assert.equal(parseCodexImageOpenFailure(failure("/project/a.csv"), "linux", []), undefined);
  assert.deepEqual(normalizeLinkExtensions(undefined), DEFAULT_LINK_EXTENSIONS);
  const opened: string[] = [];
  const recovery = new ImageLinkRecovery({ platform: "linux", extensions, isActive: () => true, isFile: async () => true, open: async target => opened.push(target) });
  assert.equal((await recovery.handle(failure("/a.md"))).status, "ignored");
  assert.equal((await recovery.handle(failure("/a.toml"))).status, "opened");
  assert.deepEqual(opened, ["/a.toml"]);
});

test("tail skips old history and delivers only complete new UTF-8 lines", async t => {
  const root = await temporary(t);
  const log = path.join(root, "Codex.log");
  await fs.writeFile(log, failure("/old.png") + "\n");
  const tail = new LogTail(log);
  await tail.prime();
  assert.deepEqual(await tail.readNewLines(), []);
  const bytes = Buffer.from(failure("/project/图片.png") + "\r\n");
  const split = bytes.indexOf(Buffer.from("图")) + 1;
  await fs.appendFile(log, bytes.subarray(0, split));
  assert.deepEqual(await tail.readNewLines(), []);
  await fs.appendFile(log, bytes.subarray(split));
  assert.deepEqual(await tail.readNewLines(), [failure("/project/图片.png")]);
  assert.deepEqual(await tail.readNewLines(), []);
});

test("tail handles late creation, old partial lines, rotation and truncation", async t => {
  const root = await temporary(t);
  const log = path.join(root, "Codex.log");
  const late = new LogTail(log);
  await late.prime();
  assert.equal(late.status, "waiting for Codex.log");
  await fs.writeFile(log, failure("/first.png") + "\n");
  assert.deepEqual(await late.readNewLines(), [failure("/first.png")]);
  await fs.appendFile(log, "old partial");
  const tail = new LogTail(log);
  await tail.prime();
  await fs.appendFile(log, " remainder\n" + failure("/new.png") + "\n");
  assert.deepEqual(await tail.readNewLines(), [failure("/new.png")]);
  await fs.rename(log, log + ".1");
  await fs.writeFile(log, failure("/rotated.png") + "\n");
  assert.deepEqual(await tail.readNewLines(), [failure("/rotated.png")]);
  await fs.writeFile(log, "short\n");
  assert.deepEqual(await tail.readNewLines(), ["short"]);
});

test("tail bounds each read and ignores overlong lines without false events", async t => {
  const root = await temporary(t);
  const log = path.join(root, "Codex.log");
  await fs.writeFile(log, "");
  const tail = new LogTail(log);
  await tail.prime();
  await fs.appendFile(log, Buffer.alloc(300000, 65));
  await fs.appendFile(log, "\n" + failure("/new.png") + "\n");
  assert.deepEqual(await tail.readNewLines(), []);
  assert.deepEqual(await tail.readNewLines(), [failure("/new.png")]);
});

test("recovery respects focus, deduplication, missing files and disable during lookup", async () => {
  const opened: string[] = [];
  let active = true;
  let now = 1000;
  let file = true;
  const recovery = new ImageLinkRecovery({ platform: "linux", isActive: () => active, isFile: async () => file, open: async target => opened.push(target), now: () => now });
  assert.equal((await recovery.handle(failure("/a.png"))).status, "opened");
  assert.equal((await recovery.handle(failure("/a.png"))).status, "duplicate");
  now += 1001;
  assert.equal((await recovery.handle(failure("/a.png"))).status, "opened");
  active = false;
  assert.equal((await recovery.handle(failure("/b.png"))).status, "ignored");
  active = true; file = false;
  assert.equal((await recovery.handle(failure("/b.png"))).status, "missing");
  const changed = new ImageLinkRecovery({ platform: "linux", isActive: () => active, isFile: async () => { active = false; return true; }, open: async () => assert.fail("Must not open after disable") });
  assert.equal((await changed.handle(failure("/c.png"))).status, "ignored");
  assert.deepEqual(opened, ["/a.png", "/a.png"]);
});

test("recovery reports lookup and editor failures without stopping later clicks", async () => {
  let fail = true;
  const recovery = new ImageLinkRecovery({
    platform: "linux", isActive: () => true,
    isFile: async target => { if (target === "/missing.png") throw new Error("FileNotFound"); return true; },
    open: async () => { if (fail) throw new Error("Editor unavailable"); },
  });
  assert.equal((await recovery.handle(failure("/missing.png"))).status, "failed");
  assert.equal((await recovery.handle(failure("/first.png"))).status, "failed");
  fail = false;
  assert.equal((await recovery.handle(failure("/next.png"))).status, "opened");
});

test("monitor opens appended failures, bounds diagnostics, and honors disable/trust/conflict", async t => {
  const root = await temporary(t);
  const codex = path.join(root, "logs", "openai.chatgpt");
  await fs.mkdir(codex, { recursive: true });
  const log = path.join(codex, "Codex.log");
  await fs.writeFile(log, failure(path.join(root, "old.png")) + "\n");
  const target = path.join(root, "test image.png");
  const bytes = Buffer.from([137, 80, 78, 71]);
  await fs.writeFile(target, bytes);
  const calls: unknown[][] = [];
  let enabled = true;
  let prototype = false;
  let override = "";
  let tick: (() => void) | undefined;
  let textListenerCount = 0;
  let reopenTextDocuments = true;
  let extensionsSetting: unknown = undefined;
  const uri = (value: string) => ({ scheme: "file", fsPath: value });
  const vscode = {
    window: { state: { focused: true } },
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === "enabled" ? enabled : key === "logFile" ? override : key === "reopenTextDocuments" ? reopenTextDocuments : key === "extensions" ? extensionsSetting ?? fallback : fallback }),
      fs: { stat: async (resource: { fsPath: string }) => ({ type: (await fs.stat(resource.fsPath)).isFile() ? 1 : 2 }) },
    },
    commands: { executeCommand: async () => assert.fail("Must use the CLI, not vscode.open") },
    extensions: { getExtension: (id: string) => id === "openai.chatgpt" ? { packageJSON: { version: "26.917.62051" } } : prototype ? {} : undefined },
    env: { remoteName: "ssh-remote", appRoot: path.join(root, "vscode-server") }, Uri: { file: uri }, FileType: { File: 1 },
  };
  const entry = path.resolve(__dirname, "../codexImageLinks.js");
  const source = await fs.readFile(entry, "utf8");
  const nativeRequire = createRequire(entry);
  const module = { exports: {} as { CodexImageLinkMonitor: new (context: unknown) => CodexImageLinkMonitor } };
  vm.runInNewContext(source, {
    require: (name: string) => name === "vscode" ? vscode : name === "./codeCli" ? {
      openWithCodeCli: async (...args: unknown[]) => { calls.push(args); },
    } : name === "./textEditorLinks" ? {
      TextEditorLinkRecovery: class {
        constructor() { textListenerCount++; }
        getDiagnostics() { return { enabled: true }; }
        dispose() { textListenerCount--; }
      },
    } : nativeRequire(name),
    module, exports: module.exports, process,
    setInterval: (callback: () => void) => { tick = callback; return { unref() {} }; },
    clearInterval: () => { tick = undefined; },
  }, { filename: entry, timeout: 1000 });
  const monitor = new module.exports.CodexImageLinkMonitor({ logUri: uri(path.join(root, "logs", "pengsen.codex-claude-agent-status")) });
  t.after(() => monitor.dispose());
  const diagnostics = () => monitor.getDiagnostics() as { status: string; opened: number; recentEvents: unknown[] };
  async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 4000;
    while (!condition()) {
      if (Date.now() > deadline) assert.fail("Timed out: " + JSON.stringify(diagnostics()));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  await monitor.restart();
  assert.equal(diagnostics().status, "watching");
  assert.equal(textListenerCount, 1);
  assert.equal(calls.length, 0);
  const appended = failure(target) + "\n";
  await fs.appendFile(log, appended);
  tick!();
  await until(() => diagnostics().opened === 1);
  assert.equal(calls.length, 1);
  assert.equal((calls[0][0] as { appRoot: string }).appRoot, vscode.env.appRoot);
  assert.equal((calls[0][0] as { remote: boolean }).remote, true);
  assert.equal(calls[0][1], target);
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal(await fs.readFile(log, "utf8"), failure(path.join(root, "old.png")) + "\n" + appended);
  for (const extension of ["pdf", "svg"]) {
    const document = path.join(root, `论文 图.${extension}`);
    await fs.writeFile(document, "test document");
    await fs.appendFile(log, failure(document) + "\n");
  }
  tick!();
  await until(() => diagnostics().opened === 3);
  assert.equal(calls[1][1], path.join(root, "论文 图.pdf"));
  assert.equal(calls[2][1], path.join(root, "论文 图.svg"));
  // Missing files produce diagnostics without opening editors or writing logs.
  await fs.appendFile(log, Array.from({ length: 45 }, (_, i) => failure(path.join(root, `missing-${i}.png`))).join("\n") + "\n");
  tick!();
  await until(() => diagnostics().recentEvents.length === 40);
  await monitor.restart(); // Cancels the old generation and seeks to EOF.
  assert.equal(textListenerCount, 1);
  assert.ok(diagnostics().recentEvents.length <= 40);
  assert.equal(calls.length, 3);
  enabled = false;
  await monitor.restart();
  assert.equal(diagnostics().status, "disabled");
  assert.equal(textListenerCount, 0);
  assert.equal(tick, undefined);
  enabled = true; vscode.workspace.isTrusted = false;
  await monitor.restart();
  assert.match(diagnostics().status, /untrusted/);
  vscode.workspace.isTrusted = true; prototype = true;
  await monitor.restart();
  assert.match(diagnostics().status, /standalone/);
  prototype = false; override = "relative.log";
  await monitor.restart();
  assert.match(diagnostics().status, /absolute path/);
  override = ""; reopenTextDocuments = false;
  await monitor.restart();
  assert.equal(diagnostics().status, "watching");
  assert.equal(textListenerCount, 0);
  extensionsSetting = ["TOML", ".toml"];
  await monitor.restart();
  const toml = path.join(root, "config.toml");
  await fs.writeFile(toml, "enabled = true");
  await fs.appendFile(log, failure(target) + "\n" + failure(toml) + "\n");
  tick!();
  await until(() => calls.length === 4);
  assert.equal(calls[3][1], toml);
  monitor.dispose();
  assert.equal(diagnostics().recentEvents.length, 0);
  assert.equal(await fs.readFile(entry, "utf8"), source);
});

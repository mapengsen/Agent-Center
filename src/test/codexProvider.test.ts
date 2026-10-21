import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as vm from "node:vm";
import { buildProviderConfig, getApiProvider, parseCodexConfig, validateProviderId } from "../codexProviderConfig";
import { findPython, runProviderHelper, resolveCodexHome, switchCodexProvider, type PythonCommand } from "../codexProviderService";

const script = path.resolve(__dirname, "../../resources/codex_provider_history.py");
const api = '[model_providers.beeapi]\nname = "My API"\nbase_url = "https://example.com/v1"\nexperimental_bearer_token = "secret-never-log"\n';
const official = 'model_provider = "openai"\nforced_login_method = "chatgpt"\n';

test("official selects ChatGPT authentication and preserves existing providers, comments and model", () => {
  const text = '# personal settings\nmodel_provider = "beeapi" # previous\nmodel = "my-model"\nforced_login_method = "api"\nopenai_base_url = "https://proxy.example/v1"\nchatgpt_base_url = "https://proxy.example/login"\n\n' + api;
  const changed = buildProviderConfig(text, "openai", undefined, {});
  const parsed = parseCodexConfig(changed);
  assert.equal(parsed.model_provider, "openai");
  assert.equal(parsed.forced_login_method, "chatgpt");
  assert.equal(parsed.openai_base_url, undefined);
  assert.equal(parsed.chatgpt_base_url, undefined);
  assert.equal(parsed.model, "my-model");
  assert.ok(changed.includes(api));
  assert.ok(changed.includes("# personal settings"));
});

test("API switching removes the forced ChatGPT login without changing API credentials", () => {
  const changed = buildProviderConfig(official + api, "beeapi");
  assert.equal(parseCodexConfig(changed).forced_login_method, undefined);
  assert.equal(parseCodexConfig(changed).model_provider, "beeapi");
  assert.ok(changed.endsWith(api));
});

test("root edits handle quoted keys, multiline strings, arrays and fake table headers", () => {
  const untouched = 'notes = """\n[not_a_table]\nmodel_provider = "do not edit me"\n"""\nitems = [\n"model_provider = x", # comment\n"y"\n]\n';
  const changed = buildProviderConfig('"model_provider" = "beeapi"\n\'forced_login_method\' = "api"\n' + untouched + api, "openai", undefined, {});
  assert.ok(changed.includes(untouched));
  assert.equal(parseCodexConfig(changed).model_provider, "openai");
});

test("root edits preserve CRLF and do not alter provider-local matching keys", () => {
  const text = ('model_provider = "beeapi"\n# keep\n' + api + '[projects."/tmp"]\nmodel_provider = "project-string"\n').replace(/\n/g, "\r\n");
  const changed = buildProviderConfig(text, "openai", undefined, {});
  assert.ok(changed.includes('[projects."/tmp"]\r\nmodel_provider = "project-string"\r\n'));
  assert.equal(changed.replace(/\r\n/g, "").includes("\n"), false);
});

test("new API IDs and keys are escaped safely and stored only in provider configuration", () => {
  const changed = buildProviderConfig('model = "unchanged"\n', "my.api-2", { baseUrl: "https://example.com/v1", apiKey: 'test"key\\value' });
  const parsed = parseCodexConfig(changed);
  assert.equal(parsed.model, "unchanged");
  assert.equal(parsed.model_provider, "my.api-2");
  assert.equal(getApiProvider(parsed, "my.api-2")?.experimental_bearer_token, 'test"key\\value');
  assert.equal(getApiProvider(parsed, "my.api-2")?.requires_openai_auth, false);
});

test("unsupported, missing and malformed provider definitions fail without exposing secrets", () => {
  assert.throws(() => buildProviderConfig(api, "missing"), /未找到/);
  assert.throws(() => buildProviderConfig(api + 'requires_openai_auth = true\n', "beeapi"), /OpenAI 登录/);
  assert.throws(() => buildProviderConfig('secret = "private-UNFINISHED', "openai"), (error: Error) => !error.message.includes("private-UNFINISHED"));
  assert.throws(() => buildProviderConfig('profile = "gateway"\n' + api, "beeapi"), /profile/);
  for (const id of ["openai", "OpenAI", "ollama", "../escape", "bee api", "x\nmodel = 1", ""]) assert.ok(validateProviderId(id));
  assert.equal(validateProviderId("beeapi"), undefined);
});

test("official switching refuses a custom API environment override", () => {
  assert.throws(() => buildProviderConfig(api, "openai", undefined, { OPENAI_BASE_URL: "https://secret@other.example" }), (error: Error) => /OPENAI_BASE_URL/.test(error.message) && !error.message.includes("secret"));
  assert.equal(parseCodexConfig(buildProviderConfig(api, "openai", undefined, { OPENAI_BASE_URL: "https://api.openai.com/v1" })).model_provider, "openai");
});

test("Codex home uses the extension host environment rather than the quota credential override", () => {
  assert.equal(resolveCodexHome({}, os.homedir()), path.join(os.homedir(), ".codex"));
  assert.equal(resolveCodexHome({ CODEX_HOME: "~/another-codex" }), path.join(os.homedir(), "another-codex"));
});

let python: PythonCommand;
async function getPython(): Promise<PythonCommand> { return python ??= await findPython(); }
async function runPython(source: string, input: unknown): Promise<unknown> {
  const command = await getPython();
  return JSON.parse(execFileSync(command.executable, [...command.args, "-c", source], {
    input: JSON.stringify(input), encoding: "utf8", windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  }));
}

const createDatabase = `import sqlite3,json,sys,pathlib
r=json.load(sys.stdin)
c=sqlite3.connect(str(pathlib.Path(r['home'])/r.get('name','state_5.sqlite')))
c.execute('PRAGMA journal_mode=WAL')
c.execute('CREATE TABLE threads(id TEXT PRIMARY KEY,model_provider TEXT,title TEXT,archived INTEGER,updated_at INTEGER,rollout_path TEXT)')
c.executemany('INSERT INTO threads VALUES(?,?,?,?,?,?)', [('a','openai','original title',0,100,'session-a'),('b','beeapi','archived title',1,200,'session-b'),('c','Other','third title',0,300,'session-c')])
c.execute('CREATE TABLE projection(thread_id TEXT,byte_offset INTEGER)')
c.execute('INSERT INTO projection VALUES(?,?)',('a',12345))
if r.get('reject'):c.execute("CREATE TRIGGER reject_provider BEFORE UPDATE OF model_provider ON threads BEGIN SELECT RAISE(ABORT,'private-trigger-secret'); END")
c.commit();c.close();print('{}')`;
const readDatabase = `import sqlite3,json,sys,pathlib
r=json.load(sys.stdin);c=sqlite3.connect(str(pathlib.Path(r['home'])/r.get('name','state_5.sqlite')))
print(json.dumps({'threads':c.execute('SELECT * FROM threads ORDER BY id').fetchall(),'offsets':c.execute('SELECT * FROM projection').fetchall(),'integrity':c.execute('PRAGMA integrity_check').fetchone()[0]}))`;

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-center-provider-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.writeFile(path.join(home, "config.toml"), official + api);
  return home;
}
function request(home: string, current: string, next: string, provider = "beeapi"): Record<string, unknown> {
  return { home, provider, expectedConfig: Buffer.from(current).toString("base64"), nextConfig: Buffer.from(next).toString("base64") };
}

test("switches every provider's history both ways, preserving bodies, auth, archives, ordering and offsets", async (t) => {
  const home = await fixture(t);
  await runPython(createDatabase, { home });
  const original = await runPython(readDatabase, { home }) as { threads: unknown[][]; offsets: unknown[]; integrity: string };
  await fs.mkdir(path.join(home, "sessions"));
  await fs.writeFile(path.join(home, "sessions", "session-a.jsonl"), 'immutable conversation bytes\n');
  await fs.writeFile(path.join(home, "auth.json"), '{"tokens":{"access_token":"keep-official-login"}}');
  const progress: string[] = [];
  const switched = await switchCodexProvider({ home, provider: "beeapi", scriptPath: script, onProgress: (value) => progress.push(value) });
  assert.equal(switched.threadCount, 3);
  assert.equal(switched.changedCount, 2);
  assert.equal(progress.length, 2);
  let state = await runPython(readDatabase, { home }) as typeof original;
  assert.ok(state.threads.every((row) => row[1] === "beeapi"));
  assert.deepEqual(state.threads.map((row) => row.slice(2)), original.threads.map((row) => row.slice(2)));
  assert.deepEqual(state.offsets, original.offsets);
  assert.equal(state.integrity, "ok");
  const snapshot = await runPython(readDatabase, { home: switched.backupDirectory }) as typeof original;
  assert.deepEqual(snapshot.threads, original.threads);
  await switchCodexProvider({ home, provider: "openai", scriptPath: script });
  state = await runPython(readDatabase, { home }) as typeof original;
  assert.ok(state.threads.every((row) => row[1] === "openai"));
  assert.equal(await fs.readFile(path.join(home, "sessions", "session-a.jsonl"), "utf8"), 'immutable conversation bytes\n');
  assert.equal(await fs.readFile(path.join(home, "auth.json"), "utf8"), '{"tokens":{"access_token":"keep-official-login"}}');
});

test("a rejected SQLite update rolls back other databases and leaves configuration intact", async (t) => {
  const home = await fixture(t);
  await runPython(createDatabase, { home, name: "state_4.sqlite" });
  await runPython(createDatabase, { home, reject: true });
  const before = await runPython(readDatabase, { home, name: "state_4.sqlite" });
  await assert.rejects(switchCodexProvider({ home, provider: "beeapi", scriptPath: script }), (error: Error) => !error.message.includes("private-trigger-secret"));
  assert.deepEqual(await runPython(readDatabase, { home, name: "state_4.sqlite" }), before);
  assert.equal(await fs.readFile(path.join(home, "config.toml"), "utf8"), official + api);
  await assert.rejects(fs.access(path.join(home, "agent-center/provider-switch.lock")));
});

test("live WAL data is included in backups while another connection remains open", async (t) => {
  const home = await fixture(t);
  await runPython(createDatabase, { home });
  const command = await getPython();
  const writer = spawn(command.executable, [...command.args, "-u", "-c", `import sqlite3,sys,json,pathlib
r=json.loads(sys.stdin.readline());c=sqlite3.connect(str(pathlib.Path(r['home'])/'state_5.sqlite'))
c.execute('PRAGMA wal_autocheckpoint=0');c.execute("UPDATE threads SET title='latest WAL title' WHERE id='a'");c.commit()
print('ready',flush=True);sys.stdin.readline();c.close()`], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { writer.kill(); });
  writer.stderr.resume();
  const ready = new Promise<void>((resolve, reject) => { writer.stdout.once("data", () => resolve()); writer.once("error", reject); });
  writer.stdin.write(JSON.stringify({ home }) + "\n");
  await ready;
  assert.ok((await fs.stat(path.join(home, "state_5.sqlite-wal"))).size > 0);
  const result = await switchCodexProvider({ home, provider: "beeapi", scriptPath: script });
  const backup = await runPython(readDatabase, { home: result.backupDirectory }) as { threads: unknown[][] };
  assert.equal(backup.threads[0][2], "latest WAL title");
  assert.equal(backup.threads[0][1], "openai");
  const closed = new Promise<void>((resolve) => writer.once("close", () => resolve()));
  writer.stdin.end("close\n");
  await closed;
});

test("partial multi-database commit failure restores only provider columns and original config", async (t) => {
  const home = await fixture(t);
  await runPython(createDatabase, { home, name: "state_4.sqlite" });
  await runPython(createDatabase, { home });
  const wrapper = `import runpy,json,sys,sqlite3
m=runpy.run_path(sys.argv[1]);real=m['connect'];failed=[False]
class Connection:
 def __init__(self,connection,fail):self.c=connection;self.fail=fail
 def __getattr__(self,k):return getattr(self.c,k)
 def __enter__(self):return self.c.__enter__()
 def __exit__(self,*a):return self.c.__exit__(*a)
 def commit(self):
  if self.fail and not failed[0]:failed[0]=True;raise sqlite3.OperationalError('simulated commit failure')
  return self.c.commit()
m['switch'].__globals__['connect']=lambda p:Connection(real(p),p.name=='state_5.sqlite')
r=m['switch'](json.load(sys.stdin))
if r:print(json.dumps(r))
`;
  const command = await getPython();
  const output = execFileSync(command.executable, [...command.args, "-c", wrapper, script], { input: JSON.stringify(request(home, official + api, buildProviderConfig(official + api, "beeapi"))), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.ok(output.includes('"ok": false'));
  for (const name of ["state_4.sqlite", "state_5.sqlite"]) {
    const state = await runPython(readDatabase, { home, name }) as { threads: unknown[][] };
    assert.deepEqual(state.threads.map((r) => r[1]), ["openai", "beeapi", "Other"]);
  }
  assert.equal(await fs.readFile(path.join(home, "config.toml"), "utf8"), official + api);
});

test("concurrent config edits and another switch lock fail without overwriting user changes", async (t) => {
  const home = await fixture(t);
  const command = await getPython();
  await fs.writeFile(path.join(home, "config.toml"), "# new user edit\n");
  await assert.rejects(runProviderHelper(command, script, request(home, official + api, official)), /变化/);
  assert.equal(await fs.readFile(path.join(home, "config.toml"), "utf8"), "# new user edit\n");
  await fs.mkdir(path.join(home, "agent-center"), { recursive: true });
  await fs.writeFile(path.join(home, "agent-center/provider-switch.lock"), "other-window");
  await assert.rejects(runProviderHelper(command, script, request(home, "# new user edit\n", official)), /正在进行/);
  assert.equal(await fs.readFile(path.join(home, "agent-center/provider-switch.lock"), "utf8"), "other-window");
});

test("fresh homes can switch, but legacy history without a database is not silently hidden", async (t) => {
  const home = await fixture(t);
  const result = await switchCodexProvider({ home, provider: "beeapi", scriptPath: script });
  assert.equal(result.threadCount, 0);
  await fs.mkdir(path.join(home, "sessions"));
  await fs.writeFile(path.join(home, "sessions", "old.jsonl"), "old history");
  await assert.rejects(switchCodexProvider({ home, provider: "openai", scriptPath: script }), /索引/);
  assert.equal(parseCodexConfig(await fs.readFile(path.join(home, "config.toml"), "utf8")).model_provider, "beeapi");
});

test("successful backup retention is bounded and API secrets never appear in helper results", async (t) => {
  const home = await fixture(t);
  await runPython(createDatabase, { home });
  for (let i = 0; i < 7; i++) {
    const result = await switchCodexProvider({ home, provider: i % 2 ? "openai" : "beeapi", scriptPath: script });
    assert.equal(JSON.stringify(result).includes("secret-never-log"), false);
    await fs.access(path.join(result.backupDirectory, "complete.json"));
  }
  const entries = await fs.readdir(path.join(home, "agent-center/provider-backups"));
  assert.equal(entries.length, 5);
});

async function uiHarness(t: { after: (fn: () => void) => void }) {
  let config = official + api;
  let shown = false;
  const bar = { text: "", tooltip: undefined as unknown, show: () => { shown = true; }, hide: () => { shown = false; }, dispose: () => {} };
  const picks: Array<{ value: string } | undefined> = [];
  const inputs: Array<string | undefined> = [];
  const inputOptions: Array<{ prompt: string; password?: boolean }> = [];
  const switches: Array<{ provider: string; newProvider?: { apiKey: string } }> = [];
  const commands: string[] = [];
  const settings: Record<string, unknown> = {};
  let noticeAction = "稍后";
  const notices: string[] = [];
  const fakeVscode = {
    StatusBarAlignment: { Right: 2 }, ProgressLocation: { Notification: 15 }, env: { remoteName: "ssh-remote" },
    Uri: { file: (value: string) => value },
    MarkdownString: class { value = ""; isTrusted: unknown; appendText(text: string) { this.value += text; } appendMarkdown(text: string) { this.value += text; } },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback }) },
    window: {
      createStatusBarItem: () => bar,
      showQuickPick: async () => picks.shift(),
      showInputBox: async (options: { prompt: string; password?: boolean }) => { inputOptions.push(options); return inputs.shift(); },
      showWarningMessage: async (text: string) => { notices.push(text); },
      showInformationMessage: async (text: string) => { notices.push(text); return noticeAction; },
      showErrorMessage: async (text: string) => { notices.push(text); },
      withProgress: async (_options: unknown, task: (progress: { report: () => void }) => Promise<unknown>) => task({ report: () => {} }),
    },
    commands: { executeCommand: async (command: string) => { commands.push(command); } },
  };
  const entry = require.resolve("../codexProvider");
  const realRequire = createRequire(entry);
  const module = { exports: {} as typeof import("../codexProvider") };
  vm.runInNewContext(await fs.readFile(entry, "utf8"), {
    module, exports: module.exports,
    require: (name: string) => name === "vscode" ? fakeVscode : name === "node:fs" ? { watchFile: () => {}, unwatchFile: () => {} } : name === "./codexProviderService" ? {
      resolveCodexHome: () => "/remote/.codex", readCodexConfig: async () => config,
      switchCodexProvider: async (options: { provider: string; newProvider?: { apiKey: string } }) => {
        switches.push(options);
        config = `model_provider = "${options.provider}"\n` + api;
        return { ok: true, provider: options.provider, threadCount: 340, changedCount: 340, databaseCount: 1, backupDirectory: "/remote/backup" };
      },
    } : realRequire(name),
  }, { filename: entry });
  const switcher = new module.exports.CodexProviderSwitcher({ asAbsolutePath: (value: string) => "/extension/" + value } as import("vscode").ExtensionContext);
  t.after(() => switcher.dispose());
  return { switcher, bar, picks, inputs, inputOptions, switches, commands, settings, notices, fakeVscode,
    shown: () => shown, setNoticeAction: (value: string) => { noticeAction = value; } };
}

test("provider entry remains accessible without quota credentials, with manual refresh and reload", async (t) => {
  const h = await uiHarness(t);
  await h.switcher.refresh();
  assert.equal(h.shown(), true);
  assert.match(h.bar.text, /OpenAI 官方/);
  h.picks.push({ value: "official" });
  h.setNoticeAction("重新加载窗口");
  await h.switcher.choose();
  assert.equal(h.switches[0].provider, "openai");
  assert.deepEqual(h.commands, ["workbench.action.reloadWindow"]);
  assert.ok(h.notices.some((text) => text.includes("340")));
});

test("custom API input explains the provider ID and reuses an existing definition", async (t) => {
  const h = await uiHarness(t);
  h.picks.push({ value: "api" });h.inputs.push("beeapi");
  await h.switcher.choose();
  assert.match(h.inputOptions[0].prompt, /model_provider = "beeapi"/);
  assert.equal(h.switches[0].provider, "beeapi");
  assert.equal(h.switches[0].newProvider, undefined);
  assert.equal(h.inputOptions.length, 1);
  assert.match(h.bar.text, /beeapi/);
  assert.equal(JSON.stringify(h.switcher.getDiagnostics()).includes("secret-never-log"), false);
});

test("new API setup masks the key and cancelling any input makes no changes", async (t) => {
  const h = await uiHarness(t);
  h.picks.push({ value: "api" });h.inputs.push("new-api", "https://example.com/v1", "new-private-key");
  await h.switcher.choose();
  assert.equal(h.inputOptions[2].password, true);
  assert.equal(h.switches[0].newProvider?.apiKey, "new-private-key");
  assert.equal(JSON.stringify(h.notices).includes("new-private-key"), false);
  h.picks.push({ value: "api" });h.inputs.push("cancelled-api", undefined);
  await h.switcher.choose();
  assert.equal(h.switches.length, 1);
});

test("untrusted workspaces and cancelled selections never change provider or history", async (t) => {
  const h = await uiHarness(t);
  h.fakeVscode.workspace.isTrusted = false;
  await h.switcher.choose();
  assert.equal(h.switches.length, 0);
  h.fakeVscode.workspace.isTrusted = true;
  h.picks.push(undefined);
  await h.switcher.choose();
  assert.equal(h.switches.length, 0);
  h.settings.enabled = false;
  await h.switcher.refresh();
  assert.equal(h.shown(), false);
});

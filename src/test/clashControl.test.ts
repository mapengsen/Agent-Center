import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { ClashControl, discoverClashControl, type ClashControlAction, type ClashControlRunner } from "../clashControl";
import { ClashSubscriptions } from "../clashSubscriptions";
import { controllerListening } from "../clashRuntime";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-center-control-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  await fs.mkdir(runtime);
  const file = path.join(runtime, "config.yaml");
  const stateFile = path.join(runtime, "subscriptions.yaml");
  const config = (nodes: string[]) => ({ proxies: nodes.map((name) => ({ name, type: "ss" })), "proxy-groups": [{ name: "PROXY", type: "select", proxies: nodes }] });
  await fs.writeFile(file, JSON.stringify(config(["old", "shared"])));
  await fs.writeFile(stateFile, JSON.stringify({ active: "current", sources: { current: { enabled: true, type: "clash", url: "https://private.example/token" }, other: { enabled: true, type: "clash", url: "https://other.example/token" } } }));
  let proxies: Record<string, { type: string; all?: string[]; now?: string }> = {
    old: { type: "Shadowsocks" }, shared: { type: "Shadowsocks" }, PROXY: { type: "Selector", now: "shared", all: ["old", "shared"] },
  };
  let online = false, port = 0, ignoreReloads = 0;
  const reloads: string[] = [], calls: ClashControlAction[] = [];
  const app = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/configs") return res.end('{"mode":"rule"}');
    if (req.method === "GET" && req.url === "/proxies") return res.end(JSON.stringify({ proxies }));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (req.method === "PUT" && req.url === "/configs?force=true") {
      assert.equal(body.path, file);
      reloads.push(body.path);
      if (ignoreReloads) ignoreReloads--;
      else {
        const data = JSON.parse(await fs.readFile(file, "utf8"));
        const nodes = data.proxies.map((entry: { name: string }) => entry.name);
        proxies = Object.fromEntries(nodes.map((name: string) => [name, { type: "Shadowsocks" }]));
        proxies.PROXY = { type: "Selector", all: nodes, now: nodes[0] };
      }
      return res.writeHead(204).end();
    }
    if (req.method === "PUT" && req.url === "/proxies/PROXY") {
      proxies.PROXY.now = body.name;
      return res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
  const start = async () => {
    if (online) return;
    await new Promise<void>((resolve) => app.listen(port, "127.0.0.1", resolve));
    port = (app.address() as { port: number }).port; online = true;
  };
  const stop = async () => {
    if (!online) return;
    app.closeAllConnections();
    await new Promise<void>((resolve) => app.close(() => resolve())); online = false;
  };
  t.after(stop);
  await start();
  const connection = { controller: "http://127.0.0.1:" + port, secret: "", timeoutMs: 1000, configPath: file, preferredGroups: ["PROXY"] };
  let runner: ClashControlRunner = async (action) => {
    if (action === "start") await start();
    else if (action === "stop") await stop();
    else await fs.writeFile(file, JSON.stringify(config(["new", "shared"])));
  };
  const make = () => new ClashControl(root, runtime, file, async (action) => { calls.push(action); await runner(action); }, new ClashSubscriptions(root));
  return { root, runtime, file, stateFile, connection, calls, reloads, make, start, stop,
    setRunner: (value: ClashControlRunner) => { runner = value; },
    ignoreNextReload: () => { ignoreReloads++; },
    proxies: () => proxies,
  };
}

test("updating the active source downloads again, reloads a stale running core and preserves the source list and selected node", async (t) => {
  const h = await fixture(t);
  const sources = await fs.readFile(h.stateFile, "utf8");
  assert.deepEqual(await h.make().execute("update", h.connection), { running: true });
  assert.deepEqual(h.calls, ["update"]);
  assert.equal(h.reloads.length, 1);
  assert.ok(h.proxies().new);
  assert.equal(h.proxies().old, undefined);
  assert.equal(h.proxies().PROXY.now, "shared");
  assert.equal(await fs.readFile(h.stateFile, "utf8"), sources);
  await assert.rejects(fs.stat(path.join(h.runtime, ".agent-center-subscriptions.lock")), { code: "ENOENT" });
});

test("a failed download restores original configuration, subscriptions and running node selection without leaking errors", async (t) => {
  const h = await fixture(t);
  const before = await fs.readFile(h.file, "utf8"), sources = await fs.readFile(h.stateFile, "utf8");
  h.setRunner(async (action) => {
    if (action === "update") {
      await fs.writeFile(h.file, '{"proxies":[]}');
      await fs.writeFile(h.stateFile, '{"active":"wrong","sources":{}}');
      throw new Error("https://private.example/secret-token");
    }
  });
  await assert.rejects(h.make().execute("update", h.connection), (error: Error) => {
    assert.match(error.message, /已恢复原配置/); assert.doesNotMatch(error.message, /private|secret-token/); return true;
  });
  assert.equal(await fs.readFile(h.file, "utf8"), before);
  assert.equal(await fs.readFile(h.stateFile, "utf8"), sources);
  assert.equal(h.proxies().PROXY.now, "shared");
  assert.equal(await controllerListening(h.connection.controller), true);
});

test("acknowledging reload without actually loading the new nodes is a failure with rollback", async (t) => {
  const h = await fixture(t);
  const before = await fs.readFile(h.file, "utf8");
  h.ignoreNextReload();
  await assert.rejects(h.make().execute("update", h.connection), /已恢复原配置/);
  assert.equal(await fs.readFile(h.file, "utf8"), before);
  assert.ok(h.proxies().old);
  assert.equal(h.reloads.length, 2);
});

test("stop and start verify the controller while retaining subscription storage", async (t) => {
  const h = await fixture(t);
  const sources = await fs.readFile(h.stateFile, "utf8");
  assert.deepEqual(await h.make().execute("stop", h.connection), { running: false });
  assert.equal(await controllerListening(h.connection.controller), false);
  assert.deepEqual(await h.make().execute("start", h.connection), { running: true });
  assert.equal(await controllerListening(h.connection.controller), true);
  assert.equal(await fs.readFile(h.stateFile, "utf8"), sources);
  assert.deepEqual(h.calls, ["stop", "start"]);
});

test("updating while stopped does not enable the service, including native updaters that start it", async (t) => {
  const h = await fixture(t);
  await h.stop();
  h.setRunner(async (action) => { if (action === "update") await h.start(); else if (action === "stop") await h.stop(); });
  assert.deepEqual(await h.make().execute("update", h.connection), { running: false });
  assert.deepEqual(h.calls, ["update", "stop"]);
  assert.equal(await controllerListening(h.connection.controller), false);
  assert.equal(h.reloads.length, 0);
});

test("runtime operations share the cross-window subscription lock and reject empty active sources", async (t) => {
  const h = await fixture(t);
  let release!: () => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  h.setRunner(async () => { ready(); await new Promise<void>((resolve) => { release = resolve; }); });
  const pending = h.make().execute("update", h.connection);
  await started;
  await assert.rejects(h.make().execute("stop", h.connection), /另一个窗口/);
  release(); await pending;
  await fs.writeFile(h.stateFile, '{"active":"","sources":{}}');
  await assert.rejects(h.make().execute("start", h.connection), /暂无可用的当前订阅/);
});

test("legacy shell integration can update and stop without starting a disabled service", { skip: process.platform === "win32" }, async (t) => {
  const h = await fixture(t);
  await h.stop();
  const resources = path.join(h.root, "resources"), core = path.join(h.root, "scripts", "cmd");
  await fs.mkdir(resources); await fs.mkdir(core, { recursive: true }); await fs.mkdir(path.join(h.root, "bin"));
  const file = path.join(resources, "runtime.yaml");
  await fs.writeFile(file, '{"proxies":[]}');
  await fs.writeFile(path.join(h.root, ".env"), "CLASH_CONFIG_URL='https://private.example/token'\n");
  await fs.writeFile(path.join(h.root, "bin", "yq"), "");
  await fs.writeFile(path.join(core, "common.sh"), "");
  await fs.writeFile(path.join(core, "clashctl.sh"), [
    'CLASH_CONFIG_RUNTIME="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/resources/runtime.yaml"',
    'clashon() { :; }',
    'clashoff() { printf "off\\n" >> "${CLASH_CONFIG_RUNTIME}.actions"; }',
    'clashsub() { printf "sub %s\\n" "$1" >> "${CLASH_CONFIG_RUNTIME}.actions"; }',
    '[[ $- == *i* ]] && :',
  ].join("\n"));
  const control = await discoverClashControl(file);
  const connection = { ...h.connection, configPath: file };
  assert.deepEqual(await control.execute("update", connection), { running: false });
  assert.deepEqual(await control.execute("stop", connection), { running: false });
  assert.equal(await fs.readFile(file + ".actions", "utf8"), "sub update\noff\n");
});

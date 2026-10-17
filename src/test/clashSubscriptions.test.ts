import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { ClashSubscriptions, runSubscriptionCommand, validateSubscriptionName, validateSubscriptionUrl, type SubscriptionRunner } from "../clashSubscriptions";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-center-subscriptions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "runtime"));
  const file = path.join(root, "runtime", "subscriptions.yaml");
  const data = { active: "default", sources: {
    default: { enabled: true, type: "convert", url: "https://private.example/original-secret" },
    second: { enabled: true, type: "clash", url: "https://private.example/new-secret" },
    disabled: { enabled: false, type: "clash", url: "https://private.example/disabled-secret" },
  } as Record<string, { enabled: boolean; type: string; url: string }> };
  const save = () => fs.writeFile(file, JSON.stringify(data));
  await save();
  return { root, data, save };
}

test("lists subscription metadata without exposing private URLs and adds without changing active", async (t) => {
  const h = await fixture(t);
  const run: SubscriptionRunner = async (_root, action, name, url) => {
    assert.equal(action, "add");
    h.data.sources[name] = { enabled: true, type: "clash", url: url! };
    await h.save();
  };
  const manager = new ClashSubscriptions(h.root, run);
  assert.doesNotMatch(JSON.stringify(await manager.list()), /secret|https|url/);
  assert.equal(await manager.add("我的订阅-2", "  https://example.com/link?clash=3&extend=1  "), "我的订阅-2");
  assert.equal(h.data.active, "default");
  assert.equal(h.data.sources["我的订阅-2"].url, "https://example.com/link?clash=3&extend=1");
  await assert.rejects(manager.add("second", "https://example.com"), /已存在/);
  assert.equal(h.data.sources.second.url, "https://private.example/new-secret");
});

test("resolves provider titles and filenames on demand, caches them and falls back without exposing URLs", async (t) => {
  const h = await fixture(t);
  let requests = 0;
  const api = http.createServer((req, res) => {
    requests++;
    const pathname = req.url?.split("?")[0];
    if (pathname === "/profile") {
      res.setHeader("profile-title", "base64:" + Buffer.from("我的机场").toString("base64"));
      res.setHeader("content-disposition", 'attachment; filename="ignored.yaml"');
    } else if (pathname === "/encoded") {
      res.setHeader("content-disposition", "inline; filename=plain.yaml; filename*=UTF-8''" + encodeURIComponent("夏洛特-linux.yaml"));
    } else if (pathname === "/plain") {
      res.setHeader("content-disposition", 'attachment; filename="iKuuu_V2.yaml"');
    } else if (pathname === "/invalid") {
      res.setHeader("content-disposition", "attachment; filename*=UTF-8''%broken");
    } else {
      res.statusCode = 503;
      return res.end("private-secret-error");
    }
    res.end("private subscription content is not needed");
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { api.closeAllConnections(); api.close(() => resolve()); }));
  const address = api.address();
  assert.ok(address && typeof address === "object");
  h.data.sources = Object.fromEntries(["profile", "encoded", "plain", "invalid", "unavailable"].map((name) => [name, {
    enabled: true, type: "clash", url: "http://127.0.0.1:" + address.port + "/" + name + "?token=private-secret",
  }]));
  await h.save();
  const manager = new ClashSubscriptions(h.root);
  assert.ok((await manager.list()).sources.every((source) => source.displayName === "127.0.0.1"));
  assert.equal(requests, 0, "Background list reads must not contact providers");
  const resolved = await manager.list({ resolveNames: true });
  assert.deepEqual(resolved.sources.map((source) => source.displayName), ["我的机场", "夏洛特-linux", "iKuuu_V2", "127.0.0.1", "127.0.0.1"]);
  assert.ok(resolved.sources.every((source) => source.hostname === "127.0.0.1"));
  assert.doesNotMatch(JSON.stringify(resolved), /private-secret|token|http|url/);
  assert.equal(requests, 5);
  assert.deepEqual(await new ClashSubscriptions(h.root).list({ resolveNames: true }), resolved);
  assert.deepEqual(await manager.list(), resolved);
  assert.deepEqual(await Promise.all(Object.values(h.data.sources).map((source) => manager.suggestName(source.url))),
    ["我的机场", "夏洛特-linux", "iKuuu_V2", "127.0.0.1", "127.0.0.1"]);
  assert.equal(requests, 5, "Cached names and failures must not cause repeated requests");
});

test("suggested names are safe, unique, and rechecked when saved without replacing another subscription", async (t) => {
  const h = await fixture(t);
  const titles: Record<string, string> = {
    "/duplicate": "iKuuu_V2", "/reserved": "default", "/unsafe": "🚀 我的机场：2026?", "/long": "机场".repeat(80), "/symbols": "🚀🚀",
  };
  const api = http.createServer((req, res) => {
    res.setHeader("profile-title", "base64:" + Buffer.from(titles[req.url!] ?? "").toString("base64"));
    res.end();
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { api.closeAllConnections(); api.close(() => resolve()); }));
  const address = api.address();
  assert.ok(address && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  const manager = new ClashSubscriptions(h.root, async (_root, action, name, url) => {
    assert.equal(action, "add");
    assert.equal(h.data.sources[name], undefined, "Existing sources must never be replaced");
    h.data.sources[name] = { enabled: true, type: "clash", url: url! };
    await h.save();
  });
  h.data.sources.iKuuu_V2 = { ...h.data.sources.second };
  h.data.sources["iKuuu_V2-2"] = { ...h.data.sources.second };
  await h.save();
  const suggested = await manager.suggestName(origin + "/duplicate");
  assert.equal(suggested, "iKuuu_V2-3");
  // Another window saved the suggestion while the user chose a save mode.
  h.data.sources[suggested] = { ...h.data.sources.second };
  await h.save();
  const saved = await manager.add(suggested, origin + "/duplicate", { uniqueName: true });
  assert.notEqual(saved, suggested);
  assert.equal(h.data.sources[saved].url, origin + "/duplicate");
  assert.equal(h.data.sources[suggested].url, h.data.sources.second.url);
  assert.equal(h.data.active, "default");
  assert.equal(await manager.suggestName(origin + "/reserved"), "default-2");
  delete h.data.sources.default;
  await h.save();
  assert.equal(await manager.suggestName(origin + "/reserved"), "default");
  assert.equal(await manager.suggestName(origin + "/unsafe"), "我的机场-2026");
  const long = await manager.suggestName(origin + "/long");
  assert.equal(Array.from(long).length, 64);
  validateSubscriptionName(long);
  assert.equal(await manager.suggestName(origin + "/symbols"), "subscription");
  await assert.rejects(manager.suggestName("file:///etc/passwd"), /HTTP\/HTTPS/);
});

test("rejects unsafe names and URLs before running native scripts", () => {
  for (const name of ['../default', 'a/b', 'a"b', 'a$b', 'a[b]', '-flag', 'a\nnext', 'a'.repeat(65)]) {
    assert.throws(() => validateSubscriptionName(name));
  }
  for (const url of ["file:///etc/passwd", "https://a:b@example.com", "https://example.com/\nsecret", "not-a-url"]) {
    assert.throws(() => validateSubscriptionUrl(url));
  }
  validateSubscriptionName("中文订阅 2026-10.15");
});

test("serializes native mutations across windows and releases lock after failure", async (t) => {
  const h = await fixture(t);
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const manager = new ClashSubscriptions(h.root, async () => {
    started();
    await new Promise<void>((resolve) => { release = resolve; });
    throw new Error("native failed");
  });
  const pending = manager.add("new", "https://example.com");
  const failure = assert.rejects(pending, /native failed/);
  await ready;
  await assert.rejects(new ClashSubscriptions(h.root).add("other", "https://example.com"), /另一个窗口/);
  release();
  await failure;
  await assert.rejects(fs.stat(path.join(h.root, "runtime", ".agent-center-subscriptions.lock")), { code: "ENOENT" });
});

async function controller(t: TestContext) {
  const proxies = { PROXY: { type: "Selector", now: "original", all: ["original", "other"] } };
  const api = http.createServer(async (req, res) => {
    if (req.url === "/configs") return res.end('{"mode":"rule"}');
    if (req.url === "/proxies") return res.end(JSON.stringify({ proxies }));
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      proxies.PROXY.now = JSON.parse(Buffer.concat(chunks).toString()).name;
      return res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { api.closeAllConnections(); api.close(() => resolve()); }));
  const address = api.address();
  assert.ok(address && typeof address === "object");
  return { proxies, connection: { controller: "http://127.0.0.1:" + address.port, secret: "", timeoutMs: 1000, configPath: "", preferredGroups: [] } };
}

test("switches an enabled subscription, verifies it and blocks disabled/stale entries", async (t) => {
  const h = await fixture(t);
  const api = await controller(t);
  const calls: string[] = [];
  const manager = new ClashSubscriptions(h.root, async (_root, action, name) => {
    assert.equal(action, "use");
    calls.push(name);
    h.data.active = name;
    await h.save();
  });
  await manager.use("second", api.connection);
  assert.equal((await manager.list()).active, "second");
  await manager.use("second", api.connection);
  await assert.rejects(manager.use("disabled", api.connection), /禁用/);
  await assert.rejects(manager.use("missing", api.connection), /不存在/);
  assert.deepEqual(calls, ["second"]);
});

test("removes inactive and default subscriptions, switching to the next enabled source before deletion", async (t) => {
  const h = await fixture(t);
  const api = await controller(t);
  const calls: Array<{ action: string; name: string }> = [];
  const manager = new ClashSubscriptions(h.root, async (_root, action, name) => {
    calls.push({ action, name });
    if (action === "use") h.data.active = name;
    else if (action === "remove") delete h.data.sources[name];
    else assert.fail("Unexpected action: " + action);
    await h.save();
  });
  assert.deepEqual(await manager.remove("disabled", api.connection), { active: "default", stopped: false });
  calls.length = 0;
  assert.deepEqual(await manager.remove("default", api.connection), { active: "second", stopped: false });
  assert.deepEqual(calls, [{ action: "use", name: "second" }, { action: "remove", name: "default" }]);
  assert.equal((await manager.list()).active, "second");
  assert.ok(!(await manager.list()).sources.some((source) => source.name === "default"));
  await assert.rejects(manager.remove("missing", api.connection), /不存在/);
});

test("deletion wraps to the first enabled source and leaves inactive deletion connected", async (t) => {
  const h = await fixture(t);
  const api = await controller(t);
  h.data.active = "second";
  await h.save();
  const calls: string[] = [];
  const manager = new ClashSubscriptions(h.root, async (_root, action, name) => {
    calls.push(action + ":" + name);
    if (action === "use") h.data.active = name;
    else if (action === "remove") delete h.data.sources[name];
    await h.save();
  });
  await manager.remove("second", api.connection);
  assert.deepEqual(calls, ["use:default", "remove:second"]);
  calls.length = 0;
  await manager.remove("disabled", api.connection);
  assert.deepEqual(calls, ["remove:disabled"]);
});

test("last subscription deletion stops the service and clears active, then adding and using starts it again", async (t) => {
  const h = await fixture(t);
  const api = await controller(t);
  h.data.sources = { default: h.data.sources.default };
  await h.save();
  const calls: string[] = [];
  const manager = new ClashSubscriptions(h.root, async (_root, action, name, url) => {
    calls.push(action + ":" + name);
    if (action === "remove") { delete h.data.sources[name]; h.data.active = ""; }
    else if (action === "add") h.data.sources[name] = { enabled: true, type: "clash", url: url! };
    else if (action === "use") h.data.active = name;
    await h.save();
  });
  assert.deepEqual(await manager.remove("default", api.connection), { active: "", stopped: true });
  assert.deepEqual(calls, ["stop:", "remove:default"]);
  assert.deepEqual(await manager.list(), { active: "", sources: [] });
  await manager.add("new", "https://example.com/new");
  assert.equal((await manager.list()).active, "");
  await manager.use("new", api.connection);
  assert.deepEqual(calls.slice(2), ["add:new", "use:new", "start:"]);
  assert.equal((await manager.list()).active, "new");
});

test("a failed automatic replacement preserves the source and restores its node selection", async (t) => {
  const h = await fixture(t);
  const api = await controller(t);
  const calls: string[] = [];
  const manager = new ClashSubscriptions(h.root, async (_root, action, name) => {
    calls.push(action + ":" + name);
    assert.equal(action, "use");
    h.data.active = name;
    api.proxies.PROXY.now = "other";
    await h.save();
    if (name === "second") throw new Error("private failure");
  });
  await assert.rejects(manager.remove("default", api.connection), /已恢复原订阅/);
  assert.deepEqual(calls, ["use:second", "use:default"]);
  assert.equal((await manager.list()).active, "default");
  assert.ok(h.data.sources.default);
  assert.equal(api.proxies.PROXY.now, "original");
});

test("a failed stop never removes the last source", async (t) => {
  const h = await fixture(t);
  const api = await controller(t);
  h.data.sources = { default: h.data.sources.default };
  await h.save();
  const manager = new ClashSubscriptions(h.root, async (_root, action) => {
    assert.equal(action, "stop");
    throw new Error("stop failed");
  });
  await assert.rejects(manager.remove("default", api.connection), /stop failed/);
  assert.equal((await manager.list()).active, "default");
  assert.ok(h.data.sources.default);
});

test("failed switches restore the previous subscription and manual nodes without exposing URLs", async (t) => {
  const h = await fixture(t);
  const api = await controller(t);
  const calls: string[] = [];
  const manager = new ClashSubscriptions(h.root, async (_root, _action, name) => {
    calls.push(name);
    h.data.active = name;
    api.proxies.PROXY.now = "other";
    await h.save();
    if (name === "second") throw new Error("failed https://private.example/new-secret");
  });
  await assert.rejects(manager.use("second", api.connection), (error: Error) => {
    assert.match(error.message, /已恢复原订阅和节点/);
    assert.doesNotMatch(error.message, /private|secret|https/);
    return true;
  });
  assert.deepEqual(calls, ["second", "default"]);
  assert.equal(h.data.active, "default");
  assert.equal(api.proxies.PROXY.now, "original");
});

test("reports incomplete recovery explicitly and hides native output", async (t) => {
  const h = await fixture(t);
  const api = await controller(t);
  const manager = new ClashSubscriptions(h.root, async () => { throw new Error("private-secret"); });
  await assert.rejects(manager.use("second", api.connection), (error: Error) => {
    assert.match(error.message, /自动恢复未完成/);
    assert.doesNotMatch(error.message, /private-secret/);
    return true;
  });
});

test("native add transports URL on stdin and preserves literal name without activating", { skip: process.platform === "win32" }, async (t) => {
  const h = await fixture(t);
  const core = path.join(h.root, "scripts", "core");
  await fs.mkdir(core, { recursive: true });
  await fs.writeFile(path.join(core, "common.sh"), [
    "init_project_context() { :; }", "load_env_if_exists() { :; }", "detect_install_scope() { :; }",
  ].join("\n"));
  await fs.writeFile(path.join(core, "config.sh"), [
    'set_subscription() {',
    '  printf "%s\\n" "$1" "$2" "$3" "$4" > "$PROJECT_DIR/received"',
    '}',
  ].join("\n"));
  await runSubscriptionCommand(h.root, "add", "我的订阅-2", "https://example.com/link?clash=3&extend=1");
  assert.equal(await fs.readFile(path.join(h.root, "received"), "utf8"),
    "https://example.com/link?clash=3&extend=1\nclash\n我的订阅-2\nfalse\n");
  assert.equal(h.data.active, "default");
});

test("native removal deletes default with yq, preserves a replacement and clears the final active source", {
  skip: process.platform === "win32" || !process.env.AGENT_CENTER_TEST_YQ,
}, async (t) => {
  const h = await fixture(t);
  const api = await controller(t);
  const core = path.join(h.root, "scripts", "core");
  await fs.mkdir(core, { recursive: true });
  await fs.writeFile(path.join(core, "common.sh"), [
    'init_project_context() { RUNTIME_DIR="$1/runtime"; }',
    "load_env_if_exists() { :; }", "detect_install_scope() { :; }",
  ].join("\n"));
  await fs.writeFile(path.join(core, "config.sh"), [
    'yq_bin() { printf "%s" "$AGENT_CENTER_TEST_YQ"; }',
    'subscriptions_file() { printf "%s/subscriptions.yaml" "$RUNTIME_DIR"; }',
    'clear_subscription_health_all_fields() { :; }',
  ].join("\n"));
  await fs.writeFile(path.join(core, "clashctl.sh"), [
    'set -euo pipefail',
    'root="$(cd "$(dirname "$0")/../.." && pwd)"',
    'printf "%s\\n" "$1" >> "$root/actions"',
    'if [ "$1" = use ]; then',
    '  NAME="$2" "$AGENT_CENTER_TEST_YQ" eval -i \'.active = env(NAME)\' "$root/runtime/subscriptions.yaml"',
    'fi',
  ].join("\n"));
  const manager = new ClashSubscriptions(h.root);
  assert.deepEqual(await manager.remove("default", api.connection), { active: "second", stopped: false });
  assert.deepEqual((await manager.list()).sources.map((source) => source.name), ["second", "disabled"]);
  assert.equal(await fs.readFile(path.join(h.root, "actions"), "utf8"), "use\n");
  await manager.remove("disabled", api.connection);
  assert.equal(await fs.readFile(path.join(h.root, "actions"), "utf8"), "use\n", "Inactive removal must not restart or stop");
  assert.deepEqual(await manager.remove("second", api.connection), { active: "", stopped: true });
  assert.deepEqual(await manager.list(), { active: "", sources: [] });
  assert.equal(await fs.readFile(path.join(h.root, "actions"), "utf8"), "use\noff\n");
});

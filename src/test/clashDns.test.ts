import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as vm from "node:vm";
import { createRequire } from "node:module";
import { dump } from "js-yaml";
import { ClashControl } from "../clashControl";
import { ClashSubscriptions } from "../clashSubscriptions";
import { dnsPolicy, prepareDnsChange, removeDnsOverrides, subscriptionDnsEnabled, verifySubscriptionDns } from "../clashDns";
import { readClashDocument, snapshotClashFiles, controllerListening } from "../clashRuntime";
import type { ClashWebProbe } from "../clashWebProbe";
import { ClashDnsCache, DNS_CACHE_INTERVAL_MS, type DnsDownloader } from "../clashDnsCache";

const badDns = { enable: true, listen: "127.0.0.1:1053", ipv6: false, nameserver: ["114.114.114.114"], "enhanced-mode": "redir-host" };
const goodDns = { enable: true, nameserver: ["https://resolver.example/dns-query"], "nameserver-policy": { "+.example.com": ["https://split.example/dns-query"] }, "enhanced-mode": "fake-ip", "use-hosts": false };

test("DNS cleanup removes resolution overrides while retaining host settings and unrelated YAML aliases", () => {
  const shared = { dns: badDns, "mixed-port": 7890 };
  const input = { override: shared, customCopy: shared, prepend: { rules: ["DOMAIN,example.com,DIRECT"] } };
  const changed = removeDnsOverrides(input, false);
  assert.deepEqual((changed.override as typeof shared).dns, { enable: true, listen: "127.0.0.1:1053", ipv6: false });
  assert.deepEqual(changed.customCopy, shared);
  assert.deepEqual(changed.prepend, input.prepend);
  assert.deepEqual(input.override.dns, badDns);
  assert.deepEqual(dnsPolicy(goodDns), { nameserver: goodDns.nameserver, "nameserver-policy": goodDns["nameserver-policy"], "enhanced-mode": "fake-ip", "use-hosts": false });
  assert.throws(() => verifySubscriptionDns({}, { dns: badDns }), /未提供/);
  assert.throws(() => verifySubscriptionDns({ dns: goodDns }, { dns: badDns }), /仍与订阅不一致/);
});

async function fixture(t: TestContext, options: { legacy?: boolean; perHost?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-center-dns-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = Boolean(options.legacy);
  const runtime = path.join(root, legacy ? "resources" : options.perHost ? "runtime/hosts/this-host" : "runtime");
  await fs.mkdir(runtime, { recursive: true });
  const mixinFile = path.join(runtime, "mixin.yaml"), file = path.join(runtime, legacy ? "runtime.yaml" : "config.yaml");
  const base = { "mixed-port": 17890, "external-controller": "127.0.0.1:19090", secret: "private-controller", tun: { enable: true },
    proxies: [{ name: "node", type: "ss" }], "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["node"] }] };
  const mixin = legacy ? { dns: badDns, "mixed-port": 17890, _custom: { feature: true } } : { override: { dns: badDns, "mixed-port": 17890 }, prepend: { rules: ["DOMAIN,example.com,DIRECT"] } };
  await fs.writeFile(mixinFile, "# original comment\n" + dump(mixin));
  await fs.writeFile(file, JSON.stringify({ ...base, dns: badDns }));
  if (legacy) await fs.writeFile(path.join(root, ".env"), 'CLASH_CONFIG_URL="https://private.example/source-token"\n');
  else await fs.writeFile(path.join(runtime, "subscriptions.yaml"), JSON.stringify({ active: "current", sources: { current: { enabled: true, type: "clash", url: "https://private.example/source-token" } } }));
  let source: Record<string, unknown> = { dns: structuredClone(goodDns) };
  let forceBad = false, failDownload = false, probeCount = 0, online = false, port = 0;
  const calls: string[] = [];
  const sourceFile = legacy ? path.join(runtime, "config.yaml") : path.join(runtime, "tmp/source-current.yaml");
  const app = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/configs") return res.end('{"mode":"rule"}');
    if (req.method === "GET" && req.url === "/proxies") return res.end('{"proxies":{"node":{"type":"Shadowsocks"},"PROXY":{"type":"Selector","all":["node"],"now":"node"}}}');
    if (req.method === "PUT" && req.url === "/configs?force=true") {
      if (forceBad) { forceBad = false; return res.writeHead(500).end(); }
      return res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
  const start = async () => { if (!online) { await new Promise<void>((r) => app.listen(port, "127.0.0.1", r)); port = (app.address() as { port: number }).port; online = true; } };
  const stop = async () => { if (online) { app.closeAllConnections(); await new Promise<void>((r) => app.close(() => r())); online = false; } };
  t.after(stop); await start();
  const connection = { controller: `http://127.0.0.1:${port}`, secret: "private-controller", timeoutMs: 500, configPath: file, preferredGroups: ["PROXY"] };
  const runner = async (action: "start" | "stop" | "update") => {
    calls.push(action);
    if (action === "stop") return stop();
    if (action === "start") return start();
    if (failDownload) throw new Error("download failed: https://private.example/source-token");
    let local: Record<string, unknown> = {};
    try { local = await readClashDocument(mixinFile); }
    catch { if (!legacy) local = await readClashDocument(path.join(root, "config/mixin.yaml")); }
    const overrides = (legacy ? local : local.override ?? {}) as Record<string, unknown>;
    const merge = (left: unknown, right: unknown): unknown => left && typeof left === "object" && !Array.isArray(left) && right && typeof right === "object" && !Array.isArray(right)
      ? Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => [key, Object.prototype.hasOwnProperty.call(right, key)
        ? merge((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]) : (left as Record<string, unknown>)[key]])) : right;
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, JSON.stringify(source));
    await fs.writeFile(file, JSON.stringify({ ...base, ...overrides,
      dns: forceBad ? badDns : merge(source.dns ?? {}, overrides.dns ?? {}) }));
  };
  let web: ClashWebProbe = { status: "success", detail: "Google webpage downloaded", httpStatus: 200 };
  const cache = new ClashDnsCache(root, runtime, legacy, async () => {
    if (failDownload) throw new Error("https://private.example/source-token");
    return structuredClone(source);
  });
  const control = new ClashControl(root, runtime, file, runner, legacy ? undefined : new ClashSubscriptions(root, undefined, runtime), async () => { probeCount++; return web; }, cache);
  return { root, runtime, file, mixinFile, sourceFile, connection, control, cache, calls, stop, probeCount: () => probeCount,
    source: (value: Record<string, unknown>) => { source = value; }, bad: () => { forceBad = true; }, fail: () => { failDownload = true; },
    web: (value: ClashWebProbe) => { web = value; } };
}

for (const legacy of [false, true]) {
  test(`${legacy ? "legacy" : "native"} DNS priority persists across updates and restores only original DNS policy`, async (t) => {
    const h = await fixture(t, { legacy });
    const original = await fs.readFile(h.mixinFile, "utf8");
    const result = await h.control.execute("subscription-dns", h.connection);
    assert.equal(result.dns?.mode, "subscription");
    assert.equal(result.dns?.web.status, "success");
    assert.equal(await subscriptionDnsEnabled(h.runtime), true);
    const config = await readClashDocument(h.file);
    assert.deepEqual(dnsPolicy(config.dns), dnsPolicy(goodDns));
    assert.equal((config.dns as Record<string, unknown>).listen, badDns.listen);
    assert.equal(config.secret, "private-controller");
    assert.deepEqual(config.tun, { enable: true });
    assert.equal(await fs.readFile(path.join(result.dns!.backupDirectory, "original-mixin.yaml"), "utf8"), original);
    const nextDns = { ...goodDns, nameserver: ["https://new-resolver.example/dns-query"] };
    h.source({ dns: nextDns });
    // Even an accidentally reintroduced local resolver is cleared on plugin update.
    const edited = await readClashDocument(h.mixinFile);
    const parent = (legacy ? edited : edited.override) as Record<string, unknown>;
    (parent.dns as Record<string, unknown>).nameserver = ["wrong-resolver"];
    parent["log-level"] = "debug";
    await fs.writeFile(h.mixinFile, dump(edited));
    await h.control.execute("update", h.connection);
    assert.deepEqual(dnsPolicy((await readClashDocument(h.file)).dns), dnsPolicy(nextDns));
    assert.equal(h.probeCount(), 1, "Ordinary updates do not add a webpage probe");
    const restored = await h.control.execute("restore-dns", h.connection);
    assert.equal(restored.dns?.mode, "local");
    assert.equal(await subscriptionDnsEnabled(h.runtime), false);
    const finalMixin = await readClashDocument(h.mixinFile);
    const final = (legacy ? finalMixin : finalMixin.override) as Record<string, unknown>;
    assert.deepEqual((final.dns as Record<string, unknown>).nameserver, badDns.nameserver);
    assert.equal(final["log-level"], "debug");
  });
}

test("a per-host runtime shadows shared mixins without changing other hosts, and can return to the fallback", async (t) => {
  const h = await fixture(t, { perHost: true });
  await fs.mkdir(path.join(h.root, "config"));
  const original = await fs.readFile(h.mixinFile);
  const shared = path.join(h.root, "config/mixin.yaml");
  await fs.writeFile(shared, original); await fs.unlink(h.mixinFile);
  const otherHost = path.join(h.root, "runtime/hosts/other-host");
  await fs.mkdir(otherHost); await fs.writeFile(path.join(otherHost, "mixin.yaml"), original);
  await h.control.execute("subscription-dns", h.connection);
  assert.deepEqual(await fs.readFile(shared), original);
  assert.deepEqual(await fs.readFile(path.join(otherHost, "mixin.yaml")), original);
  assert.deepEqual((await readClashDocument(h.mixinFile)).override, { dns: { enable: true, listen: badDns.listen, ipv6: false }, "mixed-port": 17890 });
  await h.control.execute("restore-dns", h.connection);
  await assert.rejects(fs.access(h.mixinFile));
  assert.deepEqual(await fs.readFile(shared), original);
});

test("restoring split DNS respects native deep merge while retaining new subscription domains", async (t) => {
  const h = await fixture(t);
  const mixin = await readClashDocument(h.mixinFile);
  const dns = (mixin.override as { dns: Record<string, unknown> }).dns;
  dns["nameserver-policy"] = { "+.private.example": ["10.0.0.53"] };
  await fs.writeFile(h.mixinFile, dump(mixin));
  await h.control.execute("subscription-dns", h.connection);
  await h.control.execute("restore-dns", h.connection);
  const restored = (await readClashDocument(h.file)).dns as { "nameserver-policy": Record<string, unknown> };
  assert.deepEqual(restored["nameserver-policy"]["+.private.example"], ["10.0.0.53"]);
  assert.deepEqual(restored["nameserver-policy"]["+.example.com"], goodDns["nameserver-policy"]["+.example.com"]);
});

for (const failure of ["download", "missing-dns", "reload"] as const) {
  test(`DNS ${failure} failure rolls back mixin, marker, runtime and running state without leaking URLs`, async (t) => {
    const h = await fixture(t);
    const mixin = await fs.readFile(h.mixinFile), runtime = await fs.readFile(h.file);
    if (failure === "download") h.fail();
    if (failure === "missing-dns") h.source({});
    if (failure === "reload") h.bad();
    await assert.rejects(h.control.execute("subscription-dns", h.connection), (error: Error) => {
      assert.match(error.message, /已恢复原配置|没有当前订阅的有效缓存/);
      assert.doesNotMatch(error.message, /private.example|source-token|private-controller/);
      return true;
    });
    assert.deepEqual(await fs.readFile(h.mixinFile), mixin);
    assert.deepEqual(await fs.readFile(h.file), runtime);
    assert.equal(await subscriptionDnsEnabled(h.runtime), false);
    assert.equal(await controllerListening(h.connection.controller), true);
    assert.equal(h.probeCount(), 0);
  });
}

test("DNS changes while stopped preserve the stopped state; no backup can be restored accidentally", async (t) => {
  const h = await fixture(t);
  await assert.rejects(h.control.execute("restore-dns", h.connection), /没有可恢复/);
  await h.stop();
  const result = await h.control.execute("subscription-dns", h.connection);
  assert.equal(result.running, false);
  assert.equal(result.dns?.web.status, "skipped");
  assert.equal(await controllerListening(h.connection.controller), false);
  assert.equal(h.probeCount(), 0);
});

for (const legacy of [false, true]) {
  test(`${legacy ? "legacy" : "native"} offline DNS recovery uses the current source cache without running the native updater or changing nodes`, async (t) => {
    const h = await fixture(t, { legacy });
    // Cache is populated in advance, before the user's DNS/network failure.
    await h.control.refreshDnsCache();
    const before = await readClashDocument(h.file);
    const sources = legacy ? await fs.readFile(path.join(h.root, ".env")) : await fs.readFile(path.join(h.runtime, "subscriptions.yaml"));
    h.fail();
    const result = await h.control.execute("subscription-dns", h.connection);
    assert.equal(result.dns?.fromCache, true);
    assert.ok(result.dns?.downloadedAt);
    assert.deepEqual(h.calls, []);
    const after = await readClashDocument(h.file);
    assert.deepEqual(dnsPolicy(after.dns), dnsPolicy(goodDns));
    for (const key of Object.keys(before).filter((key) => key !== "dns")) assert.deepEqual(after[key], before[key]);
    assert.deepEqual(legacy ? await fs.readFile(path.join(h.root, ".env")) : await fs.readFile(path.join(h.runtime, "subscriptions.yaml")), sources);
    assert.equal(await subscriptionDnsEnabled(h.runtime), true);
    assert.equal(await controllerListening(h.connection.controller), true);
  });
}

test("manual DNS application prefers a fresh policy and rolls back a failed offline reload", async (t) => {
  const h = await fixture(t);
  await h.control.refreshDnsCache();
  const newer = { ...goodDns, nameserver: ["https://new.example/dns-query"] };
  h.source({ dns: newer });
  const result = await h.control.execute("subscription-dns", h.connection);
  assert.equal(result.dns?.fromCache, false);
  assert.deepEqual(dnsPolicy((await readClashDocument(h.file)).dns), dnsPolicy(newer));
  const files = [h.file, h.mixinFile, path.join(h.runtime, ".agent-center-dns-policy.json")];
  const before = await Promise.all(files.map((file) => fs.readFile(file)));
  h.fail(); h.bad();
  await assert.rejects(h.control.execute("subscription-dns", h.connection), /已恢复原配置/);
  assert.deepEqual(await Promise.all(files.map((file) => fs.readFile(file))), before);
  assert.deepEqual(h.calls, []);
});

async function cacheFixture(t: TestContext, download?: DnsDownloader) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-center-dns-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  await fs.mkdir(runtime);
  const subscriptions = path.join(runtime, "subscriptions.yaml");
  const setSource = (url = "https://private.example/source-token", name = "current") => fs.writeFile(subscriptions, JSON.stringify({ active: name, sources: { [name]: { url, enabled: true, type: "clash" } } }));
  await setSource();
  let now = Date.parse("2026-10-24T00:00:00Z"), calls = 0, fails = false;
  const cache = new ClashDnsCache(root, runtime, false, download ?? (async () => {
    calls++;
    if (fails) throw new Error("https://private.example/source-token");
    return { dns: goodDns, proxies: [{ password: "not-for-the-cache" }], secret: "not-for-the-cache" };
  }), () => now);
  return { root, runtime, cache, setSource, calls: () => calls, advance: (ms: number) => { now += ms; }, fail: () => { fails = true; } };
}

test("background caching refreshes after five days, retains old DNS on failures and limits retries to hourly", async (t) => {
  const h = await cacheFixture(t);
  await h.cache.refresh(); assert.equal(h.calls(), 1);
  h.advance(DNS_CACHE_INTERVAL_MS - 1);
  await h.cache.refresh(); assert.equal(h.calls(), 1);
  h.advance(1);
  await h.cache.refresh(); assert.equal(h.calls(), 2);
  const file = path.join(h.runtime, ".agent-center-dns-cache", (await fs.readdir(path.join(h.runtime, ".agent-center-dns-cache")))[0]);
  const before = await fs.readFile(file, "utf8");
  assert.doesNotMatch(before, /source-token|private.example|not-for-the-cache|proxies|listen/);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  }
  h.advance(6 * DNS_CACHE_INTERVAL_MS); h.fail();
  await assert.rejects(h.cache.refresh()); assert.equal(h.calls(), 3);
  await h.cache.refresh(); assert.equal(h.calls(), 3);
  h.advance(3600000);
  await assert.rejects(h.cache.refresh()); assert.equal(h.calls(), 4);
  assert.equal(await fs.readFile(file, "utf8"), before);
  const fallback = await h.cache.resolve();
  assert.equal(fallback.fromCache, true);
  assert.deepEqual(fallback.dns, dnsPolicy(goodDns));
});

test("cache identities bind to the active subscription and its URL; malformed caches and invalid DNS cannot be applied", async (t) => {
  const h = await cacheFixture(t);
  await h.cache.refresh(); h.fail();
  await h.setSource("https://changed.example/new-token");
  await assert.rejects(h.cache.resolve(), /没有当前订阅的有效缓存/);
  await h.setSource("https://private.example/source-token", "other");
  await assert.rejects(h.cache.resolve(), /没有当前订阅的有效缓存/);
  await h.setSource();
  const directory = path.join(h.runtime, ".agent-center-dns-cache");
  const file = path.join(directory, (await fs.readdir(directory))[0]);
  await fs.writeFile(file, "corrupt");
  await assert.rejects(h.cache.resolve(), (error: Error) => !/private.example|source-token/.test(error.message));
  const invalid = await cacheFixture(t, async () => ({ dns: { enable: true } }));
  await assert.rejects(invalid.cache.resolve(), /没有当前订阅的有效缓存/);
});

test("background downloads abort on shutdown and cannot be saved for a different active source", async (t) => {
  const abort = new AbortController();
  const h = await cacheFixture(t, async (_url, signal) => { abort.abort(); signal?.throwIfAborted(); return { dns: goodDns }; });
  await assert.rejects(h.cache.refresh(abort.signal));
  await assert.rejects(fs.access(path.join(h.runtime, ".agent-center-dns-cache")));
  const changed = await cacheFixture(t, async () => { await changed.setSource("https://different.example/token"); return { dns: goodDns }; });
  await assert.rejects(changed.cache.resolve(), /订阅已改变/);
  await assert.rejects(fs.access(path.join(changed.runtime, ".agent-center-dns-cache")));
});

test("the real downloader fetches YAML without authentication, caches only DNS, and falls back on HTTP errors", async (t) => {
  const h = await cacheFixture(t);
  let status = 200;
  const server = http.createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(status).end(dump({ dns: goodDns, proxies: [{ name: "private-node", password: "not-cached" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await h.setSource(`http://127.0.0.1:${(server.address() as { port: number }).port}/private-subscription`);
  const cache = new ClashDnsCache(h.root, h.runtime, false);
  const fresh = await cache.resolve();
  assert.equal(fresh.fromCache, false);
  assert.deepEqual(fresh.dns, dnsPolicy(goodDns));
  status = 503;
  const cached = await cache.resolve();
  assert.equal(cached.fromCache, true);
  assert.equal(cached.downloadedAt, fresh.downloadedAt);
});

test("a failed webpage probe is reported separately from a verified DNS configuration", async (t) => {
  const h = await fixture(t);
  h.web({ status: "failed", detail: "node still unavailable" });
  const result = await h.control.execute("subscription-dns", h.connection);
  assert.equal(result.dns?.web.status, "failed");
  assert.equal(await subscriptionDnsEnabled(h.runtime), true);
  assert.deepEqual(dnsPolicy((await readClashDocument(h.file)).dns), dnsPolicy(goodDns));
});

test("a failed restore retains the active subscription-DNS policy and its original backup", async (t) => {
  const h = await fixture(t);
  const applied = await h.control.execute("subscription-dns", h.connection);
  const before = await fs.readFile(h.mixinFile);
  h.fail();
  await assert.rejects(h.control.execute("restore-dns", h.connection), /已恢复原配置/);
  assert.deepEqual(await fs.readFile(h.mixinFile), before);
  assert.equal(await subscriptionDnsEnabled(h.runtime), true);
  await fs.access(path.join(applied.dns!.backupDirectory, "original-mixin.yaml"));
});

test("DNS apply refuses concurrent file edits and does not overwrite them", async (t) => {
  const h = await fixture(t);
  const plan = await prepareDnsChange(h.root, h.runtime, false, false);
  const snapshot = await snapshotClashFiles(plan.files);
  await fs.appendFile(h.mixinFile, "# another edit\n");
  await assert.rejects(plan.apply(snapshot), /其他程序修改/);
  assert.match(await fs.readFile(h.mixinFile, "utf8"), /another edit/);
});

test("an empty shared Mixin can be enabled and restored without leaving a permanent host shadow", async (t) => {
  const h = await fixture(t, { perHost: true });
  await fs.mkdir(path.join(h.root, "config"));
  const shared = path.join(h.root, "config/mixin.yaml");
  await fs.writeFile(shared, "# no local overrides\n");await fs.unlink(h.mixinFile);
  const plan = await prepareDnsChange(h.root, h.runtime, false, false);
  await plan.apply(await snapshotClashFiles(plan.files));
  const restore = await prepareDnsChange(h.root, h.runtime, false, true);
  await restore.apply(await snapshotClashFiles(restore.files));
  await assert.rejects(fs.access(h.mixinFile));
  assert.equal(await fs.readFile(shared, "utf8"), "# no local overrides\n");
});

test("webpage check explicitly uses the current local proxy and requires a downloaded successful response", async () => {
  const entry = require.resolve("../clashWebProbe");
  const realRequire = createRequire(entry);
  const module = { exports: {} as typeof import("../clashWebProbe") };
  let response = { error: null as Error | null, stdout: "200 12345" };
  const calls: string[][] = [];
  vm.runInNewContext(await fs.readFile(entry, "utf8"), { module, exports: module.exports,
    require: (name: string) => name === "node:child_process" ? { execFile: (_file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      calls.push(args);callback(response.error, response.stdout);
    } } : realRequire(name),
  });
  const probe = module.exports.probeClashGoogle;
  assert.equal((await probe({ "mixed-port": 7890 })).status, "success");
  assert.equal(calls[0][0], "-q");
  assert.equal(calls[0][calls[0].indexOf("--proxy") + 1], "http://127.0.0.1:7890");
  assert.equal(calls[0][calls[0].indexOf("--noproxy") + 1], "");
  assert.equal(calls[0].at(-1), "https://www.google.com/");
  response.stdout = "403 234";assert.equal((await probe({ "socks-port": 1080 })).status, "failed");
  assert.equal(calls[1][calls[1].indexOf("--proxy") + 1], "socks5h://127.0.0.1:1080");
  response.stdout = "200 0";assert.equal((await probe({ port: 7890 })).status, "failed");
  response = { error: Object.assign(new Error("private-proxy-password"), { code: "ENOENT" }), stdout: "" };
  assert.equal((await probe({ port: 7890 })).status, "skipped");
  assert.equal((await probe({ port: 7890, authentication: ["private-user:private-password"] })).status, "skipped");
  assert.equal(calls.length, 4);
});

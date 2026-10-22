import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as vm from "node:vm";
import { createRequire } from "node:module";
import { ClashApiClient, findActiveGroup, resolveProxyChain, type ClashState } from "../clashApi";
import { CLASH_TEST_URL, loadClashConnection, normalizeController, type ClashSettings } from "../clashConfig";
import { clashTooltip, formatClashDelay } from "../clashPresentation";

const settings: ClashSettings = {
  controller: "", secret: "", configPath: "", group: "", testTimeoutMs: 8000, updateIntervalSeconds: 60,
};
function fixture(): ClashState {
  return { mode: "rule", proxies: {
    GLOBAL: { type: "Selector", now: "node-b", all: ["node-a", "node-b"] },
    "🔰 节点选择": { type: "Selector", now: "♻️ 自动选择", all: ["♻️ 自动选择", "node-a", "node-b"] },
    "♻️ 自动选择": { type: "URLTest", now: "node-a", all: ["node-a", "node-b"] },
    "node-a": { type: "VLESS" }, "node-b": { type: "VLESS" },
    DIRECT: { type: "Direct" }, REJECT: { type: "Reject" },
  } };
}
async function server(t: TestContext, handle: http.RequestListener): Promise<string> {
  const app = http.createServer(handle);
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    app.closeAllConnections();
    app.close((error) => error ? reject(error) : resolve());
  }));
  const address = app.address();
  assert.ok(address && typeof address === "object");
  return "http://127.0.0.1:" + address.port;
}

test("uses the active routing mode and resolves nested nodes without looping", () => {
  const state = fixture();
  assert.equal(findActiveGroup(state), "🔰 节点选择");
  assert.equal(findActiveGroup({ ...state, mode: "global" }), "GLOBAL");
  assert.equal(findActiveGroup({ ...state, mode: "direct" }), "DIRECT");
  assert.throws(() => findActiveGroup(state, "missing"));
  assert.deepEqual(resolveProxyChain(state.proxies, "🔰 节点选择"), ["🔰 节点选择", "♻️ 自动选择", "node-a"]);
  state.proxies["node-a"].now = "🔰 节点选择";
  assert.deepEqual(resolveProxyChain(state.proxies, "🔰 节点选择"), ["🔰 节点选择", "♻️ 自动选择", "node-a"]);
});

test("reads YAML controller/secret with quotes, honors overrides and masks parser diagnostics", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-center-clash-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, "clash-for-linux", "runtime");
  await fs.mkdir(directory, { recursive: true });
  const configPath = path.join(directory, "config.yaml");
  const discovery = { procRoot: path.join(home, "no-proc"), env: {}, commandDirectories: [], shellFiles: [] };
  await fs.writeFile(configPath, 'external-controller: "0.0.0.0:9090"\nsecret: \'a#b: c\' # comment\nproxy-groups:\n  - name: "🔰 节点选择"\n    type: select\n');
  const connection = await loadClashConnection(settings, home, discovery);
  assert.equal(connection.controller, "http://127.0.0.1:9090");
  assert.equal(connection.secret, "a#b: c");
  assert.deepEqual(connection.preferredGroups, ["🔰 节点选择"]);
  const override = await loadClashConnection({ ...settings, controller: "https://localhost:9443", secret: "override" }, home, discovery);
  assert.equal(override.controller, "https://localhost:9443");
  assert.equal(override.secret, "override");
  assert.equal(normalizeController("[::]:9090"), "http://[::1]:9090");
  assert.throws(() => normalizeController("file:///etc/passwd"));
  assert.throws(() => normalizeController("http://name:password@localhost:9090"));
  await fs.writeFile(configPath, 'secret: "do-not-leak\n');
  await assert.rejects(loadClashConnection(settings, home, discovery), (error: Error) => {
    assert.doesNotMatch(error.message, /do-not-leak/);
    return true;
  });
});

test("authenticated API handles Unicode, tests Google and changes only the requested group", async (t) => {
  const state = fixture();
  const writes: unknown[] = [];
  const controller = await server(t, async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-secret");
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/configs") return res.end(JSON.stringify({ mode: state.mode }));
    if (url.pathname === "/proxies") return res.end(JSON.stringify({ proxies: state.proxies }));
    if (url.pathname.endsWith("/delay")) {
      assert.equal(decodeURIComponent(url.pathname.split("/")[2]), "♻️ 自动选择");
      assert.equal(url.searchParams.get("url"), CLASH_TEST_URL);
      assert.equal(url.searchParams.get("timeout"), "8000");
      return res.end('{"delay":3349}');
    }
    assert.equal(req.method, "PUT");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    writes.push({ group: decodeURIComponent(url.pathname.split("/")[2]), ...body });
    state.proxies["🔰 节点选择"].now = body.name;
    res.writeHead(204).end();
  });
  const api = new ClashApiClient({ controller, secret: "test-secret", timeoutMs: 500 });
  assert.equal(findActiveGroup(await api.getState()), "🔰 节点选择");
  assert.deepEqual(await api.testDelay("♻️ 自动选择", CLASH_TEST_URL, 8000), { ok: true, ms: 3349 });
  await api.select("🔰 节点选择", "node-b");
  assert.equal((await api.getProxies())["🔰 节点选择"].now, "node-b");
  assert.deepEqual(writes, [{ group: "🔰 节点选择", name: "node-b" }]);
  assert.equal(state.proxies.GLOBAL.now, "node-b");
});

test("unreachable, zero-delay and invalid responses display × 超时; auth errors do not leak the response", async (t) => {
  let value = '{"delay":0}';
  let status = 200;
  const controller = await server(t, (_req, res) => { res.writeHead(status); res.end(value); });
  const api = new ClashApiClient({ controller, secret: "hidden-secret", timeoutMs: 200 });
  for (const data of ['{"delay":0}', '{"delay":null}', '{"delay":"123"}', '{"delay":-1}', 'invalid']) {
    value = data;
    assert.equal(formatClashDelay(await api.testDelay("node", CLASH_TEST_URL, 100)), "× 超时");
  }
  status = 401;
  value = "hidden-secret";
  await assert.rejects(api.getProxies(), (error: Error) => {
    assert.match(error.message, /鉴权/);
    assert.doesNotMatch(error.message, /hidden-secret/);
    return true;
  });
  const hung = await server(t, () => {});
  await assert.rejects(new ClashApiClient({ controller: hung, secret: "", timeoutMs: 30 }).getState(), /超时/);
});

test("hover exposes the final node, exact speed text and encoded direct switch commands", () => {
  const state = fixture();
  const snapshot = {
    state, group: "🔰 节点选择", chain: resolveProxyChain(state.proxies, "🔰 节点选择"),
    delay: { ok: true as const, ms: 3349 }, updatedAt: new Date("2026-10-15T00:00:00Z"),
  };
  const tooltip = clashTooltip(snapshot);
  assert.match(tooltip, /√ Google（3349 ms）/);
  assert.match(tooltip, /当前节点/);
  assert.match(tooltip, /node\\-a/);
  const link = tooltip.match(/command:agentStatus.chooseClashNode\?([^)]*)/);
  assert.ok(link);
  assert.deepEqual(JSON.parse(decodeURIComponent(link[1])), [{ group: "🔰 节点选择", node: "♻️ 自动选择" }]);
});

async function monitorHarness(t: TestContext) {
  const state = fixture();
  const writes: Array<{ group: string; node: string }> = [];
  let timeout = false;
  let running = true;
  let shown = false;
  const bar = {
    text: "", command: "", tooltip: undefined as unknown, color: undefined,
    show: () => { shown = true; }, hide: () => { shown = false; }, dispose: () => {},
  };
  const config: Record<string, unknown> = {};
  const inputs: Array<string | undefined> = [];
  const shownInputs: Array<{ password?: boolean; prompt?: string }> = [];
  const picks: Array<{ label: string; value: string } | undefined> = [];
  const shownPicks: Array<Array<{ label: string; value: string; description?: string; detail?: string }>> = [];
  const notices: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const commands: string[] = [];
  const progressCancellations = new Set<() => void>();
  const subscriptionCalls: Array<{ action: string; name: string }> = [];
  const controlCalls: string[] = [];
  const control = {
    configPath: "/test/config.yaml",
    execute: async (action: string) => {
      controlCalls.push(action);
      if (action === "start") running = true;
      if (action === "stop") running = false;
      if (action === "subscription-dns" || action === "restore-dns") return { running, dns: {
        mode: action === "subscription-dns" ? "subscription" : "local", backupDirectory: "/test/dns-backup",
        web: { status: "failed", detail: "Google 网页仍无法访问，请继续检查节点。" },
      } };
      return { running };
    },
  };
  const subscriptions = {
    list: async () => ({ active: "default", sources: [
      { name: "default", displayName: "我的机场", hostname: "provider.example", enabled: true, type: "clash" },
      { name: "second", displayName: "备用机场", hostname: "backup.example", enabled: true, type: "clash" },
    ] }),
    suggestName: async (_url: string) => "iKuuu_V2",
    add: async (name: string, _url: string, _options?: { uniqueName?: boolean }) => { subscriptionCalls.push({ action: "add", name }); return name; },
    use: async (name: string) => { subscriptionCalls.push({ action: "use", name }); },
    remove: async (name: string) => { subscriptionCalls.push({ action: "remove", name }); return { active: "default", stopped: false }; },
  };
  const api = {
    getState: async () => { if (!running) throw new Error("ECONNREFUSED"); return structuredClone(state); },
    getProxies: async () => structuredClone(state.proxies),
    testDelay: async (_node?: string, _url?: string, _timeout?: number, _signal?: AbortSignal) => timeout ? { ok: false, error: "test timeout" } : { ok: true, ms: 3349 },
    select: async (group: string, node: string) => { writes.push({ group, node }); state.proxies[group].now = node; },
  };
  const fakeVscode = {
    StatusBarAlignment: { Right: 2 }, env: { remoteName: "ssh-remote" },
    commands: { executeCommand: async (command: string) => { commands.push(command); } },
    ThemeColor: class { constructor(public id: string) {} },
    ProgressLocation: { Notification: 15 },
    MarkdownString: class { isTrusted: unknown; constructor(public value: string) {} },
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => config[key] ?? fallback }),
    },
    window: {
      createStatusBarItem: () => bar,
      createWebviewPanel: () => { assert.fail("Clash details must use the status-bar hover"); },
      showQuickPick: async (items: Array<{ label: string; value: string; detail?: string }>) => { shownPicks.push(items); return picks.shift(); },
      showInputBox: async (options: { password?: boolean; prompt?: string }) => { shownInputs.push(options); return inputs.shift(); },
      showWarningMessage: async (text: string) => { warnings.push(text); return "删除订阅"; },
      withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) => task({ report: () => {} }, {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => { progressCancellations.add(listener); return { dispose: () => progressCancellations.delete(listener) }; },
      }),
      showInformationMessage: async (text: string) => { notices.push(text); }, showErrorMessage: async (text: string) => { errors.push(text); },
    },
  };
  const entry = require.resolve("../clashStatus");
  const realRequire = createRequire(entry);
  const module = { exports: {} as typeof import("../clashStatus") };
  const fakeApi = { ...realRequire("./clashApi"), ClashApiClient: class { constructor() { return api; } } };
  vm.runInNewContext(await fs.readFile(entry, "utf8"), {
    module, exports: module.exports, require: (name: string) => name === "vscode" ? fakeVscode :
      name === "./clashApi" ? fakeApi : name === "./clashConfig" ? {
        ...realRequire("./clashConfig"),
        loadClashConnection: async () => ({ controller: "http://127.0.0.1:9090", configPath: "/test/config.yaml", preferredGroups: [] }),
      } : name === "./clashSubscriptions" ? {
        ...realRequire("./clashSubscriptions"), discoverClashSubscriptions: async () => subscriptions,
      } : name === "./clashControl" ? { discoverClashControl: async () => control }
        : name === "./clashRuntime" ? { ...realRequire(name), controllerListening: async () => running } : realRequire(name),
    setTimeout, clearTimeout, AbortController,
  }, { filename: entry });
  const monitor = new module.exports.ClashStatusMonitor();
  t.after(() => monitor.dispose());
  return { monitor, state, writes, bar, fakeVscode, config, api, inputs, picks, shownInputs, shownPicks, subscriptions, subscriptionCalls,
    notices, warnings, errors, commands, control, controlCalls, cancelProgress: () => progressCancellations.forEach((listener) => listener()),
    shown: () => shown, failDelay: () => { timeout = true; } };
}

test("status-bar click opens the existing native hover with trusted actions and no editor page", async (t) => {
  const h = await monitorHarness(t);
  await h.monitor.refresh();
  // This command runs in the renderer while the clicked status entry has focus.
  assert.equal(h.bar.command, "workbench.action.showHover");
  const hover = h.bar.tooltip as { value: string; isTrusted: { enabledCommands: string[] } };
  assert.match(hover.value, /当前节点/);
  assert.match(hover.value, /3349 ms/);
  assert.match(hover.value, /我的机场（default）/);
  assert.doesNotMatch(hover.value, /showClashDetails/);
  for (const command of ["chooseClashNode", "refreshClash", "openSettings", "chooseClashSubscription", "addClashSubscription", "removeClashSubscription", "startClash", "stopClash", "updateClashSubscription", "useSubscriptionDns", "restoreClashDns", "testAllClashNodes", "cancelClashNodeTests", "testAndSelectBestClashNode"]) {
    if (command === "cancelClashNodeTests") { assert.ok(hover.isTrusted.enabledCommands.includes("agentStatus." + command)); continue; }
    assert.ok(hover.value.includes("command:agentStatus." + command));
    assert.ok(hover.isTrusted.enabledCommands.includes("agentStatus." + command));
  }
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.subscriptionCalls, []);
  assert.equal(h.shownPicks.length, 0);
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.commands, []);
});

test("all-node testing uses the hover, labels each result and preserves the current selection", async (t) => {
  const h = await monitorHarness(t);
  await h.monitor.refresh();
  const calls: string[] = [];
  h.api.testDelay = async (node) => { calls.push(node!); return node === "node-b" ? { ok: false, error: "timeout" } : { ok: true, ms: 100 }; };
  await h.monitor.testAllNodes();
  assert.deepEqual(calls.sort(), ["node-a", "node-b"]);
  assert.equal(h.writes.length, 0);
  assert.equal(h.state.proxies["🔰 节点选择"].now, "♻️ 自动选择");
  const hover = (h.bar.tooltip as { value: string }).value;
  assert.match(hover, /2\/2.*完成/);
  assert.match(hover, /100 ms/);
  assert.match(hover, /× 超时/);
  assert.ok(h.notices.some((text) => /1 个可用，1 个超时/.test(text)));
  h.picks.push({ label: "node-a", value: "node-a" });
  await h.monitor.chooseNode();
  assert.ok(h.shownPicks[0].some((item) => item.value === "node-a" && item.description?.includes("100 ms")));
  await h.monitor.manageControl("update");
  assert.doesNotMatch((h.bar.tooltip as { value: string }).value, /\*\*全部节点测速\*\*/);
});

test("duplicate all-node requests share one batch and progress cancellation stops the batch", async (t) => {
  const h = await monitorHarness(t);
  await h.monitor.refresh();
  let started = 0;
  h.api.testDelay = async (_node, _url, _timeout, signal) => {
    started++;
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    return { ok: false, error: "cancelled" };
  };
  const first = h.monitor.testAllNodes();
  assert.equal(first, h.monitor.testAllNodes());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 2);
  assert.match((h.bar.tooltip as { value: string }).value, /command:agentStatus.cancelClashNodeTests/);
  h.cancelProgress();
  await first;
  assert.match((h.bar.tooltip as { value: string }).value, /已取消/);
  assert.equal(h.writes.length, 0);
});

test("changed node lists discard batch results; configuration changes abort requests and suppress late UI", async (t) => {
  const h = await monitorHarness(t);
  await h.monitor.refresh();
  h.api.testDelay = async () => { h.state.proxies["new-node"] = { type: "VLESS" }; return { ok: true, ms: 123 }; };
  await h.monitor.testAllNodes();
  assert.ok(h.warnings.some((text) => text.includes("节点列表在测速期间发生变化")));
  assert.doesNotMatch((h.bar.tooltip as { value: string }).value, /\*\*全部节点测速\*\*/);
  h.api.testDelay = async (_node, _url, _timeout, signal) => {
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    return { ok: true, ms: 99 };
  };
  const pending = h.monitor.testAllNodes();
  await new Promise((resolve) => setImmediate(resolve));
  h.config.enabled = false;
  h.monitor.reloadConfiguration();
  await pending;
  assert.equal(h.shown(), false);
  h.fakeVscode.workspace.isTrusted = false;
  await h.monitor.testAllNodes();
  assert.equal(h.shown(), false);
});

test("one-click best-node selection runs a fresh batch and renders the verified fastest node", async (t) => {
  const h = await monitorHarness(t);
  await h.monitor.refresh();
  const tested: string[] = [];
  h.api.testDelay = async (node) => { tested.push(node!); return { ok: true, ms: node === "node-b" ? 50 : 100 }; };
  await h.monitor.testAllNodes(true);
  assert.deepEqual(tested.sort(), ["node-a", "node-b"]);
  assert.deepEqual(h.writes, [{ group: "🔰 节点选择", node: "node-b" }]);
  assert.equal(h.bar.text, "$(globe) √ Google（50 ms）");
  assert.match((h.bar.tooltip as { value: string }).value, /最佳节点切换.*已切换至/s);
  assert.ok(h.notices.some((text) => text.includes("最低延迟") && text.includes("node-b")));
});

test("best-node selection keeps the current choice on total failure and refuses direct mode", async (t) => {
  const h = await monitorHarness(t);
  await h.monitor.refresh();h.failDelay();
  await h.monitor.testAllNodes(true);
  assert.deepEqual(h.writes, []);
  assert.ok(h.warnings.some((text) => text.includes("保留原选择")));
  h.state.mode = "direct";
  await h.monitor.testAllNodes(true);
  assert.deepEqual(h.writes, []);
  assert.ok(h.errors.some((text) => text.includes("不支持手动切换")));
});

test("cancelled best-node tests cannot switch and a plain batch cannot be upgraded by a second click", async (t) => {
  const h = await monitorHarness(t);
  await h.monitor.refresh();
  h.api.testDelay = async (_node, _url, _timeout, signal) => {
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    return { ok: true, ms: 10 };
  };
  const first = h.monitor.testAllNodes(true);
  await new Promise((resolve) => setImmediate(resolve));h.cancelProgress();await first;
  assert.deepEqual(h.writes, []);
  const plain = h.monitor.testAllNodes();
  assert.equal(plain, h.monitor.testAllNodes(true));
  await new Promise((resolve) => setImmediate(resolve));h.cancelProgress();await plain;
  assert.deepEqual(h.writes, []);
});

test("runtime controls use the existing hover, keep start available while stopped, and update without adding or choosing a subscription", async (t) => {
  const h = await monitorHarness(t);
  await h.monitor.refresh();
  await h.monitor.manageControl("stop");
  assert.equal(h.bar.text, "$(globe) Clash 已关闭");
  assert.match((h.bar.tooltip as { value: string }).value, /开启代理/);
  assert.equal(h.monitor.getDiagnostics().proxyStopped, true);
  await h.monitor.manageControl("update");
  assert.equal(h.bar.text, "$(globe) Clash 已关闭");
  assert.ok(h.notices.some((notice) => notice.includes("代理保持关闭")));
  await h.monitor.manageControl("start");
  assert.equal(h.bar.text, "$(globe) √ Google（3349 ms）");
  assert.deepEqual(h.controlCalls, ["stop", "update", "start"]);
  assert.deepEqual(h.subscriptionCalls, []);
  assert.equal(h.shownInputs.length, 0);
  assert.equal(h.shownPicks.length, 0);
  h.fakeVscode.workspace.isTrusted = false;
  await h.monitor.manageControl("stop");
  assert.equal(h.controlCalls.length, 3);
  h.fakeVscode.workspace.isTrusted = true;
  h.config.enabled = false;
  await h.monitor.manageControl("start");
  assert.equal(h.controlCalls.length, 3);
});

test("DNS actions use the existing hover and report failed webpage checks without claiming a network repair", async (t) => {
  const h = await monitorHarness(t);
  await h.monitor.refresh();
  await h.monitor.manageControl("subscription-dns");
  assert.deepEqual(h.controlCalls, ["subscription-dns"]);
  assert.ok(h.warnings.some((text) => text.includes("DNS 已使用订阅配置") && text.includes("仍无法访问")));
  assert.ok((h.monitor.getDiagnostics().dnsVerification as { backupDirectory: string }).backupDirectory);
  await h.monitor.manageControl("restore-dns");
  assert.deepEqual(h.controlCalls, ["subscription-dns", "restore-dns"]);
  assert.ok(h.warnings.some((text) => text.includes("原 DNS 覆写已恢复")));
  h.fakeVscode.workspace.isTrusted = false;
  await h.monitor.manageControl("subscription-dns");
  assert.equal(h.controlCalls.length, 2);
});

test("status monitor renders latency and node hover, verifies switch, rejects stale links and honors trust", async (t) => {
  const h = await monitorHarness(t);
  await h.monitor.refresh();
  assert.equal(h.bar.text, "$(globe) √ Google（3349 ms）");
  assert.ok(h.shown());
  assert.match((h.bar.tooltip as { value: string }).value, /node\\-a/);
  await h.monitor.chooseNode({ group: "🔰 节点选择", node: "node-b" });
  assert.equal(h.writes.length, 1);
  assert.equal(h.monitor.getDiagnostics().group, "🔰 节点选择");
  await h.monitor.chooseNode({ group: "♻️ 自动选择", node: "node-a" });
  await h.monitor.chooseNode({ group: "🔰 节点选择", node: "missing" });
  assert.equal(h.writes.length, 1);
  h.failDelay();
  await h.monitor.refresh();
  assert.equal(h.bar.text, "$(globe) × 超时");
  h.fakeVscode.workspace.isTrusted = false;
  await h.monitor.chooseNode({ group: "🔰 节点选择", node: "node-a" });
  assert.equal(h.writes.length, 1);
  h.fakeVscode.workspace.isTrusted = true;
  h.state.mode = "direct";
  await h.monitor.chooseNode({ group: "🔰 节点选择", node: "node-a" });
  assert.equal(h.writes.length, 1);
});

test("Google host connectivity is a single prefix before the globe, sharing the existing hover", async (t) => {
  const h = await monitorHarness(t);
  await h.monitor.refresh();
  h.monitor.setNetworkStatus({ icon: "✅️", tooltip: "Google 扩展宿主已响应 HTTP 403\n\n[立即检测联网](command:agentStatus.refreshNetwork)" });
  assert.equal(h.bar.text, "✅️ $(globe) √ Google（3349 ms）");
  assert.equal(h.bar.command, "workbench.action.showHover");
  const hover = h.bar.tooltip as { value: string; isTrusted: { enabledCommands: string[] } };
  assert.match(hover.value, /HTTP 403/);
  assert.match(hover.value, /当前节点/);
  assert.ok(hover.isTrusted.enabledCommands.includes("agentStatus.refreshNetwork"));
  await h.monitor.refresh();
  assert.equal(h.bar.text, "✅️ $(globe) √ Google（3349 ms）", "Clash refresh must retain host connectivity");
  h.failDelay();
  await h.monitor.refresh();
  assert.equal(h.bar.text, "✅️ $(globe) × 超时", "Independent probes can have different results");
  h.monitor.setNetworkStatus({ icon: "❌", tooltip: "扩展宿主超时" });
  assert.equal(h.bar.text, "❌ $(globe) × 超时");
  h.monitor.setNetworkStatus(undefined);
  assert.equal(h.bar.text, "$(globe) × 超时");
  assert.doesNotMatch((h.bar.tooltip as { value: string }).value, /HTTP 403|扩展宿主超时/);
});

test("the Google badge still works without Clash and disappears when both features are disabled", async (t) => {
  const h = await monitorHarness(t);
  h.config.enabled = false;
  h.monitor.reloadConfiguration();
  h.monitor.setNetworkStatus({ icon: "✅️", tooltip: "Google 已响应" });
  assert.equal(h.bar.text, "✅️");
  assert.ok(h.shown());
  h.monitor.setNetworkStatus(undefined);
  assert.equal(h.shown(), false);
  h.fakeVscode.workspace.isTrusted = false;
  h.monitor.setNetworkStatus({ icon: "✅️", tooltip: "Google 已响应" });
  assert.equal(h.shown(), false);
});

test("disabling or disposing while a refresh is pending cannot show a late result", async (t) => {
  const h = await monitorHarness(t);
  let release!: () => void;
  h.api.getState = async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return structuredClone(h.state);
  };
  const pending = h.monitor.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  h.config.enabled = false;
  h.monitor.reloadConfiguration();
  release();
  await pending;
  assert.equal(h.shown(), false);
});

test("subscription UI saves without switching, supports immediate use and ignores cancellation or untrusted workspaces", async (t) => {
  const h = await monitorHarness(t);
  h.inputs.push("https://example.com/private");
  h.picks.push({ label: "save", value: "save" });
  await h.monitor.manageSubscriptions("add");
  assert.deepEqual(h.subscriptionCalls, [{ action: "add", name: "iKuuu_V2" }]);
  assert.equal(h.shownInputs.length, 1, "Adding only asks for a URL");
  assert.equal(h.shownInputs[0].password, true);
  assert.ok(h.shownPicks[0].every((pick) => pick.detail?.includes("iKuuu_V2")));
  h.inputs.push("https://example.com/private");
  h.picks.push({ label: "use", value: "use" });
  await h.monitor.manageSubscriptions("add");
  assert.deepEqual(h.subscriptionCalls.slice(1), [{ action: "add", name: "iKuuu_V2" }, { action: "use", name: "iKuuu_V2" }]);
  h.picks.push({ label: "second", value: "second" });
  await h.monitor.manageSubscriptions("choose");
  assert.equal(h.subscriptionCalls.at(-1)?.name, "second");
  const count = h.subscriptionCalls.length;
  h.inputs.push("https://example.com/private");
  await h.monitor.manageSubscriptions("add"); // Cancel after identifying the name.
  await h.monitor.manageSubscriptions("add");
  await h.monitor.manageSubscriptions("choose");
  h.fakeVscode.workspace.isTrusted = false;
  await h.monitor.manageSubscriptions("choose");
  assert.equal(h.subscriptionCalls.length, count);
  h.fakeVscode.workspace.isTrusted = true;
  await h.monitor.refresh();
  const tooltip = (h.bar.tooltip as { value: string }).value;
  assert.match(tooltip, /当前订阅/);
  assert.match(tooltip, /command:agentStatus.addClashSubscription/);
  assert.match(tooltip, /command:agentStatus.chooseClashSubscription/);
  assert.doesNotMatch(tooltip, /private/);
});

test("immediate switching uses the actual saved name after a concurrent name collision", async (t) => {
  const h = await monitorHarness(t);
  h.inputs.push("https://example.com/private");
  h.picks.push({ label: "use", value: "use" });
  h.subscriptions.add = async (name, _url, options) => {
    assert.equal(name, "iKuuu_V2");
    assert.equal(options?.uniqueName, true);
    return "iKuuu_V2-2";
  };
  await h.monitor.manageSubscriptions("add");
  assert.deepEqual(h.subscriptionCalls, [{ action: "use", name: "iKuuu_V2-2" }]);
});

test("name lookup cannot continue adding after trust or configuration changes", async (t) => {
  for (const change of ["trust", "config"]) {
    const h = await monitorHarness(t);
    h.inputs.push("https://example.com/private");
    h.picks.push({ label: "use", value: "use" });
    h.subscriptions.suggestName = async () => {
      if (change === "trust") h.fakeVscode.workspace.isTrusted = false;
      else { h.config.enabled = false; h.monitor.reloadConfiguration(); }
      return "iKuuu_V2";
    };
    await h.monitor.manageSubscriptions("add");
    assert.equal(h.shownPicks.length, 0);
    assert.deepEqual(h.subscriptionCalls, []);
  }
});

test("subscription picker shows provider titles and origins while switching by native identifier", async (t) => {
  const h = await monitorHarness(t);
  h.picks.push({ label: "备用机场", value: "second" });
  await h.monitor.manageSubscriptions("choose");
  assert.equal(h.shownPicks[0][0].label, "我的机场");
  assert.match(h.shownPicks[0][0].detail!, /default.*provider\.example/);
  assert.equal(h.shownPicks[0][1].label, "备用机场");
  assert.deepEqual(h.subscriptionCalls, [{ action: "use", name: "second" }]);
  assert.match((h.bar.tooltip as { value: string }).value, /当前订阅.*我的机场（default）/);
});

test("subscription removal asks for confirmation and delegates the native identifier", async (t) => {
  const h = await monitorHarness(t);
  h.picks.push({ label: "备用机场", value: "second" });
  await h.monitor.manageSubscriptions("remove");
  assert.deepEqual(h.shownPicks[0].map((item) => item.value), ["default", "second"]);
  assert.match(h.shownPicks[0][0].description!, /当前订阅.*自动切换/);
  assert.deepEqual(h.subscriptionCalls, [{ action: "remove", name: "second" }]);
});

test("default can be removed after confirmation and explains automatic switching", async (t) => {
  const h = await monitorHarness(t);
  h.picks.push({ label: "我的机场", value: "default" });
  await h.monitor.manageSubscriptions("remove");
  assert.equal(h.shownPicks[0].length, 2);
  assert.deepEqual(h.subscriptionCalls, [{ action: "remove", name: "default" }]);
  assert.match(h.warnings[0], /自动切换到“备用机场”/);
});

test("removing the last subscription confirms shutdown and renders the stopped hover without querying the controller", async (t) => {
  const h = await monitorHarness(t);
  const initial = await h.subscriptions.list();
  let empty = false;
  h.subscriptions.list = async () => empty ? { active: "", sources: [] } : { active: "default", sources: initial.sources.slice(0, 1) };
  h.subscriptions.remove = async (name) => { h.subscriptionCalls.push({ action: "remove", name }); empty = true; return { active: "", stopped: true }; };
  await h.monitor.refresh();
  h.picks.push({ label: "我的机场", value: "default" });
  await h.monitor.manageSubscriptions("remove");
  assert.match(h.warnings[0], /没有其他可用订阅.*Clash 服务将停止/);
  assert.match(h.bar.text, /Clash 已停止/);
  const hover = (h.bar.tooltip as { value: string }).value;
  assert.match(hover, /Clash 已停止.*暂无活动订阅/s);
  assert.match(hover, /command:agentStatus.addClashSubscription/);
  assert.match(hover, /command:agentStatus.chooseClashSubscription/);
  assert.match(hover, /command:agentStatus.removeClashSubscription/);
  assert.doesNotMatch(hover, /showClashDetails|US-LAX|node-a/);
  h.api.getState = async () => { throw new Error("Stopped controller must not be queried"); };
  await h.monitor.refresh();
  assert.match(h.bar.text, /Clash 已停止/);
});

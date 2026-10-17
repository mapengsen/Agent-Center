import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as vm from "node:vm";
import { createRequire } from "node:module";
import { GOOGLE_WEB_URL, probeWebsite, type NetworkProbeResult } from "../networkProbe";
import type { NetworkStatusPresentation } from "../networkStatus";

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

test("website probe uses public GET without credentials and finishes at headers", async (t) => {
  const app = await server(t, (req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.flushHeaders(); // Deliberately never finish the body.
  });
  const result = await probeWebsite(app, 1000);
  assert.equal(result.status, "available");
  assert.equal(result.httpStatus, 200);
  assert.ok(result.elapsedMs > 0 && result.elapsedMs < 1000);
  assert.equal(GOOGLE_WEB_URL, "https://www.google.com/");
});

test("Google requests use the extension host's supplied HTTPS transport", async (t) => {
  const app = await server(t, (req, res) => {
    assert.equal(req.url, "/");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(200).end();
  });
  const visited: string[] = [];
  const entry = require.resolve("../networkProbe");
  const realRequire = createRequire(entry);
  const module = { exports: {} as typeof import("../networkProbe") };
  // Simulate VS Code's HTTPS hook routing a request through its own transport.
  // A bypass of that hook would attempt an actual external connection and fail.
  vm.runInNewContext(await fs.readFile(entry, "utf8"), {
    module, exports: module.exports,
    require: (name: string) => name === "https" ? {
      request: (url: URL, options: http.RequestOptions & { rejectUnauthorized?: boolean }, callback: (response: http.IncomingMessage) => void) => {
        visited.push(url.href);
        assert.equal(options.agent, undefined);
        assert.equal(options.rejectUnauthorized, undefined);
        return http.request(app, options, callback);
      },
    } : realRequire(name),
    setTimeout, clearTimeout, AbortController, URL,
  }, { filename: entry });
  assert.equal((await module.exports.probeGoogle(1000)).status, "available");
  assert.deepEqual(visited, ["https://www.google.com/"]);
});

test("every HTTP response counts as connected, including errors and browser challenges", async (t) => {
  const app = await server(t, (req, res) => {
    const status = Number(req.url?.slice(1)) || 200;
    res.writeHead(status, status === 200 ? { "cf-mitigated": "challenge" } : {}).end("private server error body");
  });
  for (const status of [200, 204, 301, 302, 400, 401, 403, 407, 429, 500, 503]) {
    const result = await probeWebsite(app + "/" + status, 1000);
    assert.equal(result.status, "available");
    assert.equal(result.httpStatus, status);
    assert.doesNotMatch(JSON.stringify(result), /private server error body/);
    assert.equal(result.detail, "已收到 HTTP 响应");
  }
});

test("redirects count as responses without following same-origin or cross-origin locations", async (t) => {
  const paths: string[] = [];
  const app = await server(t, (req, res) => {
    paths.push(req.url!);
    assert.equal(req.headers.cookie, undefined);
    if (req.url === "/") res.writeHead(302, { Location: "/page", "Set-Cookie": "session=private" }).end();
    else if (req.url === "/page") res.writeHead(200).end();
    else if (req.url === "/external") res.writeHead(302, { Location: "https://example.invalid/" }).end();
    else if (req.url === "/credentials") res.writeHead(302, { Location: "http://name:secret@127.0.0.1/" }).end();
    else res.writeHead(302, { Location: "/loop" }).end();
  });
  assert.equal((await probeWebsite(app, 1000)).status, "available");
  assert.deepEqual(paths, ["/"]);
  for (const path of ["/external", "/credentials", "/loop"]) {
    const result = await probeWebsite(app + path, 1000);
    assert.equal(result.status, "available");
    assert.equal(result.httpStatus, 302);
  }
  assert.deepEqual(paths, ["/", "/external", "/credentials", "/loop"]);
});

test("deadline and cancellation close a request that never responds", async (t) => {
  const app = await server(t, () => {});
  const result = await probeWebsite(app, 100);
  assert.equal(result.status, "error");
  assert.equal(result.detail, "超时");
  assert.ok(result.elapsedMs >= 80 && result.elapsedMs < 1000);
  const abort = new AbortController();
  const pending = probeWebsite(app + "/hung", 5000, abort.signal);
  abort.abort();
  assert.equal((await pending).detail, "已取消");
  assert.equal((await probeWebsite(app, 5000, abort.signal)).detail, "已取消");
});

test("invalid URLs and failed connections have safe diagnostics", async (t) => {
  for (const url of ["invalid", "file:///private", "http://name:secret@localhost/"]) {
    const result = await probeWebsite(url, 100);
    assert.equal(result.detail, "网址无效");
    assert.doesNotMatch(JSON.stringify(result), /secret|private/);
  }
  const app = http.createServer();
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = (app.address() as { port: number }).port;
  await new Promise<void>((resolve) => app.close(() => resolve()));
  const result = await probeWebsite("http://127.0.0.1:" + port, 1000);
  assert.equal(result.status, "error");
  assert.equal(result.detail, "连接被拒绝");
});

async function monitorHarness(t: TestContext) {
  let presentation: NetworkStatusPresentation | undefined;
  const config: Record<string, unknown> = {};
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  let probe: (timeout: number, signal?: AbortSignal) => Promise<NetworkProbeResult> = async () =>
    ({ status: "available", detail: "已收到 HTTP 响应", elapsedMs: 150, httpStatus: 200 });
  const calls: Array<{ timeout: number; signal?: AbortSignal }> = [];
  const fakeVscode = {
    env: { remoteName: "ssh-remote" },
    workspace: {
      isTrusted: true,
      getConfiguration: (section: string) => ({ get: (key: string, fallback: unknown) => config[section + "." + key] ?? fallback }),
    },
    window: { createStatusBarItem: () => { assert.fail("Network checks must reuse the Clash status bar"); } },
  };
  const entry = require.resolve("../networkStatus");
  const realRequire = createRequire(entry);
  const module = { exports: {} as typeof import("../networkStatus") };
  vm.runInNewContext(await fs.readFile(entry, "utf8"), {
    module, exports: module.exports,
    require: (name: string) => name === "vscode" ? fakeVscode : name === "./networkProbe" ? {
      GOOGLE_WEB_URL,
      probeGoogle: (timeout: number, signal?: AbortSignal) => { calls.push({ timeout, signal }); return probe(timeout, signal); },
    } : realRequire(name),
    setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id: number) => { timers.delete(id); },
    AbortController,
  }, { filename: entry });
  const monitor = new module.exports.NetworkStatusMonitor((value) => { presentation = value; });
  t.after(() => monitor.dispose());
  return { monitor, config, fakeVscode, calls, timers, presentation: () => presentation,
    setProbe: (value: typeof probe) => { probe = value; } };
}

test("Google-only detection publishes just one icon with details for the shared hover", async (t) => {
  const h = await monitorHarness(t);
  h.config["http.proxy"] = "http://private-user:private-password@localhost:7890";
  await h.monitor.refresh();
  assert.equal(h.presentation()?.icon, "✅️");
  const tooltip = h.presentation()!.tooltip;
  assert.match(tooltip, /远程扩展宿主/);
  assert.match(tooltip, /https:\/\/www.google.com\//);
  assert.match(tooltip, /agentStatus.refreshNetwork/);
  assert.match(tooltip, /每 5 小时检测/);
  assert.doesNotMatch(tooltip, /claude|chatgpt|backend-api|Authorization|private-password/i);
  assert.doesNotMatch(JSON.stringify(h.monitor.getDiagnostics()), /private-user|private-password/);
  assert.equal(h.calls[0].timeout, 15000);
  h.setProbe(async () => ({ status: "available", detail: "已收到 HTTP 响应", httpStatus: 403, elapsedMs: 200 }));
  await h.monitor.refresh();
  assert.equal(h.presentation()?.icon, "✅️");
  assert.match(h.presentation()!.tooltip, /HTTP 403/);
  h.setProbe(async () => ({ status: "error", detail: "超时", elapsedMs: 15000 }));
  await h.monitor.refresh();
  assert.equal(h.presentation()?.icon, "❌");
  assert.match(h.presentation()!.tooltip, /超时/);
});

test("starts immediately, schedules five-hour checks and coalesces manual refreshes", async (t) => {
  const h = await monitorHarness(t);
  h.monitor.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 1);
  const timer = [...h.timers.entries()][0];
  assert.equal(timer[1].delay, 18000000);
  h.timers.delete(timer[0]);
  timer[1].callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 1);
  let complete!: (value: NetworkProbeResult) => void;
  h.setProbe(() => new Promise((resolve) => { complete = resolve; }));
  const first = h.monitor.refresh("manual");
  const second = h.monitor.refresh("manual");
  assert.equal(first, second);
  assert.equal(h.presentation()?.icon, "✅️", "Keep the compact previous result during refresh");
  complete({ status: "available", detail: "网页可访问", elapsedMs: 1, httpStatus: 200 });
  await first;
  assert.equal(h.calls.length, 3);
});

test("disabled and untrusted workspaces make no requests; reload cancels and ignores old results", async (t) => {
  const h = await monitorHarness(t);
  h.fakeVscode.workspace.isTrusted = false;
  h.monitor.start();
  await h.monitor.refresh("manual");
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
  h.fakeVscode.workspace.isTrusted = true;
  h.config["agentStatus.network.enabled"] = false;
  h.monitor.reloadConfiguration();
  await h.monitor.refresh();
  assert.equal(h.calls.length, 0);
  h.config["agentStatus.network.enabled"] = true;
  let complete!: (value: NetworkProbeResult) => void;
  h.setProbe(() => new Promise((resolve) => { complete = resolve; }));
  const pending = h.monitor.refresh();
  const signal = h.calls[0].signal;
  h.config["agentStatus.network.enabled"] = false;
  h.monitor.reloadConfiguration();
  assert.ok(signal?.aborted);
  complete({ status: "available", detail: "网页可访问", elapsedMs: 1, httpStatus: 200 });
  await pending;
  assert.equal(h.presentation(), undefined);
  assert.equal(h.monitor.getDiagnostics().result, undefined);
  h.config["agentStatus.network.enabled"] = true;
  const last = h.monitor.refresh();
  h.monitor.dispose();
  complete({ status: "available", detail: "网页可访问", elapsedMs: 1, httpStatus: 200 });
  await last;
  assert.equal(h.presentation(), undefined);
});

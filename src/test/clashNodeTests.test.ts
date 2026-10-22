import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as http from "node:http";
import { ClashApiClient, type ClashProxies } from "../clashApi";
import { CLASH_TEST_URL } from "../clashConfig";
import { clashNodeNames, clashNodeTestContext, testClashNodes, sortedNodeDelays, type ClashNodeDelay } from "../clashNodeTests";

async function controller(t: TestContext, handle: http.RequestListener): Promise<string> {
  const server = http.createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return "http://127.0.0.1:" + (server.address() as { port: number }).port;
}

test("all-node enumeration excludes groups and built-ins by type, retains provider nodes and has a stable context", () => {
  const proxies: ClashProxies = {
    "🇭🇰 Hong Kong": { type: "VLESS" }, DIRECT: { type: "Shadowsocks" },
    "provider-node": { type: "Hysteria2" }, "custom direct": { type: "Direct" },
    group: { type: "Selector", all: [] }, automatic: { type: "URLTest" },
    reject: { type: "RejectDrop" }, pass: { type: "Pass" }, dns: { type: "DNS" },
  };
  assert.deepEqual(clashNodeNames(proxies), ["🇭🇰 Hong Kong", "DIRECT", "provider-node"]);
  const key = clashNodeTestContext("http://localhost:1", "/config", "sub", proxies);
  assert.equal(key, clashNodeTestContext("http://localhost:1", "/config", "sub", Object.fromEntries(Object.entries(proxies).reverse())));
  assert.notEqual(key, clashNodeTestContext("http://localhost:1", "/config", "new-sub", proxies));
  assert.notEqual(key, clashNodeTestContext("http://localhost:1", "/config", "sub", { ...proxies, newNode: { type: "VMess" } }));
});

test("all-node requests run five at a time, isolate failures and never send selection writes", async (t) => {
  const names = Array.from({ length: 13 }, (_, i) => "节点 " + i);
  let active = 0, peak = 0;
  const seen: string[] = [];
  const url = await controller(t, (req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer private-test-secret");
    const target = new URL(req.url!, "http://localhost");
    assert.equal(target.searchParams.get("url"), CLASH_TEST_URL);
    assert.equal(target.searchParams.get("timeout"), "1000");
    const node = decodeURIComponent(target.pathname.split("/")[2]);
    seen.push(node); active++; peak = Math.max(active, peak);
    setTimeout(() => { active--; if (node === names[4]) res.writeHead(500).end(); else res.end(JSON.stringify({ delay: 30 - names.indexOf(node) })); }, 15);
  });
  const api = new ClashApiClient({ controller: url, secret: "private-test-secret", timeoutMs: 1000 });
  const results: ClashNodeDelay[] = [];
  await testClashNodes(api, [...names, names[0]], CLASH_TEST_URL, 1000, new AbortController().signal, (result) => results.push(result));
  assert.equal(peak, 5);
  assert.equal(active, 0);
  assert.deepEqual([...seen].sort(), [...names].sort());
  assert.equal(results.length, names.length);
  assert.equal(results.filter((result) => result.delay.ok).length, 12);
  const sorted = sortedNodeDelays(results);
  assert.equal(sorted[0].node, names[12]);
  assert.equal(sorted.at(-1)?.node, names[4]);
});

test("cancellation aborts in-flight requests and does not schedule the remaining nodes", async (t) => {
  let count = 0, ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const url = await controller(t, () => { if (++count === 5) ready(); });
  const abort = new AbortController();
  const api = new ClashApiClient({ controller: url, secret: "", timeoutMs: 5000 });
  const results: ClashNodeDelay[] = [];
  const pending = testClashNodes(api, Array.from({ length: 30 }, (_, i) => String(i)), CLASH_TEST_URL, 5000, abort.signal, (result) => results.push(result));
  await started;
  abort.abort();
  await pending;
  assert.equal(count, 5);
  assert.deepEqual(results, []);
  await testClashNodes(api, ["already-cancelled"], CLASH_TEST_URL, 5000, abort.signal, () => assert.fail("No result after cancellation"));
  assert.equal(count, 5);
});

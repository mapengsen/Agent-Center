import assert from "node:assert/strict";
import test from "node:test";
import type { ClashState } from "../clashApi";
import { findBestClashNode, selectBestClashNode } from "../clashBestNode";

function fixture(): ClashState {
  return { mode: "rule", proxies: {
    main: { type: "Selector", all: ["automatic", "manual", "slow"], now: "automatic" },
    manual: { type: "Selector", all: ["old", "fast", "main"], now: "old" },
    automatic: { type: "URLTest", all: ["fast", "outside"], now: "fast" },
    fast: { type: "VLESS" }, old: { type: "VLESS" }, slow: { type: "Shadowsocks" }, outside: { type: "VLESS" },
    other: { type: "Selector", all: ["outside", "old"], now: "outside" },
  } };
}
const results = [
  { node: "outside", delay: { ok: true as const, ms: 1 } },
  { node: "fast", delay: { ok: true as const, ms: 20 } },
  { node: "old", delay: { ok: false as const, error: "timeout" } },
  { node: "slow", delay: { ok: true as const, ms: 200 } },
];
function harness() {
  const state = fixture();
  const writes: Array<{ group: string; node: string }> = [];
  const api = {
    getState: async () => structuredClone(state),
    getProxies: async () => structuredClone(state.proxies),
    select: async (group: string, node: string) => { writes.push({ group, node }); state.proxies[group].now = node; },
  };
  const baseline = structuredClone(state);
  const plan = findBestClashNode(baseline, "main", results)!;
  return { state, baseline, plan, api, writes };
}

test("best-node planning follows manual selector paths, avoids cycles and excludes faster unreachable nodes", () => {
  const state = fixture();
  const plan = findBestClashNode(state, "main", results)!;
  assert.equal(plan.node, "fast");
  assert.deepEqual(plan.selections.map(({ group, node }) => [group, node]), [["main", "manual"], ["manual", "fast"]]);
  assert.equal(findBestClashNode({ ...state, mode: "direct" }, "main", results), undefined);
  assert.equal(findBestClashNode(state, "automatic", results), undefined);
  assert.equal(findBestClashNode(state, "main", results.map(({ node }) => ({ node, delay: { ok: false, error: "timeout" } }))), undefined);
});

test("equal latencies prefer the current final node and an already-selected best node needs no writes", async () => {
  const h = harness();
  h.state.proxies.main.now = "manual"; h.state.proxies.manual.now = "fast";
  const tied = [...results, { node: "old", delay: { ok: true as const, ms: 20 } }];
  const plan = findBestClashNode(h.state, "main", tied)!;
  assert.equal(plan.node, "fast");
  const result = await selectBestClashNode(h.api, structuredClone(h.state), plan, new AbortController().signal);
  assert.equal(result.changed, false);
  assert.deepEqual(h.writes, []);
});

test("best-node switching applies inner selectors first, verifies the final node and preserves unrelated groups", async () => {
  const h = harness();
  const result = await selectBestClashNode(h.api, h.baseline, h.plan, new AbortController().signal);
  assert.equal(result.changed, true);
  assert.deepEqual(h.writes, [{ group: "manual", node: "fast" }, { group: "main", node: "manual" }]);
  assert.equal(h.state.mode, "rule");
  assert.equal(h.state.proxies.other.now, "outside");
  assert.equal(h.state.proxies.automatic.now, "fast");
});

for (const change of ["selection", "mode", "cancel", "inactive", "membership"] as const) {
  test(`best-node switching refuses a stale or cancelled ${change} before any writes`, async () => {
    const h = harness(), abort = new AbortController();
    if (change === "selection") h.state.proxies.main.now = "slow";
    if (change === "mode") h.state.mode = "direct";
    if (change === "cancel") abort.abort();
    if (change === "membership") h.state.proxies.manual.all = ["old"];
    await assert.rejects(selectBestClashNode(h.api, h.baseline, h.plan, abort.signal, () => change !== "inactive"));
    assert.deepEqual(h.writes, []);
  });
}

test("a request that changed the core before timing out is rolled back with all previous writes", async () => {
  const h = harness();
  const write = h.api.select;
  h.api.select = async (group, node) => { await write(group, node); if (group === "main" && node === "manual") throw new Error("timeout"); };
  await assert.rejects(selectBestClashNode(h.api, h.baseline, h.plan, new AbortController().signal), /已恢复原节点选择/);
  assert.deepEqual(h.state, h.baseline);
  assert.deepEqual(h.writes.slice(-2), [{ group: "main", node: "automatic" }, { group: "manual", node: "old" }]);
});

test("cancellation after a write restores the original choices", async () => {
  const h = harness(), abort = new AbortController(), write = h.api.select;
  h.api.select = async (group, node) => { await write(group, node); if (node === "fast") abort.abort(); };
  await assert.rejects(selectBestClashNode(h.api, h.baseline, h.plan, abort.signal), /已恢复原节点选择/);
  assert.deepEqual(h.state, h.baseline);
});

test("failed verification never claims success and does not overwrite another client's later choice", async () => {
  const h = harness();
  h.api.select = async (group, node) => { h.writes.push({ group, node }); h.state.proxies[group].now = "slow"; };
  await assert.rejects(selectBestClashNode(h.api, h.baseline, h.plan, new AbortController().signal), /未完全恢复/);
  assert.equal(h.state.proxies.manual.now, "slow");
  assert.equal(h.writes.length, 1);
});

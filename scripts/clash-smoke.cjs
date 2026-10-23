// Run on the Clash host after compiling. --switch temporarily selects the same
// final node directly, then restores the original selector entry in finally.
const assert = require("node:assert/strict");
const { ClashApiClient, findActiveGroup, resolveProxyChain } = require("../out/clashApi");
const { loadClashConnection, CLASH_TEST_URL } = require("../out/clashConfig");
const { formatClashDelay, clashTooltip } = require("../out/clashPresentation");

async function main() {
  const settings = {
    controller: "", secret: "", configPath: "", group: "",
    testTimeoutMs: 8000, updateIntervalSeconds: 60,
  };
  const connection = await loadClashConnection(settings);
  const api = new ClashApiClient(connection);
  const state = await api.getState();
  const group = findActiveGroup(state, "", connection.preferredGroups);
  const chain = resolveProxyChain(state.proxies, group);
  const original = state.proxies[group]?.now;
  const delay = await api.testDelay(original ?? group, CLASH_TEST_URL, 8000);
  console.log(JSON.stringify({
    configPath: connection.configPath, controller: connection.controller,
    mode: state.mode, group, chain, speed: formatClashDelay(delay),
  }, null, 2));
  const tooltip = clashTooltip({ state, group, chain, delay, updatedAt: new Date() });
  assert.ok(tooltip.includes("当前节点"));
  assert.ok(tooltip.includes("command:agentStatus.chooseClashNode"));
  console.log("PASS: real configuration, current-node chain, Google delay and hover command links");
  assert.ok(delay.ok, "Google was not reachable: " + (delay.error ?? ""));

  const rejected = await api.testDelay("REJECT", CLASH_TEST_URL, 1000);
  assert.equal(rejected.ok, false);
  assert.equal(formatClashDelay(rejected), "× 超时");
  console.log("PASS: unreachable-node timeout display");
  if (!process.argv.includes("--switch")) return;

  assert.equal(state.proxies[group].type, "Selector");
  // Prefer the current automatic group's leaf: this exercises PUT without changing egress.
  const candidate = chain.at(-1);
  assert.ok(candidate && candidate !== original && state.proxies[group].all.includes(candidate),
    "No different selector entry with the same final node was available for a safe smoke test.");
  let attempted = false;
  try {
    attempted = true;
    await api.select(group, candidate);
    assert.equal((await api.getProxies())[group].now, candidate);
    console.log("PASS: switched " + group + " from " + original + " to " + candidate);
    const updated = await api.testDelay(candidate, CLASH_TEST_URL, 8000);
    assert.ok(updated.ok);
    console.log("AFTER_SWITCH: " + formatClashDelay(updated));
  } finally {
    if (attempted) {
      let restored = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await api.select(group, original);
          assert.equal((await api.getProxies())[group].now, original);
          restored = true;
          break;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
      assert.ok(restored);
      console.log("RESTORED: " + group + " -> " + original);
    }
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

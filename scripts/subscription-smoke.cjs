// Supply a private subscription URL on stdin; never embed it in this script.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { discoverClashSubscriptions } = require("../out/clashSubscriptions");
const { loadClashConnection, CLASH_TEST_URL } = require("../out/clashConfig");
const { ClashApiClient, findActiveGroup, resolveProxyChain } = require("../out/clashApi");
const { formatClashDelay } = require("../out/clashPresentation");

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const url = Buffer.concat(chunks).toString("utf8").trim();
  assert.ok(url);
  const settings = { controller: "", secret: "", configPath: "", group: "", testTimeoutMs: 8000, updateIntervalSeconds: 60 };
  const connection = await loadClashConnection(settings);
  const manager = await discoverClashSubscriptions(connection.configPath);
  const api = new ClashApiClient(connection);
  const originalList = await manager.list();
  const originalState = await api.getState();
  const originalConfig = await fs.readFile(connection.configPath);
  const name = "new-subscription";
  // Preserve the running configuration as an emergency recovery artifact until verified.
  const backupDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-center-subscription-smoke-"));
  await fs.chmod(backupDirectory, 0o700);
  const backup = path.join(backupDirectory, "original-config.yaml");
  await fs.writeFile(backup, originalConfig, { mode: 0o600 });
  console.log("RECOVERY_BACKUP: " + backup);
  assert.ok(!originalList.sources.some((source) => source.name === name), "Test subscription name already exists");
  await manager.add(name, url);
  assert.equal((await manager.list()).active, originalList.active);
  assert.ok(originalConfig.equals(await fs.readFile(connection.configPath)));
  console.log("PASS: saved new-subscription; active subscription and runtime configuration unchanged");
  let attempted = false;
  try {
    attempted = true;
    await manager.use(name, connection);
    assert.equal((await manager.list()).active, name);
    const updatedConnection = await loadClashConnection(settings);
    const updatedApi = new ClashApiClient(updatedConnection);
    const state = await updatedApi.getState();
    const group = findActiveGroup(state, "", updatedConnection.preferredGroups);
    const delay = await updatedApi.testDelay(state.proxies[group]?.now ?? group, CLASH_TEST_URL, 8000);
    console.log(JSON.stringify({ subscription: name, mode: state.mode, nodes: Object.keys(state.proxies).length, speed: formatClashDelay(delay) }));
    assert.ok(delay.ok, "New subscription Google connectivity test failed");
    console.log("PASS: native subscription switch, controller readiness and Google connectivity");
  } finally {
    if (attempted) {
      const currentConnection = await loadClashConnection(settings);
      await manager.use(originalList.active, currentConnection);
      const restoredApi = new ClashApiClient(await loadClashConnection(settings));
      const current = await restoredApi.getProxies();
      for (const [group, proxy] of Object.entries(originalState.proxies)) {
        if (proxy.type === "Selector" && proxy.now && current[group]?.all?.includes(proxy.now)) {
          if (current[group].now !== proxy.now) await restoredApi.select(group, proxy.now);
        }
      }
      const verified = await restoredApi.getState();
      for (const [group, proxy] of Object.entries(originalState.proxies)) {
        if (proxy.type === "Selector" && proxy.now) assert.equal(verified.proxies[group]?.now, proxy.now);
      }
      assert.equal((await manager.list()).active, originalList.active);
      const group = findActiveGroup(verified, "", connection.preferredGroups);
      const delay = await restoredApi.testDelay(verified.proxies[group]?.now ?? group, CLASH_TEST_URL, 8000);
      console.log(JSON.stringify({ restoredSubscription: originalList.active, chain: resolveProxyChain(verified.proxies, group), speed: formatClashDelay(delay) }));
      assert.ok(delay.ok, "Original subscription Google connectivity test failed");
      await fs.unlink(backup);
      await fs.rmdir(backupDirectory);
      console.log("RESTORED: original subscription and all manual node selections; new subscription remains saved");
    }
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

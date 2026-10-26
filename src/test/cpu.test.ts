import assert from "node:assert/strict";
import test from "node:test";
import type { CpuInfo } from "node:os";
import { CpuUsageSampler, cpuUsageBetween, snapshotCpu } from "../cpuUsage";

function cpus(count: number, user: number, idle: number, nice = 0, sys = 0, irq = 0): CpuInfo[] {
  return Array.from({ length: count }, () => ({ model: "test CPU", speed: 2000, times: { user, nice, sys, idle, irq } }));
}

test("CPU aggregate uses 100% per logical core and reports a separate whole-machine percentage", () => {
  const before = snapshotCpu(cpus(32, 100, 100))!, after = snapshotCpu(cpus(32, 150, 150))!;
  assert.deepEqual(cpuUsageBetween(before, after), { state: "ready", logicalCores: 32, totalPercent: 1600, machinePercent: 50, coresUsed: 16 });
  assert.equal(cpuUsageBetween(before, snapshotCpu(cpus(32, 200, 100))!)!.totalPercent, 3200);
  assert.equal(cpuUsageBetween(before, snapshotCpu(cpus(32, 100, 200))!)!.totalPercent, 0);
  assert.equal(snapshotCpu(cpus(1, 10, 40, 20, 30, 50))!.total, 150);
});

test("invalid data, hotplug, rollback and zero intervals never fabricate CPU readings", () => {
  assert.equal(snapshotCpu([]), undefined);
  assert.equal(snapshotCpu(cpus(1, NaN, 100)), undefined);
  assert.equal(snapshotCpu(cpus(1, -1, 100)), undefined);
  const before = { cores: 4, total: 1000, idle: 500 };
  for (const after of [before, { cores: 2, total: 2000, idle: 600 }, { cores: 4, total: 900, idle: 500 },
    { cores: 4, total: 2000, idle: 400 }, { cores: 4, total: 1100, idle: 900 }, { cores: 4, total: Infinity, idle: 600 }]) {
    assert.equal(cpuUsageBetween(before, after), undefined);
  }
});

test("sampler measures a fresh interval on first use and after reset instead of a lifetime average", async () => {
  let user = 1000, idle = 0, warmups = 0;
  const sampler = new CpuUsageSampler(() => cpus(32, user, idle), async () => { warmups++; user += 50; idle += 50; return true; });
  assert.equal((await sampler.read()).totalPercent, 1600); assert.equal(warmups, 1);
  user += 25; idle += 75;
  assert.equal((await sampler.read()).totalPercent, 800); assert.equal(warmups, 1);
  sampler.reset(); user += 100000;
  assert.equal((await sampler.read()).totalPercent, 1600); assert.equal(warmups, 2);
});

test("reset, abort and unsupported CPU sources cannot publish an old warmup", async () => {
  let finish!: (value: boolean) => void;
  const sampler = new CpuUsageSampler(() => cpus(4, 100, 100), () => new Promise(resolve => { finish = resolve; }));
  const pending = sampler.read(); sampler.reset(); finish(true);
  assert.equal((await pending).state, "unavailable");
  const abort = new AbortController(); abort.abort();
  assert.equal((await sampler.read(abort.signal)).state, "unavailable");
  assert.equal((await new CpuUsageSampler(() => []).read()).state, "unavailable");
  assert.equal((await new CpuUsageSampler(() => { throw new Error("unavailable"); }).read()).state, "unavailable");
  const realWarmup = new CpuUsageSampler(() => cpus(4, 100, 100)), stop = new AbortController();
  const stopped = realWarmup.read(stop.signal); stop.abort();
  assert.equal((await stopped).state, "unavailable");
});

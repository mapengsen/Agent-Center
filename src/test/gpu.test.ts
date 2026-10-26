import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as vm from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { NvidiaSmiResult } from "../nvidiaSmi";

async function readerHarness() {
  const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
  const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal: string) => void; killed: boolean }> = [];
  const timers = new Map<number, () => void>();
  let id = 0;
  const entry = require.resolve("../nvidiaSmi"), realRequire = createRequire(entry);
  const module = { exports: {} as typeof import("../nvidiaSmi") };
  vm.runInNewContext(await fs.readFile(entry, "utf8"), {
    module, exports: module.exports, process: { platform: "linux", env: {} }, Buffer,
    require: (name: string) => name === "node:child_process" ? { spawn: (file: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ file, args, options });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
        kill: (_signal: string) => { child.killed = true; } });
      children.push(child);
      return child;
    } } : realRequire(name),
    setTimeout: (callback: () => void) => { timers.set(++id, callback); return id; },
    clearTimeout: (timer: number) => timers.delete(timer),
  });
  return { read: module.exports.readNvidiaSmi, calls, children, timers };
}

test("nvidia-smi is sampled without a shell, preserving the raw table and stripping terminal controls", async () => {
  const h = await readerHarness();
  const pending = h.read("/opt/NVIDIA tools/nvidia-smi");
  assert.equal(h.calls[0].file, "/opt/NVIDIA tools/nvidia-smi");
  assert.deepEqual(Array.from(h.calls[0].args), []);
  assert.equal(h.calls[0].options.shell, false);
  assert.equal(h.calls[0].options.windowsHide, true);
  const child = h.children[0];
  child.stdout.write("\x1b[32m+--- NVIDIA-SMI ---+\x1b[0m\r\n| 0 A800  100MiB / 80GiB |\r\n");
  child.stderr.write("driver warning\n");
  child.emit("close", 0);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.match(result.output, /\+--- NVIDIA-SMI ---\+\n\| 0 A800/);
  assert.match(result.output, /driver warning/);
  assert.doesNotMatch(result.output, /\x1b|\r/);
  assert.equal(h.timers.size, 0);
});

test("missing executables and driver errors remain informative without exposing spawn exception text", async () => {
  const h = await readerHarness();
  const missing = h.read();
  h.children[0].emit("error", Object.assign(new Error("private-exception-details"), { code: "ENOENT" }));
  h.children[0].emit("close", -2);
  const result = await missing;
  assert.equal(result.ok, false);
  assert.match(result.detail, /未找到 nvidia-smi/);
  assert.doesNotMatch(JSON.stringify(result), /private-exception-details/);
  const failed = h.read();
  h.children[1].stderr.write("NVIDIA-SMI has failed to communicate with the NVIDIA driver.");
  h.children[1].emit("close", 9);
  assert.match((await failed).output, /NVIDIA driver/);
});

test("timeouts, oversized output and cancellation kill the child and wait for close", async () => {
  for (const reason of ["timeout", "oversize", "abort"] as const) {
    const h = await readerHarness(), abort = new AbortController();
    let settled = false;
    const pending = h.read("nvidia-smi", abort.signal).then((value) => { settled = true; return value; });
    const child = h.children[0];
    if (reason === "timeout") h.timers.values().next().value!();
    if (reason === "oversize") child.stdout.write(Buffer.alloc(1024 * 1024 + 1));
    if (reason === "abort") abort.abort();
    assert.equal(child.killed, true);
    await Promise.resolve(); assert.equal(settled, false);
    child.emit("close", null);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.detail, reason === "timeout" ? /超时/ : reason === "oversize" ? /1 MiB/ : /暂停/);
    assert.equal(h.timers.size, 0);
  }
  const h = await readerHarness(), abort = new AbortController();
  abort.abort();
  assert.equal((await h.read("nvidia-smi", abort.signal)).detail, "已暂停");
  assert.equal(h.calls.length, 0);
});

async function monitorHarness(t: TestContext, multi = false) {
  const config: Record<string, unknown> = {}, commands: string[] = [];
  const calls: Array<{ path: string; signal?: AbortSignal }> = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let id = 0, visible = false;
  let probe: (signal?: AbortSignal) => Promise<NvidiaSmiResult> = async () => ({ ok: true, detail: "采样成功", output: "+--- NVIDIA-SMI ---+\n| 0 A800 42% |" });
  let cpuProbe: (signal?: AbortSignal) => Promise<import("../cpuUsage").CpuUsage> = async () =>
    ({ state: "ready", logicalCores: 64, totalPercent: 1600, machinePercent: 25, coresUsed: 16 });
  const servers: import("../gpuServerConfig").GpuServer[] = [
    { id: "server1", name: "40901", host: "test-host", port: 22, username: "root", password: "private-server-password" },
    { id: "server2", name: "h20*8", host: "test-host", port: 23, username: "root", password: "private-server-password" },
  ];
  let changed = () => {};
  const catalog = { servers, detail: "", reload: async () => {}, onDidChange: (listener: () => void) => { changed = listener; return { dispose: () => {} }; }, dispose: () => {} };
  const remoteCalls: Array<{ server: import("../gpuServerConfig").GpuServer; signal?: AbortSignal }> = [];
  let remoteProbe: (server: import("../gpuServerConfig").GpuServer, signal?: AbortSignal) => Promise<import("../gpuSsh").RemoteGpuSample> = async server =>
    ({ gpu: { ok: true, output: "GPU of " + server.name, detail: "采样成功" }, cpu: { state: "ready", logicalCores: 8, totalPercent: 200, machinePercent: 25, coresUsed: 2 } });
  const remote = { read: (server: import("../gpuServerConfig").GpuServer, signal?: AbortSignal) => { remoteCalls.push({ server, signal }); return remoteProbe(server, signal); }, reset: () => {}, dispose: () => {} };
  const probeCalls: Array<{ server: import("../gpuServerConfig").GpuServer; signal?: AbortSignal }> = [];
  let check: (server: import("../gpuServerConfig").GpuServer, signal?: AbortSignal) => Promise<boolean> = async () => true;
  const connectivity = { check: (server: import("../gpuServerConfig").GpuServer, signal?: AbortSignal) => { probeCalls.push({ server, signal }); return check(server, signal); }, dispose: () => {} };
  const bar = { text: "", command: "", name: "", tooltip: undefined as any,
    show: () => { visible = true; }, hide: () => { visible = false; }, dispose: () => { visible = false; } };
  const vscode = {
    StatusBarAlignment: { Right: 2 }, env: { remoteName: "ssh-remote" },
    MarkdownString: class {
      public supportHtml = false;
      public isTrusted: unknown;
      public constructor(public value: string) {}
    },
    workspace: { isTrusted: true, getConfiguration: (section: string) => ({ get: (key: string, fallback: unknown) => config[section + "." + key] ?? fallback }) },
    commands: { executeCommand: async (name: string) => { commands.push(name); } },
    window: { createStatusBarItem: () => bar,
      createTerminal: () => assert.fail("GPU monitoring must not open a terminal"),
      registerWebviewViewProvider: () => assert.fail("GPU must use its native status-bar hover"),
      createWebviewPanel: () => assert.fail("GPU must not open an editor or webview panel") },
  };
  const entry = require.resolve("../gpuStatus"), realRequire = createRequire(entry);
  const module = { exports: {} as typeof import("../gpuStatus") };
  vm.runInNewContext(await fs.readFile(entry, "utf8"), { module, exports: module.exports,
    require: (name: string) => name === "vscode" ? vscode : name === "./nvidiaSmi" ? {
      readNvidiaSmi: (path: string, signal?: AbortSignal) => { calls.push({ path, signal }); return probe(signal); },
    } : realRequire(name), AbortController,
    setTimeout: (callback: () => void, delay: number) => { timers.set(++id, { callback, delay }); return id; },
    clearTimeout: (timer: number) => timers.delete(timer),
  });
  const monitor = new module.exports.GpuStatusMonitor({ reset: () => {}, read: signal => cpuProbe(signal) }, multi ? catalog : undefined, multi ? remote : undefined, multi ? connectivity : undefined);
  t.after(() => monitor.dispose());
  const tick = async () => {
    const [key, timer] = timers.entries().next().value!;
    timers.delete(key); timer.callback(); await flush();
  };
  return { monitor, config, vscode, bar, commands, calls, timers, tick, visible: () => visible, catalog, servers, remoteCalls, probeCalls, setCheck: (next: typeof check) => { check = next; }, changed: () => changed(),
    tooltip: () => bar.tooltip.value as string,
    setProbe: (next: typeof probe) => { probe = next; },
    setCpuProbe: (next: typeof cpuProbe) => { cpuProbe = next; }, setRemoteProbe: (next: typeof remoteProbe) => { remoteProbe = next; } };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("startup prepares a native hover without a click; GPU/CPU refresh every two seconds without opening editors", async (t) => {
  const h = await monitorHarness(t);
  h.config["agentStatus.gpu.nvidiaSmiPath"] = "/opt/NVIDIA tools/nvidia-smi";
  h.monitor.start(); await flush();
  assert.equal(h.visible(), true); assert.equal(h.calls.length, 1);
  assert.equal(h.bar.command, "agentStatus.showGpuMonitor"); assert.deepEqual(h.commands, []);
  assert.match(h.tooltip(), /CPU 总占用：<span style="color:#007acc;">1600.0%<\/span>/);
  assert.match(h.tooltip(), /16.00.*64.*25.0%/);
  assert.match(h.tooltip(), /<h3><code>CPU 总占用：/);
  assert.match(h.tooltip(), /<pre><code>约 16.00.*25.0%<\/code><\/pre>/);
  assert.match(h.tooltip(), /```text\n\+--- NVIDIA-SMI ---\+\n```/);
  assert.match(h.tooltip(), /<pre><code>\| 0 A800 42%/);
  assert.equal(h.calls[0].path, "/opt/NVIDIA tools/nvidia-smi");
  assert.equal(h.timers.values().next().value!.delay, 2000);
  h.setProbe(async () => ({ ok: true, output: "A800 84%", detail: "采样成功" }));
  await h.tick();
  assert.match(h.tooltip(), /A800 84%/); assert.equal(h.calls.length, 2);
  // Updating hidden hover data never explicitly opens a hover again.
  assert.deepEqual(h.commands, []);
  assert.equal(h.monitor.getDiagnostics().intervalSeconds, 2);
  assert.equal(h.monitor.getDiagnostics().presentation, "native-hover");
});

test("click resumes and shows only the native hover; pausing retains CPU/GPU and manual refresh is single-shot", async (t) => {
  const h = await monitorHarness(t);
  h.monitor.start(); await flush();
  await h.monitor.show(); assert.deepEqual(h.commands, ["workbench.action.showHover"]);
  assert.equal(h.calls.length, 1);
  h.monitor.pause();
  assert.equal(h.timers.size, 0); assert.match(h.tooltip(), /监控已暂停/);
  assert.match(h.tooltip(), /A800 42%/); assert.match(h.tooltip(), /1600.0%/);
  assert.match(h.tooltip(), /command:agentStatus.showGpuMonitor/);
  h.setProbe(async () => ({ ok: true, output: "single sample", detail: "采样成功" }));
  await h.monitor.refresh(); assert.equal(h.timers.size, 0);
  assert.equal(h.monitor.getDiagnostics().watching, false); assert.match(h.tooltip(), /single sample/);
  await h.monitor.show(); await flush(); assert.equal(h.timers.values().next().value!.delay, 2000);
});

test("slow reads deduplicate and pause/resume waits for child exit without publishing stale samples", async (t) => {
  const h = await monitorHarness(t);
  let finish!: (value: NvidiaSmiResult) => void;
  h.setProbe(() => new Promise(resolve => { finish = resolve; }));
  h.monitor.start();
  const first = h.monitor.refresh();
  assert.equal(first, h.monitor.refresh()); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
  h.monitor.pause(); assert.equal(h.calls[0].signal!.aborted, true);
  h.setProbe(async () => ({ ok: true, output: "fresh sample", detail: "采样成功" }));
  await h.monitor.show(); assert.equal(h.calls.length, 1);
  finish({ ok: true, output: "stale sample", detail: "" });
  await first; await h.monitor.refresh();
  assert.equal(h.calls.length, 2); assert.match(h.tooltip(), /fresh sample/); assert.doesNotMatch(h.tooltip(), /stale sample/);
});

test("cancelling during CPU sampling cannot publish stale CPU or overlap the next sample", async (t) => {
  const h = await monitorHarness(t);
  let finish!: (value: import("../cpuUsage").CpuUsage) => void, cpuSignal: AbortSignal | undefined;
  h.setCpuProbe(signal => { cpuSignal = signal; return new Promise(resolve => { finish = resolve; }); });
  h.monitor.start(); await flush();
  const first = h.monitor.refresh();
  h.monitor.pause(); assert.equal(cpuSignal!.aborted, true);
  h.setCpuProbe(async () => ({ state: "unavailable", logicalCores: 0 }));
  await h.monitor.show(); assert.equal(h.calls.length, 1);
  finish({ state: "ready", logicalCores: 64, totalPercent: 999, machinePercent: 15, coresUsed: 9.99 });
  await first; await h.monitor.refresh();
  assert.equal(h.calls.length, 2); assert.match(h.tooltip(), /CPU 暂不可用/); assert.doesNotMatch(h.tooltip(), /999/);
});

test("disabled/untrusted states never sample; reload cancels stale reads and resumes only when enabled", async (t) => {
  const h = await monitorHarness(t);
  h.config["agentStatus.gpu.enabled"] = false;
  h.monitor.start(); await h.monitor.show(); await h.monitor.refresh();
  assert.equal(h.calls.length, 0); assert.equal(h.visible(), false);
  h.config["agentStatus.gpu.enabled"] = true; h.vscode.workspace.isTrusted = false;
  h.monitor.reloadConfiguration(); await h.monitor.show(); assert.equal(h.calls.length, 0);
  h.vscode.workspace.isTrusted = true; h.monitor.reloadConfiguration(); await flush();
  assert.equal(h.calls.length, 1);
  h.config["agentStatus.gpu.enabled"] = false; h.monitor.reloadConfiguration();
  assert.equal(h.timers.size, 0); assert.equal(h.visible(), false);
  h.monitor.dispose(); h.config["agentStatus.gpu.enabled"] = true;
  h.monitor.start(); await h.monitor.show(); await h.monitor.refresh(); assert.equal(h.calls.length, 1);
});

test("GPU failures pause with CPU data retained, and CPU failures do not stop healthy GPU monitoring", async (t) => {
  const h = await monitorHarness(t);
  h.setProbe(async () => ({ ok: false, output: "Failed to initialize NVML", detail: "驱动不可用" }));
  h.monitor.start(); await flush();
  assert.equal(h.timers.size, 0); assert.equal(h.monitor.getDiagnostics().watching, false);
  assert.match(h.tooltip(), /NVML/); assert.match(h.tooltip(), /CPU 总占用：<span style="color:#007acc;">1600.0%<\/span>/);
  assert.doesNotMatch(JSON.stringify(h.monitor.getDiagnostics()), /NVML/);
  h.setProbe(async () => ({ ok: true, output: "healthy", detail: "采样成功" }));
  h.setCpuProbe(async () => { throw new Error("CPU source unavailable"); });
  await h.monitor.show(); await flush();
  assert.match(h.tooltip(), /CPU 暂不可用/); assert.match(h.tooltip(), /healthy/);
  assert.equal(h.timers.values().next().value!.delay, 2000);
});

test("wide native code hover escapes GPU output, limits output and trusts only monitor commands", async (t) => {
  const h = await monitorHarness(t);
  h.setProbe(async () => ({ ok: true, detail: "", output: 'Mon Oct 26 14:00:00 2026\n</code><a href="command:evil">link</a> & <script>x</script> ' + "x".repeat(65000) }));
  h.monitor.start(); await flush();
  assert.equal(h.bar.tooltip.supportHtml, true);
  assert.deepEqual(Array.from(h.bar.tooltip.isTrusted.enabledCommands), ["agentStatus.showGpuMonitor", "agentStatus.pauseGpuMonitor", "agentStatus.refreshGpuMonitor", "agentStatus.openSettings", "agentStatus.selectGpuServer", "agentStatus.reloadGpuServers"]);
  assert.doesNotMatch(h.tooltip(), /<a |<script>/);
  assert.match(h.tooltip(), /&lt;\/code&gt;&lt;a href=&quot;command:evil&quot;&gt;/);
  assert.match(h.tooltip(), /&amp; &lt;script&gt;/);
  assert.match(h.tooltip(), /仅显示前 64000/);
  assert.doesNotMatch(JSON.stringify(h.monitor.getDiagnostics()), /command:evil|x{100}/);
});

test("backticks and command-like process names stay inside the literal GPU table", async (t) => {
  const h = await monitorHarness(t);
  const output = 'GPU\n```\n[run](command:evil)\n```````\n<script>x</script>';
  h.setProbe(async () => ({ ok: true, detail: "", output }));
  h.monitor.start(); await flush();
  assert.ok(h.tooltip().includes('```text\nGPU\n```\n\n<pre><code>```\n[run](command:evil)\n```````\n&lt;script&gt;x&lt;/script&gt;</code></pre>'));
  assert.equal(h.bar.tooltip.supportHtml, true);
  assert.ok(!h.bar.tooltip.isTrusted.enabledCommands.includes("evil"));
});

test("server buttons contain opaque IDs only; selecting switches both CPU/GPU and keeps the two-second cadence", async t => {
  const h = await monitorHarness(t, true);
  h.monitor.start(); await flush();
  assert.match(h.tooltip(), /40901/); assert.match(h.tooltip(), /h20\\\*8/); assert.match(h.tooltip(), /当前机器/);
  assert.doesNotMatch(h.tooltip(), /private-server-password|test-host/);
  h.monitor.selectServer("server1"); await flush();
  assert.match(h.tooltip(), /GPU of 40901/); assert.match(h.tooltip(), /200.0%/);
  assert.equal(h.calls.length, 1); assert.equal(h.remoteCalls.length, 1);
  assert.equal(h.monitor.getDiagnostics().selectedServerId, "server1");
  assert.equal(h.timers.values().next().value!.delay, 2000);
  h.monitor.selectServer("unknown"); h.monitor.selectServer({ host: "injected" }); await flush();
  assert.equal(h.remoteCalls.length, 1);
  h.monitor.selectServer("local"); await flush();
  assert.equal(h.calls.length, 2); assert.match(h.tooltip(), /A800 42%/); assert.doesNotMatch(h.tooltip(), /GPU of 40901/);
  assert.doesNotMatch(JSON.stringify(h.monitor.getDiagnostics()), /private-server-password|test-host/);
});

test("rapid server switches cancel old sampling and never mix a stale frame into the newly selected machine", async t => {
  const h = await monitorHarness(t, true);
  h.monitor.start(); await flush();
  let finish!: (sample: import("../gpuSsh").RemoteGpuSample) => void;
  h.setRemoteProbe(() => new Promise(resolve => { finish = resolve; }));
  h.monitor.selectServer("server1"); const old = h.monitor.refresh();
  h.setRemoteProbe(async () => ({ gpu: { ok: true, output: "new server frame", detail: "" }, cpu: { state: "unavailable", logicalCores: 0 } }));
  h.monitor.selectServer("server2"); assert.equal(h.remoteCalls[0].signal!.aborted, true);
  assert.equal(h.remoteCalls.length, 1);
  finish({ gpu: { ok: true, output: "stale server frame", detail: "" }, cpu: { state: "ready", totalPercent: 999, machinePercent: 20, coresUsed: 9.99, logicalCores: 64 } });
  await old; await h.monitor.refresh();
  assert.equal(h.remoteCalls.length, 2); assert.equal(h.remoteCalls[1].server.id, "server2");
  assert.match(h.tooltip(), /new server frame/); assert.doesNotMatch(h.tooltip(), /stale server frame|999/);
});

test("removing the selected server falls back to the current machine; login failures retain all selection buttons", async t => {
  const h = await monitorHarness(t, true);
  h.monitor.start(); await flush();
  h.setRemoteProbe(async () => ({ gpu: { ok: false, output: "", detail: "SSH 登录失败" }, cpu: { state: "unavailable", logicalCores: 0 } }));
  h.monitor.selectServer("server1"); await flush();
  assert.equal(h.timers.size, 0); assert.match(h.tooltip(), /SSH 登录失败/); assert.match(h.tooltip(), /h20\\\*8/);
  h.servers.splice(0, 1); h.changed(); await flush();
  assert.equal(h.monitor.getDiagnostics().selectedServerId, "local"); assert.doesNotMatch(h.tooltip(), /SSH 登录失败/);
  h.monitor.show(); await flush(); assert.match(h.tooltip(), /A800 42%/);
  h.vscode.workspace.isTrusted = false; h.monitor.selectServer("server2"); await flush();
  assert.equal(h.remoteCalls.length, 1);
});

test("failed login checks mark server names and a successful retry clears the mark", async t => {
  const h = await monitorHarness(t, true);
  h.setCheck(async server => server.id !== "server1");
  h.monitor.start(); await h.monitor.reloadServers(); await flush();
  assert.ok(h.tooltip().includes("40901\\(不能连接\\)"));
  assert.ok(!h.tooltip().includes("h20\\*8\\(不能连接\\)"));
  assert.equal(h.monitor.getDiagnostics().unreachableServers, 1);
  h.monitor.selectServer("server1"); await flush();
  assert.ok(!h.tooltip().includes("40901\\(不能连接\\)"));
  assert.equal(h.monitor.getDiagnostics().unreachableServers, 0);
  h.setRemoteProbe(async () => ({ gpu: { ok: false, output: "", detail: "未找到 nvidia-smi" }, cpu: { state: "unavailable", logicalCores: 0 }, connected: true }));
  await h.monitor.refresh();
  assert.equal(h.monitor.getDiagnostics().unreachableServers, 0);
});

test("login checks are limited to two at a time; an older failure cannot override a newer successful selected frame", async t => {
  const h = await monitorHarness(t, true), finishes = new Map<string, (ok: boolean) => void>();
  h.servers.push({ ...h.servers[0], id: "server3", name: "40903" });
  h.setCheck(server => new Promise(resolve => finishes.set(server.id, resolve)));
  const pending = h.monitor.reloadServers(); await flush();
  assert.equal(h.probeCalls.length, 2);
  h.monitor.selectServer("server1"); await flush();
  finishes.get("server1")!(false); await flush();
  assert.equal(h.probeCalls.length, 3);
  finishes.get("server2")!(false); finishes.get("server3")!(true); await pending;
  assert.ok(!h.tooltip().includes("40901\\(不能连接\\)"));
  assert.ok(h.tooltip().includes("h20\\*8\\(不能连接\\)"));
  h.monitor.dispose();
  assert.equal(h.monitor.getDiagnostics().watching, false);
});

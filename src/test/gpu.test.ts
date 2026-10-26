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

async function monitorHarness(t: TestContext) {
  const config: Record<string, unknown> = {}, commands: string[] = [];
  const calls: Array<{ path: string; signal?: AbortSignal }> = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let id = 0, visible = false;
  let probe: (signal?: AbortSignal) => Promise<NvidiaSmiResult> = async () => ({ ok: true, detail: "每秒刷新", output: "+--- NVIDIA-SMI ---+\n| 0 A800 42% |" });
  const bar = { text: "", command: "", name: "", tooltip: undefined as { value: string; isTrusted?: { enabledCommands: string[] } } | undefined,
    show: () => { visible = true; }, hide: () => { visible = false; }, dispose: () => { visible = false; } };
  const vscode = {
    StatusBarAlignment: { Right: 2 }, env: { remoteName: "ssh-remote" },
    workspace: { isTrusted: true, getConfiguration: (section: string) => ({ get: (key: string, fallback: unknown) => config[section + "." + key] ?? fallback }) },
    commands: { executeCommand: async (name: string) => { commands.push(name); } },
    MarkdownString: class { isTrusted: unknown; constructor(public value: string) {} },
    window: { createStatusBarItem: () => bar,
      createTerminal: () => assert.fail("GPU monitoring must not open a terminal"),
      createWebviewPanel: () => assert.fail("GPU monitoring must use the native status-bar hover") },
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
  const monitor = new module.exports.GpuStatusMonitor();
  t.after(() => monitor.dispose());
  const tick = async () => {
    const [key, timer] = timers.entries().next().value!;
    timers.delete(key); timer.callback(); await new Promise((resolve) => setImmediate(resolve));
  };
  return { monitor, config, vscode, bar, commands, calls, timers, tick, visible: () => visible,
    setProbe: (next: typeof probe) => { probe = next; } };
}

test("GPU button starts on click, shows the native remote-host hover and refreshes at one-second intervals", async (t) => {
  const h = await monitorHarness(t);
  h.monitor.start();
  assert.equal(h.visible(), true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.bar.command, "agentStatus.showGpuMonitor");
  h.config["agentStatus.gpu.nvidiaSmiPath"] = "/opt/NVIDIA tools/nvidia-smi";
  await h.monitor.show(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.commands, ["workbench.action.showHover"]);
  assert.match(h.bar.tooltip!.value, /远程扩展宿主.*ssh/);
  assert.match(h.bar.tooltip!.value, /A800 42%/);
  assert.equal(h.calls[0].path, "/opt/NVIDIA tools/nvidia-smi");
  assert.equal(h.timers.values().next().value!.delay, 1000);
  h.setProbe(async () => ({ ok: true, output: "A800 84%", detail: "每秒刷新" }));
  await h.tick();
  assert.match(h.bar.tooltip!.value, /A800 84%/);
  assert.equal(h.calls.length, 2);
  h.monitor.pause();
  assert.equal(h.timers.size, 0);
  assert.match(h.bar.tooltip!.value, /已暂停/);
  assert.match(h.bar.tooltip!.value, /A800 84%/);
});

test("slow reads are deduplicated, rapid pause/resume waits for exit, and stale output never replaces the current sample", async (t) => {
  const h = await monitorHarness(t);
  let finish!: (value: NvidiaSmiResult) => void;
  h.setProbe(() => new Promise((resolve) => { finish = resolve; }));
  await h.monitor.show();
  const first = h.monitor.refresh();
  assert.equal(first, h.monitor.refresh());
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
  h.monitor.pause(); assert.equal(h.calls[0].signal!.aborted, true);
  h.setProbe(async () => ({ ok: true, output: "fresh sample", detail: "每秒刷新" }));
  await h.monitor.show();
  assert.equal(h.calls.length, 1);
  finish({ ok: true, output: "stale sample", detail: "" });
  await first; await h.monitor.refresh();
  assert.equal(h.calls.length, 2);
  assert.match(h.bar.tooltip!.value, /fresh sample/);
  assert.doesNotMatch(h.bar.tooltip!.value, /stale sample/);
});

test("errors pause the watch; manual refresh stays single-shot and untrusted/disabled/disposed monitors cannot execute", async (t) => {
  const h = await monitorHarness(t);
  h.setProbe(async () => ({ ok: false, output: "Failed to initialize NVML", detail: "驱动不可用" }));
  await h.monitor.show(); await h.monitor.refresh();
  assert.equal(h.timers.size, 0);
  assert.equal(h.monitor.getDiagnostics().watching, false);
  assert.match(h.bar.tooltip!.value, /NVML/);
  assert.doesNotMatch(JSON.stringify(h.monitor.getDiagnostics()), /NVML/);
  const before = h.calls.length;
  h.config["agentStatus.gpu.enabled"] = false; h.monitor.reloadConfiguration();
  await h.monitor.show(); await h.monitor.refresh();
  assert.equal(h.calls.length, before); assert.equal(h.visible(), false);
  h.config["agentStatus.gpu.enabled"] = true; h.vscode.workspace.isTrusted = false; h.monitor.reloadConfiguration();
  await h.monitor.show(); assert.equal(h.calls.length, before);
  h.vscode.workspace.isTrusted = true; h.monitor.reloadConfiguration();
  h.setProbe(async () => ({ ok: true, output: "single sample", detail: "" }));
  await h.monitor.refresh(); assert.equal(h.timers.size, 0);
  h.monitor.dispose(); await h.monitor.show();
  assert.equal(h.visible(), false);
});

test("GPU output stays literal HTML text and only the GPU action allowlist is trusted", async (t) => {
  const h = await monitorHarness(t);
  h.setProbe(async () => ({ ok: true, detail: "", output: "process </code></pre><a href=\"command:workbench.action.files.openFile\">bad</a> & ```\n[bad](command:workbench.action.files.openFile)" }));
  await h.monitor.refresh();
  assert.match(h.bar.tooltip!.value, /<pre><code>process &lt;\/code&gt;&lt;\/pre&gt;/);
  assert.match(h.bar.tooltip!.value, /&amp;/);
  assert.doesNotMatch(h.bar.tooltip!.value, /<a href=/);
  assert.equal(h.bar.tooltip!.isTrusted?.enabledCommands.includes("workbench.action.files.openFile"), false);
  assert.ok(h.bar.tooltip!.isTrusted?.enabledCommands.includes("agentStatus.pauseGpuMonitor"));
});

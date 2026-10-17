import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { discoverClashConfigCandidates, type ClashDiscoveryOptions } from "../clashDiscovery";
import { loadClashConnection, type ClashSettings } from "../clashConfig";

const settings: ClashSettings = {
  controller: "", secret: "", configPath: "", group: "", testTimeoutMs: 8000, updateIntervalSeconds: 300,
};

async function fixture(t: TestContext) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-center-discovery-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const procRoot = path.join(home, "proc");
  await fs.mkdir(procRoot);
  const options: ClashDiscoveryOptions = { platform: "linux", procRoot, env: {}, commandDirectories: [], shellFiles: [] };
  async function process(pid: string, comm: string, argv: string[]) {
    const root = path.join(procRoot, pid);
    await fs.mkdir(path.join(root, "cwd"), { recursive: true });
    await fs.writeFile(path.join(root, "comm"), comm + "\n");
    await fs.writeFile(path.join(root, "cmdline"), argv.join("\0") + "\0");
    return path.join(root, "cwd");
  }
  async function config(file: string, port = 9000) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `external-controller: 0.0.0.0:${port}\nsecret: test-secret\nproxy-groups:\n  - name: chosen\n`);
    return file;
  }
  return { home, options, process, config };
}

test("running Mihomo discovers custom paths with spaces before stale default installations", async (t) => {
  const h = await fixture(t);
  const live = await h.config(path.join(h.home, "arbitrary installation", "runtime", "config.yaml"));
  await h.config(path.join(h.home, "clash-for-linux", "runtime", "config.yaml"), 9090);
  await h.process("41", "mihomo", ["/custom/runtime/bin/mihomo", "-f", live, "-d", path.dirname(live)]);
  const result = await loadClashConnection(settings, h.home, h.options);
  assert.equal(result.configPath, live);
  assert.equal(result.controller, "http://127.0.0.1:9000");
  assert.equal(result.secret, "test-secret");
  assert.deepEqual(result.preferredGroups, ["chosen"]);
});

test("explicit config and installation settings retain priority over automatic discovery", async (t) => {
  const h = await fixture(t);
  const live = await h.config(path.join(h.home, "live", "config.yaml"));
  const explicit = await h.config(path.join(h.home, "specified", "runtime", "config.yaml"), 9001);
  await h.process("41", "mihomo", ["mihomo", "-f", live]);
  assert.equal((await loadClashConnection({ ...settings, configPath: explicit }, h.home, h.options)).configPath, explicit);
  assert.equal((await loadClashConnection({ ...settings, installDirectory: path.dirname(path.dirname(explicit)) }, h.home, h.options)).configPath, explicit);
  await assert.rejects(loadClashConnection({ ...settings, configPath: path.join(h.home, "missing.yaml") }, h.home, h.options));
});

test("relative -f paths use process cwd; repeated flags and equals syntax preserve the final value", async (t) => {
  const h = await fixture(t);
  const cwd = await h.process("42", "clash.meta", ["clash.meta", "-f", "unused.yaml", "--f=config with spaces.yaml"]);
  const expected = await h.config(path.join(cwd, "config with spaces.yaml"));
  assert.deepEqual(await discoverClashConfigCandidates(h.home, h.options), [expected]);
});

test("a core with only -d resolves its data directory relative to cwd", async (t) => {
  const h = await fixture(t);
  const cwd = await h.process("43", "clash-linux-amd", ["clash-linux-amd64", "-d=data directory"]);
  const expected = await h.config(path.join(cwd, "data directory", "config.yaml"));
  assert.deepEqual(await discoverClashConfigCandidates(h.home, h.options), [expected]);
});

test("unrelated processes, vanished cmdlines, stdin configs and non-PID entries are ignored", async (t) => {
  const h = await fixture(t);
  await h.process("44", "python3", ["python3", "mihomo", "-f", path.join(h.home, "unrelated.yaml")]);
  await h.process("45", "mihomo", ["mihomo", "-f", "-"]);
  await h.process("46", "clash-verge", ["clash-verge", "-f", path.join(h.home, "ui.yaml")]);
  await h.process("47", "mihomo", ["mihomo"]);
  await fs.unlink(path.join(h.options.procRoot!, "47", "cmdline"));
  await h.process("self", "mihomo", ["mihomo", "-f", path.join(h.home, "ignored.yaml")]);
  assert.deepEqual(await discoverClashConfigCandidates(h.home, h.options), []);
});

test("CLI wrappers and shell functions reveal installations without executing shell code", async (t) => {
  const h = await fixture(t);
  const root = path.join(h.home, "custom clash install");
  const file = await h.config(path.join(root, "runtime", "config.yaml"));
  const commandDirectory = path.join(h.home, "bin");
  await fs.mkdir(commandDirectory);
  const marker = path.join(h.home, "must-not-run");
  const script = `touch "${marker}"\nexec bash "${root.replace(/\\/g, "/")}/scripts/core/clashctl.sh" "$@"\n`;
  await fs.writeFile(path.join(commandDirectory, "clash"), script);
  const options = { ...h.options, commandDirectories: [commandDirectory] };
  assert.deepEqual(await discoverClashConfigCandidates(h.home, options), [file]);
  const profile = path.join(h.home, ".bashrc");
  await fs.writeFile(profile, script.replace("core/clashctl.sh", "cmd/clashctl.sh"));
  assert.deepEqual(await discoverClashConfigCandidates(h.home, { ...h.options, shellFiles: [profile] }), [file]);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

test("unflagged runtime binaries and supported environment hints provide config candidates", async (t) => {
  const h = await fixture(t);
  const root = path.join(h.home, "native");
  await h.process("48", "mihomo", [path.join(root, "runtime", "bin", "mihomo")]);
  const env = { CLASH_CONFIG_FILE: "~/manual.yaml", CLASH_INSTALL_DIR: root, XDG_CONFIG_HOME: path.join(h.home, "xdg") };
  assert.deepEqual(await discoverClashConfigCandidates(h.home, { ...h.options, env }), [
    path.join(root, "runtime", "config.yaml"), path.join(h.home, "manual.yaml"),
    path.join(h.home, "xdg", "mihomo", "config.yaml"), path.join(h.home, "xdg", "clash", "config.yaml"),
  ]);
});

test("refresh sees a restarted core's new config instead of persisting the old deployment path", async (t) => {
  const h = await fixture(t);
  const first = await h.config(path.join(h.home, "old", "config.yaml"));
  const second = await h.config(path.join(h.home, "moved", "config.yaml"), 9002);
  await h.process("49", "mihomo", ["mihomo", "-f", first]);
  assert.equal((await loadClashConnection(settings, h.home, h.options)).configPath, first);
  await fs.writeFile(path.join(h.options.procRoot!, "49", "cmdline"), ["mihomo", "-f", second, ""].join("\0"));
  const connection = await loadClashConnection(settings, h.home, h.options);
  assert.equal(connection.configPath, second);
  assert.equal(connection.controller, "http://127.0.0.1:9002");
});

test("missing procfs and oversized launchers fall back to common locations", async (t) => {
  const h = await fixture(t);
  const expected = await h.config(path.join(h.home, "clash-for-linux", "runtime", "config.yaml"));
  const shell = path.join(h.home, ".bashrc");
  await fs.writeFile(shell, "x".repeat(256 * 1024 + 1));
  const options = { ...h.options, procRoot: path.join(h.home, "missing-proc"), shellFiles: [shell] };
  assert.equal((await loadClashConnection(settings, h.home, options)).configPath, expected);
});

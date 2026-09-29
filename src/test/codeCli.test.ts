import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { resolveCodeCliLaunch, runCodeCli, CodeCliHost } from "../codeCli";

async function installation(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-center-cli-test-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("agent-center-cli-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, "bin", "remote-cli"), { recursive: true });
  await fs.mkdir(path.join(root, "out"));
  await fs.writeFile(path.join(root, "product.json"), JSON.stringify({ applicationName: "code-insiders", nameShort: "Code", commit: "test" }));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.93.0" }));
  for (const entry of ["bin/code-insiders", "bin/remote-cli/code-insiders", "out/cli.js", "out/server-cli.js"]) {
    await fs.writeFile(path.join(root, entry), "", { mode: 0o755 });
  }
  return root;
}

test("remote CLI uses this installation and window pipe without shell expansion", async t => {
  const root = await installation(t);
  const environment = { VSCODE_IPC_HOOK_CLI: "/tmp/this-window.sock", VSCODE_CLIENT_COMMAND: "/other/code", VSCODE_CLIENT_COMMAND_CWD: "/other", PATH: "/unrelated/bin" };
  const target = '/project/图 $(touch injected); & `command` "quoted".pdf';
  const launch = await resolveCodeCliLaunch({ appRoot: root, remote: true, platform: "linux", execPath: process.execPath }, target, environment);
  assert.equal(launch.executable, path.join(root, "bin", "remote-cli", "code-insiders"));
  assert.deepEqual(launch.args, ["-r", "--", target]);
  assert.equal(launch.env.VSCODE_IPC_HOOK_CLI, "/tmp/this-window.sock");
  assert.equal(launch.env.VSCODE_CLIENT_COMMAND, undefined);
  assert.equal(environment.VSCODE_CLIENT_COMMAND, "/other/code");
  await assert.rejects(resolveCodeCliLaunch({ appRoot: root, remote: true, platform: "linux", execPath: process.execPath }, target, {}), /no CLI connection/);
});

test("local Unix and Windows launch the bundled code CLI including versioned installations", async t => {
  const root = await installation(t);
  const host: CodeCliHost = { appRoot: root, remote: false, platform: "darwin", execPath: process.execPath };
  const unix = await resolveCodeCliLaunch(host, "/tmp/figure.svg", {});
  assert.equal(unix.executable, path.join(root, "bin", "code-insiders"));
  assert.deepEqual(unix.args, ["-r", "--", "/tmp/figure.svg"]);
  const target = "C:\\图 & %USERNAME% !name!\\image.png";
  const windows = await resolveCodeCliLaunch({ ...host, platform: "win32" }, target, { VSCODE_DEV: "1" });
  assert.equal(windows.executable, process.execPath);
  assert.deepEqual(windows.args, [path.join(root, "out", "cli.js"), "-r", "--", target]);
  assert.equal(windows.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(windows.env.VSCODE_DEV, undefined);
  const remote = await resolveCodeCliLaunch({ ...host, remote: true, platform: "win32" }, target, { VSCODE_IPC_HOOK_CLI: "window-pipe" });
  assert.equal(remote.args[0], path.join(root, "out", "server-cli.js"));
  assert.deepEqual(remote.args.slice(-3), ["-r", "--", target]);
});

test("CLI lookup fails clearly when the bundled launcher is unavailable", async t => {
  const root = await installation(t);
  await fs.writeFile(path.join(root, "product.json"), JSON.stringify({ applicationName: "missing-code" }));
  await assert.rejects(resolveCodeCliLaunch({ appRoot: root, remote: false, platform: "linux", execPath: process.execPath }, "/tmp/a.png", {}), /ENOENT/);
});

test("real child process receives special path characters literally and exits", async t => {
  const root = await installation(t);
  const capture = path.join(root, "arguments.json");
  const entry = path.join(root, "capture.cjs");
  await fs.writeFile(entry, "require('node:fs').writeFileSync(process.env.CLI_CAPTURE, JSON.stringify({args:process.argv.slice(2),pipe:process.env.VSCODE_IPC_HOOK_CLI}));");
  const target = '/project/图 $(echo injected) & %USERNAME% !x! `echo` "quoted".svg';
  await runCodeCli({ executable: process.execPath, args: [entry, "-r", "--", target], env: { ...process.env, CLI_CAPTURE: capture, VSCODE_IPC_HOOK_CLI: "current-window" } });
  assert.deepEqual(JSON.parse(await fs.readFile(capture, "utf8")), { args: ["-r", "--", target], pipe: "current-window" });
});

test("CLI reports process errors and remote open errors even with exit code zero", async t => {
  const root = await installation(t);
  const entry = path.join(root, "failure.cjs");
  await fs.writeFile(entry, "console.error('Error when invoking the open command: connection closed');");
  await assert.rejects(runCodeCli({ executable: process.execPath, args: [entry], env: process.env }), /code -r failed:.*connection closed/);
  await fs.writeFile(entry, "console.error('Failed to open');process.exitCode=1;");
  await assert.rejects(runCodeCli({ executable: process.execPath, args: [entry], env: process.env }), /code -r failed: Failed to open/);
});

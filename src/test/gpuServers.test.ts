import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Server, type Connection, type Session, type ExecInfo, type ServerChannel } from "ssh2";
import { parseGpuServers, gpuServerSignature, type GpuServer } from "../gpuServerConfig";
import { linuxCpuSnapshot, parseRemoteGpuSample, remoteGpuCommand, SavedGpuHostKeys, SshGpuReader, SshGpuProbe } from "../gpuSsh";

const password = "test-only.password.*";
test("server list accepts Chinese punctuation, literal password symbols, SSH option order and quoted keys", () => {
  const parsed = parseGpuServers([
    "# 可用服务器：", "40901：ssh root@172.22.253.204 -p 30935 密码： " + password,
    "- h20*8: ssh -p30911 root@172.22.253.204 密码: '" + password + "'",
    'key: ssh -i "/home/user/private keys/id_rsa" -l user server.example -p 22',
    "v6: ssh user@[::1] -p 2222 密码：p", "platform: ssh user@cluster@server.example -p 22 密码：p",
  ].join("\n"), "source");
  assert.deepEqual(parsed.invalidLines, []); assert.equal(parsed.servers.length, 5);
  assert.equal(parsed.servers[0].name, "40901"); assert.equal(parsed.servers[0].password, password);
  assert.equal(parsed.servers[1].name, "h20*8"); assert.equal(parsed.servers[1].port, 30911);
  assert.equal(parsed.servers[1].password, password);
  assert.equal(parsed.servers[2].privateKeyPath, "/home/user/private keys/id_rsa");
  assert.equal(parsed.servers[3].host, "::1"); assert.equal(parsed.servers[4].username, "user@cluster");
  const changed = { ...parsed.servers[0], password: "another" };
  assert.notEqual(gpuServerSignature(changed), gpuServerSignature(parsed.servers[0]));
  assert.ok(!parsed.servers[0].id.includes(password));
});

test("server parser rejects shell commands, extra SSH flags and invalid ports without returning source text in errors", () => {
  const parsed = parseGpuServers([
    "bad: ssh root@host -p 0 密码：private", "bad: ssh root@host -p 65536",
    "bad: ssh root@host;uname", "bad: ssh root@host -o ProxyCommand=evil",
    "bad: ssh root@host cat /etc/passwd", "bad: ssh root@host -i 'unterminated",
    "bad: ssh root@$(whoami)", "good: ssh root@host -p 22 密码：a$()#.*",
  ].join("\n"));
  assert.deepEqual(parsed.invalidLines, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(parsed.servers.length, 1); assert.equal(parsed.servers[0].password, "a$()#.*");
  assert.doesNotMatch(JSON.stringify(parsed.invalidLines), /private|Proxy/);
  assert.ok(!remoteGpuCommand(true).includes("a$()#.*"));
});

function stat(user: number, idle: number): string {
  return `cpu ${user} 0 0 ${idle} 0 0 0 0 999 999\ncpu0 0 0 0 0\ncpu1 0 0 0 0\n`;
}
function frame(output = "| 0 Test GPU 42% |", code = 0): string {
  return "shell startup output\n__AGENT_CENTER_CPU_BEFORE_9F820A__\n" + stat(100, 100) +
    "__AGENT_CENTER_GPU_9F820A__\n" + output + "\n__AGENT_CENTER_CPU_AFTER_9F820A__\n" + stat(150, 150) +
    "__AGENT_CENTER_STATUS_9F820A__:" + code + "\n";
}

test("remote CPU parser excludes guest counters, counts logical CPUs and parses framed GPU failures", () => {
  const snapshot = linuxCpuSnapshot(stat(100, 100))!;
  assert.deepEqual(snapshot, { cores: 2, total: 200, idle: 100 });
  const sample = parseRemoteGpuSample(frame());
  assert.equal(sample.gpu.ok, true); assert.equal(sample.gpu.output, "| 0 Test GPU 42% |");
  assert.equal(sample.cpu.totalPercent, 100); assert.equal(sample.cpu.machinePercent, 50);
  assert.equal(parseRemoteGpuSample(frame("not found", 127)).gpu.ok, false);
  assert.match(parseRemoteGpuSample(frame("not found", 127)).gpu.detail, /未找到/);
  assert.equal(parseRemoteGpuSample("broken output").gpu.ok, false);
  assert.equal(linuxCpuSnapshot("cpu x 0 0 0\ncpu0 0"), undefined);
  assert.equal(linuxCpuSnapshot("cpu 1 2 3 4"), undefined);
  const iowait = linuxCpuSnapshot("cpu 10 0 0 10 30 0 0 0\ncpu0 0 0 0 0")!;
  assert.equal(iowait.idle, 40); assert.equal(iowait.total, 50);
});

test("host keys are pinned on first use, checked on reuse and persist no credentials", async () => {
  let value: unknown;
  const store = new SavedGpuHostKeys({ get: <T>(_key: string, fallback: T) => (value as T) ?? fallback,
    update: async (_key: string, next: unknown) => { value = next; } });
  assert.deepEqual(await Promise.all([store.verify("endpoint1", "key1"), store.verify("endpoint2", "key2")]), [true, true]);
  assert.equal(await store.verify("endpoint1", "key1"), true);
  assert.equal(await store.verify("endpoint1", "changed-key"), false);
  assert.deepEqual(value, { endpoint1: "key1", endpoint2: "key2" });
});

const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
async function sshServer(response: (stream: ServerChannel, command: string) => void) {
  const connections = new Set<Connection>(), commands: string[] = [];
  let logins = 0;
  const server = new Server({ hostKeys: [hostKey] }, client => {
    connections.add(client); client.on("error", () => {}); client.on("close", () => connections.delete(client));
    client.on("authentication", context => {
      if (context.method === "password" && context.username === "root" && context.password === password) context.accept();
      else context.reject();
    });
    client.on("ready", () => {
      logins++;
      client.on("session", accept => {
        const session: Session = accept();
        session.on("exec", (accept: () => ServerChannel, _reject: unknown, info: ExecInfo) => {
          commands.push(info.command); response(accept(), info.command);
        });
      });
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const target: GpuServer = { id: "test", name: "test", host: "127.0.0.1", port: (server.address() as AddressInfo).port, username: "root", password };
  return { target, commands, logins: () => logins, close: async () => { for (const client of connections) client.end(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("real SSH transport logs in, reuses one connection and executes only the fixed read-only sampler", async t => {
  const server = await sshServer(stream => { stream.write(frame()); stream.exit(0); stream.end(); });
  const reader = new SshGpuReader(); t.after(async () => { reader.dispose(); await server.close(); });
  const first = await reader.read(server.target), second = await reader.read(server.target);
  assert.equal(first.gpu.ok, true); assert.equal(first.cpu.totalPercent, 100);
  assert.equal(second.gpu.ok, true); assert.equal(server.logins(), 1);
  assert.deepEqual(server.commands, [remoteGpuCommand(true), remoteGpuCommand(false)]);
  assert.ok(server.commands.every(command => !command.includes(password)));
});

test("SSH authentication and host-key failures have safe messages; abort closes pending sampling", async t => {
  const server = await sshServer(() => {});
  t.after(() => server.close());
  const reader = new SshGpuReader(); t.after(() => reader.dispose());
  const badPassword = await reader.read({ ...server.target, password: "not-the-password" });
  assert.equal(badPassword.gpu.ok, false); assert.match(badPassword.gpu.detail, /登录失败/);
  assert.doesNotMatch(JSON.stringify(badPassword), /not-the-password|test-only/);
  const badKey = new SshGpuReader({ verify: async () => false }); t.after(() => badKey.dispose());
  assert.match((await badKey.read(server.target)).gpu.detail, /主机密钥/);
  const abort = new AbortController(), pending = reader.read(server.target, abort.signal);
  while (!server.commands.length) await new Promise(resolve => setTimeout(resolve, 10));
  abort.abort(); const result = await pending;
  assert.equal(result.gpu.ok, false); assert.equal(result.gpu.detail, "已暂停");
});

test("SSH oversized output is terminated without retaining the data", async t => {
  const server = await sshServer(stream => stream.write(Buffer.alloc(1024 * 1024 + 1)));
  const reader = new SshGpuReader(); t.after(async () => { reader.dispose(); await server.close(); });
  const sample = await reader.read(server.target);
  assert.equal(sample.gpu.ok, false); assert.match(sample.gpu.detail, /1 MiB/); assert.equal(sample.gpu.output, "");
});

test("connectivity probes check login without executing any GPU commands", async t => {
  const server = await sshServer(() => assert.fail("Connectivity probes must not run commands"));
  const probe = new SshGpuProbe(); t.after(async () => { probe.dispose(); await server.close(); });
  assert.equal(await probe.check(server.target), true);
  assert.equal(await probe.check({ ...server.target, password: "invalid" }), false);
  assert.deepEqual(server.commands, []);
  const abort = new AbortController(); abort.abort(); assert.equal(await probe.check(server.target, abort.signal), false);
});

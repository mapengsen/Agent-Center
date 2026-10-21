import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as net from "node:net";
import { randomBytes } from "node:crypto";
import { JSON_SCHEMA, load } from "js-yaml";
import { ClashApiClient, type ClashProxies } from "./clashApi";
import type { ClashConnection } from "./clashConfig";

export async function withClashLock<T>(runtime: string, operation: () => Promise<T>): Promise<T> {
  const file = path.join(runtime, ".agent-center-subscriptions.lock");
  let handle;
  try { handle = await fs.open(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("另一个窗口正在管理 Clash，请稍后重试。");
    throw new Error("无法写入 Clash 目录，请检查当前远程用户权限。");
  }
  try { return await operation(); }
  finally { await handle.close(); await fs.unlink(file); }
}

export async function readClashDocument(file: string): Promise<Record<string, unknown>> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Clash 配置文件过大或无效。");
  try {
    const value = load(await fs.readFile(file, "utf8"), { schema: JSON_SCHEMA });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Error("无法解析 Clash 配置文件。"); }
}

/** A refused TCP connection is distinct from an authenticated HTTP error. */
export async function controllerListening(controller: string): Promise<boolean> {
  const url = new URL(controller);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) });
    socket.setTimeout(1500);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(new Error("无法确认 Clash 控制器的运行状态。"));
    });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("确认 Clash 控制器状态超时。")); });
  });
}

export async function waitClashStopped(connection: ClashConnection): Promise<void> {
  const deadline = Date.now() + 10000;
  do {
    if (!await controllerListening(connection.controller)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error("关闭命令已执行，但 Clash 控制器仍在运行。");
}

export async function loadAndVerifyClashConfig(connection: ClashConnection, file: string): Promise<void> {
  const config = await readClashDocument(file);
  const api = new ClashApiClient(connection);
  const deadline = Date.now() + 15000;
  while (true) {
    try { await api.getState(); break; }
    catch {
      if (Date.now() >= deadline) throw new Error("Clash 启动后控制器尚未就绪。");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  // Native commands can regenerate a file while an older core keeps running.
  await api.reloadConfig(file);
  const live = await api.getProxies();
  const expected = Array.isArray(config.proxies)
    ? config.proxies.filter((entry) => entry && typeof entry.name === "string").map((entry) => String(entry.name)) : [];
  if (expected.some((name) => !live[name])) throw new Error("Clash 未加载更新后的节点，已拒绝确认更新成功。");
  const groups = Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : [];
  if (groups.some((group) => group?.name && !live[group.name])) throw new Error("Clash 未加载更新后的策略组。");
  if (!config["proxy-providers"]) {
    const actual = Object.entries(live).filter(([, proxy]) => !proxy.all && !["Direct", "Reject", "RejectDrop", "Compatible", "Pass", "Dns", "DNS"].includes(proxy.type)).map(([name]) => name);
    if (actual.some((name) => !expected.includes(name))) throw new Error("Clash 仍保留旧配置中的节点。");
  }
}

export async function restoreClashSelections(connection: ClashConnection, previous: ClashProxies): Promise<void> {
  const api = new ClashApiClient(connection);
  const current = await api.getProxies();
  for (const [group, proxy] of Object.entries(previous)) {
    if (proxy.type === "Selector" && proxy.now && current[group]?.type === "Selector" && current[group].all?.includes(proxy.now) && current[group].now !== proxy.now) {
      await api.select(group, proxy.now);
      if ((await api.getProxies())[group]?.now !== proxy.now) throw new Error("Clash 未确认节点选择恢复结果。");
    }
  }
}

export async function snapshotClashFiles(files: string[]): Promise<Map<string, { data: Buffer; mode: number } | undefined>> {
  const snapshot = new Map<string, { data: Buffer; mode: number } | undefined>();
  for (const file of new Set(files)) {
    try { snapshot.set(file, { data: await fs.readFile(file), mode: (await fs.stat(file)).mode & 0o777 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") snapshot.set(file, undefined); else throw error; }
  }
  return snapshot;
}

export async function restoreClashFiles(snapshot: Awaited<ReturnType<typeof snapshotClashFiles>>): Promise<void> {
  for (const [file, entry] of snapshot) {
    if (!entry) { await fs.rm(file, { force: true }); continue; }
    const temporary = file + ".agent-center-restore-" + randomBytes(8).toString("hex");
    try { await fs.writeFile(temporary, entry.data, { mode: entry.mode, flag: "wx" }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
}

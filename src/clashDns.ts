import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { dump, load, JSON_SCHEMA } from "js-yaml";
import { readClashDocument, type snapshotClashFiles } from "./clashRuntime";

// These control the host's DNS service, rather than upstream resolution policy.
const HOST_DNS_KEYS = new Set(["enable", "listen", "ipv6"]);
const MARKER = ".agent-center-dns-policy.json";
interface DnsMarker { version: 1; backup: string; targetExisted: boolean; legacy: boolean }
type Snapshot = Awaited<ReturnType<typeof snapshotClashFiles>>;
export interface DnsChange {
  files: string[];
  backupDirectory: string;
  apply(snapshot: Snapshot): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function dnsPolicy(value: unknown): Record<string, unknown> {
  if (!record(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !HOST_DNS_KEYS.has(key)));
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => record(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

export function removeDnsOverrides(document: Record<string, unknown>, legacy: boolean): Record<string, unknown> {
  const result = structuredClone(document);
  if (!legacy && result.override !== undefined && !record(result.override)) throw new Error("DNS 本地 override 格式不兼容。");
  const parent = legacy ? result : result.override ? result.override = { ...result.override as Record<string, unknown> } : undefined;
  if (!parent || !Object.prototype.hasOwnProperty.call(parent, "dns")) return result;
  if (parent.dns !== null && !record(parent.dns)) throw new Error("DNS 本地覆写格式不兼容。");
  const keep = record(parent.dns) ? Object.fromEntries(Object.entries(parent.dns).filter(([key]) => HOST_DNS_KEYS.has(key))) : {};
  if (Object.keys(keep).length) parent.dns = keep;
  else delete parent.dns;
  return result;
}

async function exists(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function writePrivate(file: string, data: string | Buffer): Promise<void> {
  const temporary = file + ".agent-center-" + randomBytes(8).toString("hex");
  try { await fs.writeFile(temporary, data, { mode: 0o600, flag: "wx" }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

function parseMixin(bytes: Buffer): Record<string, unknown> {
  try {
    if (bytes.length > 32 * 1024 * 1024) throw new Error();
    const value = load(bytes.toString("utf8"), { schema: JSON_SCHEMA }) ?? {};
    if (!record(value)) throw new Error();
    return value;
  } catch { throw new Error("DNS 本地 Mixin 格式无效或文件过大。"); }
}

async function readMarker(runtime: string, legacy?: boolean): Promise<DnsMarker | undefined> {
  const file = path.join(runtime, MARKER);
  if (!await exists(file)) return undefined;
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as DnsMarker;
    if (value.version !== 1 || typeof value.legacy !== "boolean" || legacy !== undefined && value.legacy !== legacy || typeof value.targetExisted !== "boolean" ||
        !/^\d{17}-dns-[a-f0-9]{16}$/.test(value.backup)) throw new Error();
    const backup = path.join(runtime, ".agent-center-backups", value.backup);
    if ((await fs.lstat(backup)).isSymbolicLink() || !await exists(path.join(backup, "original-mixin.yaml"))) throw new Error();
    return value;
  } catch { throw new Error("DNS 策略记录或原始备份无效，请检查当前运行目录。"); }
}

export async function subscriptionDnsEnabled(runtime: string): Promise<boolean> {
  try { return Boolean(await readMarker(runtime)); }
  catch { return false; }
}

export async function prepareDnsChange(root: string, runtime: string, legacy: boolean, restore: boolean): Promise<DnsChange> {
  const target = path.join(runtime, "mixin.yaml");
  const targetExisted = await exists(target);
  // A per-host runtime gets its own copy; shared fallback files are never edited.
  const origin = targetExisted || legacy ? target : path.join(root, "config", "mixin.yaml");
  const originExisted = await exists(origin);
  const originalBytes = originExisted ? await fs.readFile(origin) : Buffer.from("{}\n");
  const original = parseMixin(originalBytes);
  const markerFile = path.join(runtime, MARKER);
  const previous = await readMarker(runtime, legacy);
  if (restore && !previous) throw new Error("DNS 尚未启用订阅优先策略，没有可恢复的原始覆写。");
  const backupName = previous?.backup ?? new Date().toISOString().replace(/\D/g, "").slice(0, 17) + "-dns-" + randomBytes(8).toString("hex");
  const backupDirectory = path.join(runtime, ".agent-center-backups", backupName);
  const beforeBytes = targetExisted ? originalBytes : undefined;
  let next = removeDnsOverrides(original, legacy);
  let deleteTarget = false;
  if (restore) {
    const saved = parseMixin(await fs.readFile(path.join(backupDirectory, "original-mixin.yaml")));
    const savedParent = legacy ? saved : record(saved.override) ? saved.override : {};
    // Restore only DNS policy fields, keeping later edits to rules, nodes,
    // controller settings and the host's current DNS listener/IPv6 state.
    if (legacy || record(next.override) || Object.keys(dnsPolicy(savedParent.dns)).length) {
      const parent = legacy ? next : (record(next.override) ? next.override : next.override = {});
      const hostFields = record(parent.dns) ? parent.dns : {};
      const restored = { ...dnsPolicy(savedParent.dns), ...hostFields };
      if (Object.keys(restored).length) parent.dns = restored;
      else delete parent.dns;
    }
    deleteTarget = !previous!.targetExisted && canonical(removeDnsOverrides(next, legacy)) === canonical(removeDnsOverrides(saved, legacy));
  }
  return {
    files: [target, markerFile], backupDirectory,
    apply: async (snapshot) => {
      const actual = await exists(target) ? await fs.readFile(target) : undefined;
      if (actual?.toString("base64") !== beforeBytes?.toString("base64")) throw new Error("DNS 覆写文件已被其他程序修改，请重试。");
      if (!targetExisted && (await exists(origin) !== originExisted || originExisted && !(await fs.readFile(origin)).equals(originalBytes))) throw new Error("DNS 共享覆写文件已被其他程序修改，请重试。");
      if (!previous) {
        const directory = path.dirname(backupDirectory);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.chmod(directory, 0o700);
        await fs.mkdir(backupDirectory, { mode: 0o700 });
        await writePrivate(path.join(backupDirectory, "original-mixin.yaml"), originalBytes);
        const manifest: Record<string, string | null> = {};
        let i = 0;
        for (const [file, entry] of snapshot) {
          const name = `file-${i++}.bak`;
          manifest[file] = entry ? name : null;
          if (entry) await writePrivate(path.join(backupDirectory, name), entry.data);
        }
        await writePrivate(path.join(backupDirectory, "files.json"), JSON.stringify(manifest, null, 2));
      }
      if (deleteTarget) await fs.rm(target, { force: true });
      else await writePrivate(target, dump(next, { lineWidth: -1 }));
      if (restore) await fs.rm(markerFile, { force: true });
      else await writePrivate(markerFile, JSON.stringify({ version: 1, backup: backupName, targetExisted: previous?.targetExisted ?? targetExisted, legacy } satisfies DnsMarker));
    },
  };
}

export function verifySubscriptionDns(source: Record<string, unknown>, generated: Record<string, unknown>): void {
  const policy = dnsPolicy(source.dns);
  const resolverKeys = ["nameserver", "nameserver-policy", "fallback", "proxy-server-nameserver", "direct-nameserver"];
  if (!resolverKeys.some((key) => {
    const value = policy[key];
    return (Array.isArray(value) && value.length > 0) || (record(value) && Object.keys(value).length > 0) || typeof value === "string" && Boolean(value);
  })) throw new Error("DNS 当前订阅未提供可用的解析策略，已拒绝清除本地覆写。");
  if (canonical(policy) !== canonical(dnsPolicy(generated.dns))) {
    throw new Error("DNS 最终运行配置仍与订阅不一致，未确认应用成功。");
  }
}

/** Restore can retain original local DNS policy; check that it survived build. */
export async function verifyRestoredDns(root: string, runtime: string, legacy: boolean, generated: Record<string, unknown>): Promise<void> {
  let target = path.join(runtime, "mixin.yaml");
  if (!legacy && !await exists(target)) target = path.join(root, "config", "mixin.yaml");
  if (!await exists(target)) return;
  const mixin = parseMixin(await fs.readFile(target));
  const parent = legacy ? mixin : record(mixin.override) ? mixin.override : {};
  const policy = dnsPolicy(parent.dns);
  const matches = (expected: unknown, actual: unknown): boolean => record(expected)
    ? record(actual) && Object.entries(expected).every(([key, value]) => matches(value, actual[key]))
    : canonical(expected) === canonical(actual);
  // Native YAML deep merge retains subscription keys not mentioned by Mixin.
  if (!matches(policy, generated.dns)) {
    throw new Error("DNS 原始覆写未在运行配置中生效。");
  }
}

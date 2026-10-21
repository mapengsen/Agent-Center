import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clashInstallationConfigs } from "./clashLayout";

export interface ClashDiscoveryOptions {
  platform?: NodeJS.Platform;
  procRoot?: string;
  env?: NodeJS.ProcessEnv;
  commandDirectories?: string[];
  shellFiles?: string[];
}

/** Read deployment hints without executing user shell startup files or Clash commands. */
export async function discoverClashConfigCandidates(home: string, options: ClashDiscoveryOptions = {}): Promise<string[]> {
  const env = options.env ?? process.env;
  const candidates: string[] = [];
  if ((options.platform ?? process.platform) === "linux") {
    candidates.push(...await runningConfigs(options.procRoot ?? "/proc"));
  }
  const expand = (value: string) => value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  if (env.CLASH_CONFIG_FILE) candidates.push(expand(env.CLASH_CONFIG_FILE));
  for (const key of ["CLASH_HOME_DIR", "MIHOMO_CONFIG_DIR"]) {
    if (env[key]) candidates.push(path.join(expand(env[key]!), "config.yaml"));
  }
  for (const key of ["CLASH_INSTALL_DIR", "CLASH_HOME"]) {
    if (env[key]) candidates.push(path.join(expand(env[key]!), "runtime", "config.yaml"));
  }
  if (env.XDG_CONFIG_HOME) {
    for (const name of ["mihomo", "clash"]) candidates.push(path.join(env.XDG_CONFIG_HOME, name, "config.yaml"));
  }
  if ((options.platform ?? process.platform) !== "win32") {
    const directories = options.commandDirectories ?? [
      ...(env.PATH ?? "").split(path.delimiter).filter((entry) => path.isAbsolute(entry)),
      path.join(home, ".local", "bin"), "/usr/local/bin", "/usr/bin",
    ];
    for (const directory of new Set(directories)) {
      for (const name of ["clash", "clashctl", "mihomo"]) {
        const command = path.join(directory, name);
        try {
          const resolved = await fs.realpath(command);
          candidates.push(...launcherConfigs(resolved.replace(/\\/g, "/")));
          candidates.push(...launcherConfigs(await readSmall(command, 64 * 1024)));
        } catch { /* Missing commands, binary launchers and inaccessible symlinks are optional. */ }
      }
    }
    // clash/clashtest are often shell functions, absent from the extension host's PATH.
    const shellFiles = options.shellFiles ?? [
      path.join(home, ".bashrc"), path.join(home, ".bash_profile"), path.join(home, ".profile"),
      path.join(home, ".zshrc"), "/etc/profile.d/clash.sh", "/etc/profile.d/clashctl.sh",
      path.join(home, ".config", "clash-for-linux", "profile.sh"),
    ];
    for (const file of shellFiles) {
      try { candidates.push(...launcherConfigs(await readSmall(file, 256 * 1024))); }
      catch { /* Never source these files: startup commands can have side effects. */ }
    }
  }
  return [...new Set(candidates.filter((candidate) => path.isAbsolute(candidate)).map((candidate) => path.normalize(candidate)))];
}

async function runningConfigs(procRoot: string): Promise<string[]> {
  let pids: string[];
  try { pids = (await fs.readdir(procRoot)).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b)).slice(0, 8192); }
  catch { return []; }
  const candidates: string[] = [];
  for (let offset = 0; offset < pids.length; offset += 32) {
    const batch = await Promise.all(pids.slice(offset, offset + 32).map(async (pid) => {
      const directory = path.join(procRoot, pid);
      try {
        const comm = (await readSmall(path.join(directory, "comm"), 1024)).trim();
        if (!/^(?:mihomo(?:[-_.].*)?|clash(?:[-_.](?:meta|core|linux|amd64|arm64|premium).*)?)$/i.test(comm)) return [];
        const argv = (await readSmall(path.join(directory, "cmdline"), 64 * 1024)).split("\0").filter(Boolean);
        if (!argv.length || flagValue(argv, "f") === "-") return [];
        let cwd = "";
        try { cwd = await fs.realpath(path.join(directory, "cwd")); } catch { /* Absolute flags still work. */ }
        const absolute = (value: string) => path.isAbsolute(value) ? value : cwd ? path.resolve(cwd, value) : "";
        const file = flagValue(argv, "f");
        if (file) { const resolved = absolute(file); return resolved ? [resolved] : []; }
        const dir = flagValue(argv, "d");
        if (dir) { const resolved = absolute(dir); return resolved ? [path.join(resolved, "config.yaml")] : []; }
        let executable = argv[0];
        try { executable = await fs.realpath(path.join(directory, "exe")); } catch { /* Fall back to argv[0]. */ }
        return launcherConfigs(executable.replace(/\\/g, "/"));
      } catch { return []; } // Processes can exit or deny /proc access during discovery.
    }));
    candidates.push(...batch.flat());
  }
  return candidates;
}

function flagValue(argv: string[], flag: string): string {
  let value = "";
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === "--") break;
    const match = argv[index].match(/^--?([^=]+)(?:=(.*))?$/);
    if (match?.[1] === flag) value = match[2] ?? argv[++index] ?? "";
  }
  return value;
}

function launcherConfigs(text: string): string[] {
  const candidates: string[] = [];
  // Only literal absolute paths are used; no shell interpolation, eval or command execution.
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    for (const match of line.matchAll(/((?:[A-Za-z]:)?\/[^\r\n"'`$;|&<>]*?)\/scripts\/(core|cmd)\/clashctl\.sh/g)) {
      candidates.push(path.join(match[1], match[2] === "cmd" ? "resources" : "runtime", match[2] === "cmd" ? "runtime.yaml" : "config.yaml"));
    }
    for (const match of line.matchAll(/((?:[A-Za-z]:)?\/[^\r\n"'`$;|&<>]*?)\/scripts\/core\/alias\.sh/g)) {
      candidates.push(...clashInstallationConfigs(match[1]));
    }
    const binary = line.match(/^((?:[A-Za-z]:)?\/[^\r\n"'`$;|&<>]+)\/runtime\/bin\/(?:mihomo|clash)(?:[-_.][^/]*)?$/i);
    if (binary) candidates.push(path.join(binary[1], "runtime", "config.yaml"));
  }
  return candidates;
}

async function readSmall(file: string, limit: number): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > limit) throw new Error("Invalid discovery input.");
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > limit) throw new Error("Discovery input too large.");
    return buffer.toString("utf8", 0, total);
  } finally { await handle.close(); }
}

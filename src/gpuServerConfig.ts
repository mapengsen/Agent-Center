import { createHash } from "node:crypto";
import { isIP } from "node:net";

export interface GpuServer {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
}
export interface ParsedGpuServers { servers: GpuServer[]; invalidLines: number[] }

/** Parse data only. Never execute the SSH command written in the document. */
export function parseGpuServers(text: string, source = ""): ParsedGpuServers {
  const servers: GpuServer[] = [], invalidLines: number[] = [];
  for (const [index, raw] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    if (!/\bssh\s/.test(raw)) continue;
    const match = raw.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(.{1,100}?)[：:]\s*`{0,3}ssh\s+(.+?)\s*$/);
    if (!match || servers.length >= 50) { invalidLines.push(index + 1); continue; }
    const name = match[1].trim().replace(/^\*\*(.+)\*\*$/, "$1");
    const tail = match[2], passwordAt = /\s+密码\s*[：:]\s*/.exec(tail);
    let command = passwordAt ? tail.slice(0, passwordAt.index) : tail;
    let password = passwordAt ? tail.slice(passwordAt.index + passwordAt[0].length).trim() : undefined;
    command = command.trim().replace(/`{1,3}$/, "").trim();
    if (password && /^(?:`[^`]*`|'[^']*'|"[^"]*")$/.test(password)) password = password.slice(1, -1);
    // Password punctuation (including trailing .* or **) is deliberately literal.
    const tokens = tokenize(command);
    let host = "", username = "", port = 22, privateKeyPath: string | undefined, invalid = !tokens || !name || /[\x00-\x1f\x7f]/.test(name);
    for (let i = 0; tokens && i < tokens.length && !invalid; i++) {
      const value = tokens[i];
      if (value === "-p" || /^-p\d+$/.test(value)) {
        const number = value === "-p" ? tokens[++i] : value.slice(2);
        port = /^\d+$/.test(number ?? "") ? Number(number) : 0;
        if (!Number.isInteger(port) || port < 1 || port > 65535) invalid = true;
      } else if (value === "-i" || value === "-l") {
        const argument = tokens[++i];
        if (!argument) invalid = true;
        else if (value === "-i") privateKeyPath = argument;
        else username = argument;
      } else if (value.startsWith("-") || host) invalid = true;
      else {
        const at = value.lastIndexOf("@");
        host = at >= 0 ? value.slice(at + 1) : value;
        if (at >= 0) username = value.slice(0, at);
        host = host.replace(/^\[([^\]]+)\]$/, "$1");
      }
    }
    if ((!isIP(host) && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(username) ||
        (password !== undefined && (!password || password.length > 4096 || /[\r\n\x00]/.test(password)))) invalid = true;
    if (invalid) { invalidLines.push(index + 1); continue; }
    const id = createHash("sha256").update(JSON.stringify([source, name, host, port, username])).digest("hex").slice(0, 24);
    if (!servers.some(server => server.id === id)) servers.push({ id, name, host, port, username, password, privateKeyPath });
  }
  return { servers, invalidLines };
}

function tokenize(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = "", quote = "", started = false;
  for (const char of command) {
    if (quote) { if (char === quote) quote = ""; else token += char; started = true; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { tokens.push(token); token = ""; started = false; } }
    else { token += char; started = true; }
  }
  if (quote) return undefined;
  if (started) tokens.push(token);
  return tokens;
}

/** Compare connection data in memory without exposing credentials in diagnostics. */
export function gpuServerSignature(server: GpuServer): string {
  return createHash("sha256").update(JSON.stringify(server)).digest("hex");
}

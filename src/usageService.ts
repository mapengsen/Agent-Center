import axios, { type AxiosProxyConfig } from "axios";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import {
  failure,
  parseClaudeAuthData,
  parseClaudeUsageResponse,
  parseCodexAuthData,
  parseCodexUsageResponse,
  resolveCredentialFilePath,
  success,
  type ClaudeUsageSnapshot,
  type CodexUsageSnapshot,
  type UsageResult,
} from "./core";

const REQUEST_TIMEOUT_MS = 15000;

export interface UsageServiceOptions {
  credentialsPath: string;
  proxyUrl: string;
}

export async function fetchCodexUsage(
  options: UsageServiceOptions,
): Promise<UsageResult<CodexUsageSnapshot>> {
  try {
    const credentialPath = resolveCredentialFilePath(
      options.credentialsPath,
      process.env.CODEX_HOME,
      ".codex",
      "auth.json",
      os.homedir(),
    );
    const authText = await readCredentialFile(credentialPath, "Codex");
    if (!authText.ok) return authText.result;
    const auth = parseCodexAuthData(authText.text);
    if (!auth) {
      return failure("auth", "credentials_unusable", "Codex auth.json is not usable in the current environment.", false);
    }

    const response = await axios.get("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${auth.accessToken}`,
        "User-Agent": "Agent-Status/0.1.0",
        ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
      },
      proxy: parseProxy(options.proxyUrl),
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });

    if (response.status === 401 || response.status === 403) {
      return failure("auth", "auth_rejected", "Codex credentials are invalid or expired.", false, response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      return httpFailure(response.status, "Codex usage request failed");
    }

    const now = new Date();
    const usage = parseCodexUsageResponse(response.data, now.getTime());
    if (!usage.primary && !usage.secondary) {
      return failure("response", "no_usage_windows", "Codex usage endpoint returned no recognized quota windows.", false);
    }
    return success({
      ...usage,
      email: auth.email,
      planType: auth.planType,
      updatedAt: now,
    });
  } catch (error) {
    return requestFailure(error);
  }
}

export async function fetchClaudeUsage(
  options: UsageServiceOptions,
): Promise<UsageResult<ClaudeUsageSnapshot>> {
  try {
    const credentialPath = resolveCredentialFilePath(
      options.credentialsPath,
      process.env.CLAUDE_CONFIG_DIR,
      ".claude",
      ".credentials.json",
      os.homedir(),
    );
    const authText = await readCredentialFile(credentialPath, "Claude");
    if (!authText.ok) return authText.result;
    const auth = parseClaudeAuthData(authText.text);
    if (!auth) {
      return failure("auth", "credentials_unusable", "Claude .credentials.json is not usable in the current environment.", false);
    }
    if (auth.expiresAt !== undefined && auth.expiresAt <= Date.now()) {
      return failure("auth", "auth_expired", "Claude OAuth credentials have expired.", false);
    }

    const response = await axios.get("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${auth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "Agent-Status/0.1.0",
      },
      proxy: parseProxy(options.proxyUrl),
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });

    if (response.status === 401 || response.status === 403) {
      return failure("auth", "auth_rejected", "Claude OAuth credentials are invalid or expired.", false, response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      return httpFailure(response.status, "Claude usage request failed");
    }

    const now = new Date();
    const usage = parseClaudeUsageResponse(response.data, now.getTime());
    if (!usage.fiveHour && !usage.sevenDay && !usage.sevenDayOpus && !usage.sevenDaySonnet) {
      return failure("response", "no_usage_windows", "Claude usage endpoint returned no recognized quota windows.", false);
    }
    return success({
      ...usage,
      subscriptionType: auth.subscriptionType,
      updatedAt: now,
    });
  } catch (error) {
    return requestFailure(error);
  }
}

async function readCredentialFile(
  credentialPath: string,
  providerName: "Codex" | "Claude",
): Promise<
  | { ok: true; text: string }
  | { ok: false; result: UsageResult<never> }
> {
  try {
    return { ok: true, text: await readFile(credentialPath, "utf8") };
  } catch (error) {
    const code = isNodeError(error) ? error.code : undefined;
    return {
      ok: false,
      result: failure(
        "auth",
        code === "ENOENT" ? "credentials_missing" : "credentials_unusable",
        code === "ENOENT"
          ? `${providerName} credentials were not found in the current environment.`
          : `${providerName} credentials could not be read in the current environment.`,
        false,
      ),
    };
  }
}

function requestFailure<TSnapshot>(error: unknown): UsageResult<TSnapshot> {
  if (axios.isAxiosError(error)) {
    const code = typeof error.code === "string" ? error.code : "network";
    if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
      return failure("request", "timeout", "Usage request timed out after 15 seconds in the current environment.", true);
    }
    return failure("request", "network", `Usage request failed in the current environment (${code}).`, true);
  }
  return failure("internal", "internal", "Agent Status encountered an internal error.", false);
}

function httpFailure<TSnapshot>(status: number, message: string): UsageResult<TSnapshot> {
  return failure(
    "request",
    "http_error",
    `${message} (HTTP ${status}).`,
    status === 429 || status >= 500,
    status,
  );
}

function parseProxy(proxyUrl: string): AxiosProxyConfig | false | undefined {
  if (!proxyUrl.trim()) return undefined;
  try {
    const url = new URL(proxyUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const proxy: AxiosProxyConfig = {
      protocol: url.protocol.slice(0, -1),
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    };
    if (url.username || url.password) {
      proxy.auth = {
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
    }
    return proxy;
  } catch {
    return false;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

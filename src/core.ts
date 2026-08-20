import * as path from "node:path";

export type UsageDisplayMode = "remaining" | "used";
export type UsageErrorCategory = "auth" | "request" | "response" | "internal";

export interface UsageError {
  category: UsageErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  httpStatus?: number;
}

export type UsageResult<TSnapshot> =
  | { ok: true; snapshot: TSnapshot }
  | { ok: false; error: UsageError };

export interface CodexUsageWindow {
  usedPercent: number;
  remainingPercent: number;
  windowMinutes?: number;
  resetsInSeconds?: number;
}

export interface CodexUsageSnapshot {
  primary?: CodexUsageWindow;
  secondary?: CodexUsageWindow;
  email: string;
  planType: string;
  updatedAt: Date;
}

export interface ClaudeUsageWindow {
  usedPercent: number;
  remainingPercent: number;
  resetsAt?: string;
  resetsInSeconds?: number;
}

export interface ClaudeUsageSnapshot {
  fiveHour?: ClaudeUsageWindow;
  sevenDay?: ClaudeUsageWindow;
  sevenDayOpus?: ClaudeUsageWindow;
  sevenDaySonnet?: ClaudeUsageWindow;
  subscriptionType?: string;
  updatedAt: Date;
}

export interface CodexAuthData {
  accessToken: string;
  accountId?: string;
  email: string;
  planType: string;
}

export interface ClaudeAuthData {
  accessToken: string;
  expiresAt?: number;
  subscriptionType?: string;
}

export interface QuotaStatusPresentation {
  percentageText: string;
  modeLabel: "left" | "used";
  resetDateTime?: string;
  statusText: string;
}

export const STARTUP_USAGE_REFRESH_COUNT = 3;
export const STARTUP_USAGE_REFRESH_INTERVAL_SECONDS = 60;
export const REGULAR_USAGE_REFRESH_RETRY_INTERVAL_SECONDS = 30;
export const MAX_REGULAR_USAGE_REFRESH_ATTEMPTS = 5;
export const DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS = 15 * 60;

export class UsageRefreshCadence {
  private remainingStartupRefreshes = STARTUP_USAGE_REFRESH_COUNT;
  private regularRefreshAttempts = 0;

  public get startupRefreshesRemaining(): number {
    return this.remainingStartupRefreshes;
  }

  public get regularRefreshAttemptsCount(): number {
    return this.regularRefreshAttempts;
  }

  public getDelaySeconds(regularIntervalSeconds: number): number {
    if (this.remainingStartupRefreshes > 0) return STARTUP_USAGE_REFRESH_INTERVAL_SECONDS;
    if (this.regularRefreshAttempts > 0 && this.regularRefreshAttempts < MAX_REGULAR_USAGE_REFRESH_ATTEMPTS) {
      return REGULAR_USAGE_REFRESH_RETRY_INTERVAL_SECONDS;
    }
    return Math.max(REGULAR_USAGE_REFRESH_RETRY_INTERVAL_SECONDS, regularIntervalSeconds);
  }

  public consumeScheduledRefresh(): boolean {
    if (this.remainingStartupRefreshes <= 0) return false;
    this.remainingStartupRefreshes -= 1;
    return true;
  }

  public recordRegularRefreshResult(successful: boolean): void {
    if (successful) {
      this.regularRefreshAttempts = 0;
      return;
    }
    this.regularRefreshAttempts = Math.min(
      MAX_REGULAR_USAGE_REFRESH_ATTEMPTS,
      this.regularRefreshAttempts + 1,
    );
  }
}

export function formatQuotaStatus(
  percentage: number,
  displayMode: UsageDisplayMode,
  secondsUntilReset: number | undefined,
  referenceTime = new Date(),
): QuotaStatusPresentation | undefined {
  if (!Number.isFinite(percentage)) return undefined;
  const percentageText = `${percentage.toFixed(0)}%`;
  const modeLabel = displayMode === "remaining" ? "left" : "used";
  const resetDateTime = formatResetDateTime(secondsUntilReset, referenceTime);
  return {
    percentageText,
    modeLabel,
    resetDateTime,
    statusText: `${percentageText} ${modeLabel} | ${resetDateTime ?? "--"}`,
  };
}

export function formatResetDateTime(
  secondsUntilReset: number | undefined,
  referenceTime = new Date(),
): string | undefined {
  if (secondsUntilReset === undefined ||
      !Number.isFinite(secondsUntilReset) ||
      !Number.isFinite(referenceTime.getTime())) return undefined;
  const resetTime = new Date(referenceTime.getTime() + Math.max(0, secondsUntilReset) * 1000);
  const hours = String(resetTime.getHours()).padStart(2, "0");
  const minutes = String(resetTime.getMinutes()).padStart(2, "0");
  return `${resetTime.getMonth() + 1}-${resetTime.getDate()} ${hours}:${minutes}`;
}

export function formatResetDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds < 60) return `${safeSeconds}s`;
  if (safeSeconds < 3600) return `${Math.floor(safeSeconds / 60)}m`;
  if (safeSeconds < 86400) {
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(safeSeconds / 86400);
  const hours = Math.floor((safeSeconds % 86400) / 3600);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

export function success<TSnapshot>(snapshot: TSnapshot): UsageResult<TSnapshot> {
  return { ok: true, snapshot };
}

export function failure<TSnapshot = never>(
  category: UsageErrorCategory,
  code: string,
  message: string,
  retryable: boolean,
  httpStatus?: number,
): UsageResult<TSnapshot> {
  return { ok: false, error: { category, code, message, retryable, httpStatus } };
}

export function resolveCredentialFilePath(
  configuredPath: string,
  configuredDirectory: string | undefined,
  defaultDirectoryName: string,
  fileName: string,
  homeDirectory: string,
): string {
  if (configuredPath.trim()) return resolveHomeRelativePath(configuredPath.trim(), homeDirectory);
  const directory = configuredDirectory?.trim()
    ? resolveHomeRelativePath(configuredDirectory.trim(), homeDirectory)
    : path.join(homeDirectory, defaultDirectoryName);
  return path.join(directory, fileName);
}

export function parseCodexAuthData(text: string): CodexAuthData | undefined {
  try {
    const root = asRecord(JSON.parse(text));
    const tokens = asRecord(root.tokens);
    const accessToken = stringValue(tokens.access_token);
    if (!accessToken) return undefined;
    const payload = parseJwt(stringValue(tokens.id_token) ?? "");
    const claims = asRecord(payload["https://api.openai.com/auth"]);
    return {
      accessToken,
      accountId: stringValue(tokens.account_id),
      email: stringValue(payload.email) ?? "Unknown",
      planType: stringValue(claims.chatgpt_plan_type) ?? "Unknown",
    };
  } catch {
    return undefined;
  }
}

export function parseClaudeAuthData(text: string): ClaudeAuthData | undefined {
  try {
    const root = asRecord(JSON.parse(text));
    const oauth = asRecord(root.claudeAiOauth);
    const accessToken = stringValue(oauth.accessToken);
    if (!accessToken) return undefined;
    const expiresAt = finiteNumber(oauth.expiresAt);
    return {
      accessToken,
      expiresAt: expiresAt === undefined
        ? undefined
        : expiresAt < 100000000000 ? expiresAt * 1000 : expiresAt,
      subscriptionType: stringValue(oauth.subscriptionType),
    };
  } catch {
    return undefined;
  }
}

export function parseCodexUsageResponse(
  data: unknown,
  nowMs = Date.now(),
): Pick<CodexUsageSnapshot, "primary" | "secondary"> {
  const rateLimit = asRecord(asRecord(data).rate_limit);
  return {
    primary: parseCodexWindow(rateLimit.primary_window, nowMs),
    secondary: parseCodexWindow(rateLimit.secondary_window, nowMs),
  };
}

export function parseClaudeUsageResponse(
  data: unknown,
  nowMs = Date.now(),
): Pick<ClaudeUsageSnapshot, "fiveHour" | "sevenDay" | "sevenDayOpus" | "sevenDaySonnet"> {
  const root = asRecord(data);
  return {
    fiveHour: parseClaudeWindow(root.five_hour, nowMs),
    sevenDay: parseClaudeWindow(root.seven_day, nowMs),
    sevenDayOpus: parseClaudeWindow(root.seven_day_opus, nowMs),
    sevenDaySonnet: parseClaudeWindow(root.seven_day_sonnet, nowMs),
  };
}

function parseCodexWindow(raw: unknown, nowMs: number): CodexUsageWindow | undefined {
  const value = asRecord(raw);
  const used = finiteNumber(value.used_percent);
  if (used === undefined) return undefined;
  const windowSeconds = finiteNumber(value.limit_window_seconds);
  const resetAfter = finiteNumber(value.reset_after_seconds);
  const resetAt = finiteNumber(value.reset_at);
  const resetsInSeconds = resetAfter ?? (resetAt === undefined
    ? undefined
    : Math.max(0, Math.round(resetAt - nowMs / 1000)));
  const usedPercent = clampPercent(used);
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowMinutes: windowSeconds === undefined ? undefined : windowSeconds / 60,
    resetsInSeconds,
  };
}

function parseClaudeWindow(raw: unknown, nowMs: number): ClaudeUsageWindow | undefined {
  const value = asRecord(raw);
  const utilization = finiteNumber(value.utilization ?? value.used_percent ?? value.used_percentage);
  if (utilization === undefined) return undefined;
  const usedPercent = clampPercent(utilization >= 0 && utilization <= 1 ? utilization * 100 : utilization);
  const resetMs = parseResetTimestamp(value.resets_at);
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt: resetMs === undefined ? undefined : new Date(resetMs).toISOString(),
    resetsInSeconds: resetMs === undefined ? undefined : Math.max(0, Math.round((resetMs - nowMs) / 1000)),
  };
}

function resolveHomeRelativePath(value: string, homeDirectory: string): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(homeDirectory, value);
}

function parseJwt(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1];
    return payload
      ? asRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
      : {};
  } catch {
    return {};
  }
}

function parseResetTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 100000000000 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

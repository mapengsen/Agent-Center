import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS,
  formatQuotaStatus,
  formatResetDateTime,
  parseClaudeAuthData,
  parseClaudeUsageResponse,
  parseCodexAuthData,
  parseCodexUsageResponse,
  resolveCredentialFilePath,
  MAX_REGULAR_USAGE_REFRESH_ATTEMPTS,
  REGULAR_USAGE_REFRESH_RETRY_INTERVAL_SECONDS,
  STARTUP_USAGE_REFRESH_COUNT,
  STARTUP_USAGE_REFRESH_INTERVAL_SECONDS,
  UsageRefreshCadence,
} from "../core";
import { getUsageHealthEmoji } from "../tooltipPresentation";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("formats the compact percentage and reset timestamp", () => {
  const referenceTime = new Date(2026, 7, 20, 10, 24, 0);
  assert.equal(formatResetDateTime(60 * 60, referenceTime), "8-20 11:24");
  assert.deepEqual(formatQuotaStatus(5.4, "remaining", 60 * 60, referenceTime), {
    percentageText: "5%",
    modeLabel: "left",
    resetDateTime: "8-20 11:24",
    statusText: "5% left | 8-20 11:24",
  });
  assert.equal(formatQuotaStatus(25, "used", undefined, referenceTime)?.statusText, "25% used | --");
});

test("uses distinct health colors for usage thresholds", () => {
  assert.equal(getUsageHealthEmoji(0), "💚");
  assert.equal(getUsageHealthEmoji(60), "💛");
  assert.equal(getUsageHealthEmoji(80), "🧡");
  assert.equal(getUsageHealthEmoji(95), "❤️");
  assert.equal(getUsageHealthEmoji(200), "❤️");
});

test("uses startup cadence and retries failed regular refreshes", () => {
  const cadence = new UsageRefreshCadence();
  assert.equal(STARTUP_USAGE_REFRESH_COUNT, 3);
  assert.equal(STARTUP_USAGE_REFRESH_INTERVAL_SECONDS, 60);
  assert.equal(REGULAR_USAGE_REFRESH_RETRY_INTERVAL_SECONDS, 30);
  assert.equal(MAX_REGULAR_USAGE_REFRESH_ATTEMPTS, 5);
  assert.equal(DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS, 900);
  for (let remaining = 3; remaining > 0; remaining -= 1) {
    assert.equal(cadence.startupRefreshesRemaining, remaining);
    assert.equal(cadence.getDelaySeconds(900), 60);
    assert.equal(cadence.consumeScheduledRefresh(), true);
  }
  assert.equal(cadence.consumeScheduledRefresh(), false);
  assert.equal(cadence.getDelaySeconds(900), 900);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    cadence.recordRegularRefreshResult(false);
    assert.equal(cadence.regularRefreshAttemptsCount, attempt);
    assert.equal(
      cadence.getDelaySeconds(900),
      attempt < 5 ? REGULAR_USAGE_REFRESH_RETRY_INTERVAL_SECONDS : 900,
    );
  }
  cadence.recordRegularRefreshResult(true);
  assert.equal(cadence.regularRefreshAttemptsCount, 0);
  assert.equal(cadence.getDelaySeconds(900), 900);
});

test("resolves credentials inside the extension host environment", () => {
  assert.equal(
    resolveCredentialFilePath("", "/srv/codex", ".codex", "auth.json", "/home/alice"),
    "/srv/codex/auth.json",
  );
  assert.equal(
    resolveCredentialFilePath("~/.secrets/codex.json", undefined, ".codex", "auth.json", "/home/alice"),
    "/home/alice/.secrets/codex.json",
  );
  assert.equal(
    resolveCredentialFilePath("", undefined, ".claude", ".credentials.json", "/home/alice"),
    "/home/alice/.claude/.credentials.json",
  );
});

test("parses Codex auth and usage without putting tokens in snapshots", () => {
  const auth = parseCodexAuthData(JSON.stringify({
    tokens: {
      access_token: "secret-token",
      account_id: "account-1",
      id_token: jwt({
        email: "alice@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
      }),
    },
  }));
  assert.equal(auth?.email, "alice@example.com");
  assert.equal(auth?.planType, "plus");

  const usage = parseCodexUsageResponse({
    rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 60 },
    },
  }, 0);
  assert.deepEqual(usage.primary, {
    usedPercent: 25,
    remainingPercent: 75,
    windowMinutes: 300,
    resetsInSeconds: 60,
  });
  assert.equal(JSON.stringify(usage).includes("secret-token"), false);
});

test("normalizes Claude expiry and usage windows", () => {
  const auth = parseClaudeAuthData(JSON.stringify({
    claudeAiOauth: {
      accessToken: "claude-secret",
      expiresAt: 2000000000,
      subscriptionType: "max",
    },
  }));
  assert.equal(auth?.expiresAt, 2000000000000);
  assert.equal(auth?.subscriptionType, "max");

  const resetAt = "2026-08-20T00:00:00.000Z";
  const usage = parseClaudeUsageResponse({
    five_hour: { utilization: 0.4, resets_at: resetAt },
  }, Date.parse("2026-08-19T23:00:00.000Z"));
  assert.deepEqual(usage.fiveHour, {
    usedPercent: 40,
    remainingPercent: 60,
    resetsAt: resetAt,
    resetsInSeconds: 3600,
  });
});

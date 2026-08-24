export const TOOLTIP_EMOJI = {
  codex: "🌸",
  claude: "🧠",
  loading: "🌱",
  refreshing: "🔃",
  auth: "🪪",
  error: "🚧",
  statusMeaning: "🧭",
  colorLegend: "🎨",
  account: "🪪",
  plan: "🎫",
  note: "💬",
  shortWindow: "⌛",
  longWindow: "🗓️",
  opusWindow: "🎼",
  sonnetWindow: "✒️",
  reset: "⏰",
  updated: "📡",
  refresh: "🔃",
  displayMode: "🎚️",
  settings: "🧰",
} as const;

export const USAGE_HEALTH_LEGEND = "💚 0–59% · 💛 60–79% · 🧡 80–94% · ❤️ 95–100%";

export function getUsageHealthEmoji(usedPercent: number): string {
  const clamped = Math.max(0, Math.min(100, usedPercent));
  if (clamped >= 95) return "❤️";
  if (clamped >= 80) return "🧡";
  if (clamped >= 60) return "💛";
  return "💚";
}

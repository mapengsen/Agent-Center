import type { ClashState, DelayResult } from "./clashApi";
import { resolveProxyChain } from "./clashApi";

export interface ClashSnapshot {
  state: ClashState;
  group: string;
  chain: string[];
  delay: DelayResult;
  updatedAt: Date;
  subscription?: string;
}

export function formatClashDelay(result: DelayResult): string {
  return result.ok ? "√ Google（" + result.ms + " ms）" : "× 超时";
}

export function clashTooltip(snapshot: ClashSnapshot): string {
  const { state, group, chain, delay } = snapshot;
  const lines = [
    "**Clash / Mihomo**",
    "**当前节点**：" + escapeMarkdown(chain.at(-1) ?? group),
    "**选择链**：" + chain.map(escapeMarkdown).join(" → "),
    "**Google 连通性**：" + formatClashDelay(delay),
    "**路由模式**：" + escapeMarkdown(state.mode) + " · **策略组**：" + escapeMarkdown(group),
    "延迟为访问 Google 的耗时，单位 ms。",
  ];
  if (!delay.ok) lines.push("失败原因：" + escapeMarkdown(delay.error));
  if (snapshot.subscription) lines.push("**当前订阅**：" + escapeMarkdown(snapshot.subscription));
  if (state.mode === "rule") lines.push("显示所选策略组的节点；其他规则可能使用其他策略组。");
  const proxy = state.proxies[group];
  if (proxy?.type === "Selector" && proxy.all?.length) {
    lines.push("**点击切换节点**");
    for (const node of proxy.all.slice(0, 12)) {
      const target = resolveProxyChain(state.proxies, node).at(-1);
      lines.push((node === proxy.now ? "✓ " : "• ") +
        commandLink(node, "agentStatus.chooseClashNode", [{ group, node }]) +
        (target && target !== node ? " → " + escapeMarkdown(target) : ""));
    }
    if (proxy.all.length > 12) lines.push("其余节点请点击下方“全部节点”。");
  } else if (state.mode === "direct") {
    lines.push("当前为直连模式；切换为规则或全局模式后可选择代理节点。");
  }
  lines.push(commandLink("全部节点", "agentStatus.chooseClashNode") + " · " +
    commandLink("刷新测速", "agentStatus.refreshClash") + " · " +
    commandLink("设置", "agentStatus.openSettings"));
  lines.push(commandLink("切换订阅", "agentStatus.chooseClashSubscription") + " · " +
    commandLink("添加订阅", "agentStatus.addClashSubscription") + " · " +
    commandLink("删除订阅", "agentStatus.removeClashSubscription"));
  lines.push("更新于 " + snapshot.updatedAt.toISOString());
  return lines.join("\n\n");
}

export function commandLink(label: string, command: string, args?: unknown[]): string {
  return "[" + escapeMarkdown(label) + "](command:" + command +
    (args ? "?" + encodeURIComponent(JSON.stringify(args)) : "") + ")";
}

export function escapeMarkdown(value: string): string {
  return value.replace(/[\\\x60*_{}[\]()#+.!|<>-]/g, "\\$&").replace(/\r?\n/g, " ");
}

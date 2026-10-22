import type { ClashState, DelayResult } from "./clashApi";
import { resolveProxyChain } from "./clashApi";
import { sortedNodeDelays, type ClashNodeTests } from "./clashNodeTests";

export interface ClashSnapshot {
  state: ClashState;
  group: string;
  chain: string[];
  delay: DelayResult;
  updatedAt: Date;
  subscription?: string;
  subscriptionDns?: boolean;
  dnsWebVerification?: string;
  nodeTests?: ClashNodeTests;
}

export function clashControlLinks(): string {
  return commandLink("开启代理", "agentStatus.startClash") + " · " +
    commandLink("关闭代理", "agentStatus.stopClash") + " · " +
    commandLink("更新当前订阅", "agentStatus.updateClashSubscription") + "\n\n" +
    commandLink("DNS 使用订阅配置", "agentStatus.useSubscriptionDns") + " · " +
    commandLink("恢复原 DNS 覆写", "agentStatus.restoreClashDns");
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
  if (snapshot.subscriptionDns) lines.push("**DNS 策略**：使用订阅配置（保留本机监听、启用和 IPv6 设置）。");
  if (snapshot.dnsWebVerification) lines.push("**最近网页验证**：" + escapeMarkdown(snapshot.dnsWebVerification));
  lines.push(clashControlLinks());
  if (state.mode === "rule") lines.push("显示所选策略组的节点；其他规则可能使用其他策略组。");
  const proxy = state.proxies[group];
  if (proxy?.type === "Selector" && proxy.all?.length) {
    lines.push("**点击切换节点**");
    for (const node of proxy.all.slice(0, 12)) {
      const target = resolveProxyChain(state.proxies, node).at(-1);
      lines.push((node === proxy.now ? "✓ " : "• ") +
        commandLink(node, "agentStatus.chooseClashNode", [{ group, node }]) +
        (target && target !== node ? " → " + escapeMarkdown(target) : "") +
        nodeDelayText(snapshot.nodeTests, node));
    }
    if (proxy.all.length > 12) lines.push("其余节点请点击下方“全部节点”。");
  } else if (state.mode === "direct") {
    lines.push("当前为直连模式；切换为规则或全局模式后可选择代理节点。");
  }
  lines.push(commandLink("全部节点", "agentStatus.chooseClashNode") + " · " +
    commandLink("全部节点测速", "agentStatus.testAllClashNodes") + " · " +
    commandLink("测速并切换最佳节点", "agentStatus.testAndSelectBestClashNode") + " · " +
    commandLink("刷新测速", "agentStatus.refreshClash") + " · " +
    commandLink("设置", "agentStatus.openSettings"));
  lines.push(commandLink("切换订阅", "agentStatus.chooseClashSubscription") + " · " +
    commandLink("添加订阅", "agentStatus.addClashSubscription") + " · " +
    commandLink("删除订阅", "agentStatus.removeClashSubscription"));
  if (snapshot.nodeTests) {
    const tests = snapshot.nodeTests;
    lines.push("**全部节点测速**：" + tests.results.length + "/" + tests.total +
      (tests.running ? "（测速中，最多 5 个并行） · " + commandLink("取消测速", "agentStatus.cancelClashNodeTests")
        : tests.cancelled ? "（已取消，保留已完成结果）" : "（完成，按延迟排序）"));
    lines.push("本轮测速：" + (tests.finishedAt ?? tests.startedAt).toISOString());
    if (tests.bestSelection) lines.push("**最佳节点切换**：" + escapeMarkdown(tests.bestSelection));
    const rows = sortedNodeDelays(tests.results).map(({ node, delay }) => {
      const label = proxy?.type === "Selector" && proxy.all?.includes(node)
        ? commandLink(node, "agentStatus.chooseClashNode", [{ group, node }]) : escapeMarkdown(node);
      return "| " + label + " | " + formatClashDelay(delay) + " |";
    });
    if (rows.length) lines.push(["| 节点 | Google 延迟 |", "| --- | --- |", ...rows].join("\n"));
  }
  lines.push("当前节点更新于 " + snapshot.updatedAt.toISOString());
  return lines.join("\n\n");
}

export function nodeDelayText(tests: ClashNodeTests | undefined, node: string): string {
  const result = tests?.results.find((item) => item.node === node);
  return result ? " · " + formatClashDelay(result.delay) : "";
}

export function commandLink(label: string, command: string, args?: unknown[]): string {
  return "[" + escapeMarkdown(label) + "](command:" + command +
    (args ? "?" + encodeURIComponent(JSON.stringify(args)) : "") + ")";
}

export function escapeMarkdown(value: string): string {
  return value.replace(/[\\\x60*_{}[\]()#+.!|<>-]/g, "\\$&").replace(/\r?\n/g, " ");
}

import type { ClashApiClient, ClashProxies, DelayResult } from "./clashApi";

export const CLASH_NODE_TEST_CONCURRENCY = 5;
export interface ClashNodeDelay { node: string; delay: DelayResult }
export interface ClashNodeTests {
  total: number;
  results: ClashNodeDelay[];
  startedAt: Date;
  finishedAt?: Date;
  running: boolean;
  cancelled: boolean;
  bestSelection?: string;
}

const SKIP_TYPES = new Set(["direct", "reject", "rejectdrop", "compatible", "pass", "dns",
  "selector", "select", "urltest", "fallback", "loadbalance", "relay"]);

/** Test each concrete node once, including nodes loaded from proxy providers. */
export function clashNodeNames(proxies: ClashProxies): string[] {
  return Object.entries(proxies).filter(([, proxy]) => !proxy.all &&
    !SKIP_TYPES.has(proxy.type.toLowerCase().replace(/[-_\s]/g, ""))).map(([name]) => name);
}

export function clashNodeTestContext(controller: string, config: string, subscription: string | undefined, proxies: ClashProxies): string {
  return JSON.stringify([controller, config, subscription,
    clashNodeNames(proxies).map((name) => [name, proxies[name].type]).sort(([a], [b]) => a.localeCompare(b))]);
}

export async function testClashNodes(api: Pick<ClashApiClient, "testDelay">, names: string[], url: string, timeoutMs: number,
  signal: AbortSignal, onResult: (result: ClashNodeDelay) => void): Promise<void> {
  const nodes = [...new Set(names)];
  let index = 0;
  const worker = async () => {
    while (!signal.aborted && index < nodes.length) {
      const node = nodes[index++];
      const delay = await api.testDelay(node, url, timeoutMs, signal);
      if (signal.aborted) return;
      onResult({ node, delay });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CLASH_NODE_TEST_CONCURRENCY, nodes.length) }, worker));
}

export function sortedNodeDelays(results: ClashNodeDelay[]): ClashNodeDelay[] {
  return [...results].sort((a, b) => {
    if (a.delay.ok && b.delay.ok) return a.delay.ms - b.delay.ms || a.node.localeCompare(b.node);
    return Number(b.delay.ok) - Number(a.delay.ok) || a.node.localeCompare(b.node);
  });
}

import { resolveProxyChain, type ClashApiClient, type ClashState } from "./clashApi";
import { clashNodeNames, type ClashNodeDelay } from "./clashNodeTests";

interface Selection { group: string; node: string; previous: string }
export interface BestClashNode { group: string; node: string; ms: number; selections: Selection[] }

/** Only traverse manual selectors: pinning an automatic group changes its policy. */
export function findBestClashNode(state: ClashState, group: string, results: ClashNodeDelay[]): BestClashNode | undefined {
  if (state.mode === "direct" || state.proxies[group]?.type !== "Selector") return undefined;
  const concrete = new Set(clashNodeNames(state.proxies));
  const paths = new Map<string, Selection[]>();
  const visited = new Set<string>();
  const queue: Array<{ group: string; path: Selection[] }> = [{ group, path: [] }];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (visited.has(current.group)) continue;
    visited.add(current.group);
    const proxy = state.proxies[current.group];
    if (proxy?.type !== "Selector" || !proxy.now || !proxy.all?.includes(proxy.now)) continue;
    const children = [proxy.now, ...proxy.all.filter((node) => node !== proxy.now)];
    for (const node of children) {
      const path = [...current.path, { group: current.group, node, previous: proxy.now }];
      if (concrete.has(node) && !paths.has(node)) paths.set(node, path);
      else if (state.proxies[node]?.type === "Selector") queue.push({ group: node, path });
    }
  }
  const active = resolveProxyChain(state.proxies, group).at(-1);
  const candidates = results.flatMap(({ node, delay }) => delay.ok && paths.has(node)
    ? [{ group, node, ms: delay.ms, selections: paths.get(node)! }] : []);
  return candidates.sort((a, b) => a.ms - b.ms || Number(b.node === active) - Number(a.node === active) || a.node.localeCompare(b.node))[0];
}

/** Apply inner selectors first; undo our own writes if verification fails. */
export async function selectBestClashNode(
  api: Pick<ClashApiClient, "getState" | "getProxies" | "select">,
  baseline: ClashState, plan: BestClashNode, signal: AbortSignal, active: () => boolean = () => true,
): Promise<{ changed: boolean; state: ClashState }> {
  const attempted: Selection[] = [];
  const completed = new Set<string>();
  const check = (state: ClashState) => {
    if (signal.aborted || !active()) throw new Error("Clash 操作已取消，未完成节点切换。");
    if (state.mode !== baseline.mode || state.mode === "direct") throw new Error("Clash 路由模式已变化，请重新测速后切换。");
    if (state.proxies[plan.node]?.type !== baseline.proxies[plan.node]?.type || state.proxies[plan.node]?.all) throw new Error("Clash 最佳节点已变化，请重新测速。");
    for (const selection of plan.selections) {
      const proxy = state.proxies[selection.group];
      const expected = completed.has(selection.group) ? selection.node : selection.previous;
      if (proxy?.type !== "Selector" || !proxy.all?.includes(selection.node) || proxy.now !== expected) {
        throw new Error("Clash 策略组或手动选择已变化，请重新测速后切换。");
      }
    }
  };
  try {
    for (const selection of [...plan.selections].reverse()) {
      check(await api.getState());
      if (selection.previous !== selection.node) {
        // A timed-out PUT may have reached the core, so include attempted writes.
        attempted.push(selection);
        await api.select(selection.group, selection.node);
      }
      completed.add(selection.group);
    }
    const state = await api.getState();
    check(state);
    if (resolveProxyChain(state.proxies, plan.group).at(-1) !== plan.node) throw new Error("Clash 未确认最佳节点已生效。");
    return { changed: attempted.length > 0, state };
  } catch (error) {
    if (!attempted.length) throw error;
    let restored = true;
    for (const selection of attempted.reverse()) {
      try {
        const current = (await api.getProxies())[selection.group];
        if (current?.now === selection.previous) continue;
        // Do not overwrite a later selection made by another client.
        if (current?.type !== "Selector" || current.now !== selection.node || !current.all?.includes(selection.previous)) throw new Error();
        await api.select(selection.group, selection.previous);
        if ((await api.getProxies())[selection.group]?.now !== selection.previous) throw new Error();
      } catch { restored = false; }
    }
    throw new Error(restored ? "Clash 自动切换未完成，已恢复原节点选择。" : "Clash 自动切换未完成，原选择未完全恢复，请检查当前节点。");
  }
}

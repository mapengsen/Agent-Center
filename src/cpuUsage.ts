import * as os from "node:os";

export interface CpuSnapshot { cores: number; total: number; idle: number }
export interface CpuUsage {
  state: "ready" | "unavailable";
  logicalCores: number;
  totalPercent?: number;
  machinePercent?: number;
  coresUsed?: number;
}
export interface CpuReader { read(signal?: AbortSignal): Promise<CpuUsage>; reset(): void }

export function snapshotCpu(cpus: Pick<os.CpuInfo, "times">[]): CpuSnapshot | undefined {
  if (!cpus.length) return undefined;
  let total = 0, idle = 0;
  for (const { times } of cpus) {
    const values = [times.user, times.nice, times.sys, times.idle, times.irq];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return undefined;
    total += values.reduce((sum, value) => sum + value, 0);
    idle += times.idle;
  }
  return { cores: cpus.length, total, idle };
}

export function cpuUsageBetween(before: CpuSnapshot, after: CpuSnapshot): CpuUsage | undefined {
  if (before.cores !== after.cores || after.cores < 1) return undefined;
  const total = after.total - before.total, idle = after.idle - before.idle;
  if (!Number.isFinite(total) || !Number.isFinite(idle) || total <= 0 || idle < 0 || idle > total) return undefined;
  const fraction = (total - idle) / total;
  return { state: "ready", logicalCores: after.cores, totalPercent: fraction * after.cores * 100,
    machinePercent: fraction * 100, coresUsed: fraction * after.cores };
}

export class CpuUsageSampler implements CpuReader {
  private previous: CpuSnapshot | undefined;
  private generation = 0;
  public constructor(private readonly readCpus: typeof os.cpus = os.cpus,
    private readonly wait: (signal?: AbortSignal) => Promise<boolean> = warmup) {}

  public reset(): void { this.previous = undefined; this.generation++; }

  public async read(signal?: AbortSignal): Promise<CpuUsage> {
    const generation = this.generation;
    let cores = 0;
    try {
      if (signal?.aborted) return { state: "unavailable", logicalCores: cores };
      const current = snapshotCpu(this.readCpus());
      if (!current) { this.previous = undefined; return { state: "unavailable", logicalCores: cores }; }
      cores = current.cores;
      const reading = this.previous && cpuUsageBetween(this.previous, current);
      this.previous = current;
      if (reading) return reading;
      // The first sample (also after a pause) measures a real interval, not a
      // lifetime average and not a fabricated 0%. Cancellation does not throw.
      if (!await this.wait(signal) || signal?.aborted || generation !== this.generation) return { state: "unavailable", logicalCores: cores };
      const next = snapshotCpu(this.readCpus());
      this.previous = next;
      return next && cpuUsageBetween(current, next) || { state: "unavailable", logicalCores: cores };
    } catch { this.previous = undefined; return { state: "unavailable", logicalCores: cores }; }
  }
}

function warmup(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(false); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(true); }, 250);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

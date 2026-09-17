/**
 * A setTimeout chain rather than a cron library (design D4): a cron expression
 * cannot express "±30 s of jitter", and the chain cannot stack overlapping runs
 * the way setInterval can. A run may hand back a backoff (design D5), which
 * stretches the wait before the next one.
 */

export type RunOutcome = { backoffMs?: number } | void;

export type SchedulerOptions = {
  intervalMs: number;
  jitterMs: number;
  run: () => Promise<RunOutcome>;
  onError: (error: unknown) => void;
  random?: () => number;
  now?: () => number;
};

/**
 * Base interval plus a uniform offset in [-jitter, +jitter], clamped so a
 * jittered run can never cross the following one even if jitter is
 * misconfigured larger than the interval.
 */
export function nextDelay(intervalMs: number, jitterMs: number, random: () => number): number {
  const offset = jitterMs === 0 ? 0 : (random() * 2 - 1) * jitterMs;
  const delay = intervalMs + offset;
  const floor = Math.min(1_000, intervalMs);
  return Math.max(floor, Math.min(delay, 2 * intervalMs));
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;
  private skipped = 0;
  private nextAt: number | null = null;

  constructor(private readonly options: SchedulerOptions) {}

  /** Number of runs skipped because a previous poll was still in flight. */
  get skippedRuns(): number {
    return this.skipped;
  }

  /** When the next run is due, or null while none is scheduled. */
  get nextRunAt(): string | null {
    return this.nextAt === null ? null : new Date(this.nextAt).toISOString();
  }

  /** Runs once immediately, then chains. The first run is awaited so startup can act on it. */
  async start(): Promise<void> {
    const outcome = await this.tick();
    this.scheduleNext(outcome);
  }

  stop(): void {
    this.stopped = true;
    this.nextAt = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** The next delay: the jittered interval, stretched to any backoff the last run asked for. */
  delayAfter(outcome: RunOutcome): number {
    const jittered = nextDelay(this.options.intervalMs, this.options.jitterMs, this.options.random ?? Math.random);
    return Math.max(jittered, outcome?.backoffMs ?? 0);
  }

  private scheduleNext(outcome: RunOutcome): void {
    if (this.stopped) return;
    const delay = this.delayAfter(outcome);
    this.nextAt = (this.options.now ?? Date.now)() + delay;
    this.timer = setTimeout(() => {
      this.nextAt = null;
      void this.tick().then((next) => this.scheduleNext(next));
    }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<RunOutcome> {
    if (this.inFlight) {
      this.skipped += 1;
      return;
    }
    this.inFlight = true;
    try {
      return await this.options.run();
    } catch (error) {
      // A poll must never kill the process or break the chain.
      this.options.onError(error);
      return;
    } finally {
      this.inFlight = false;
    }
  }
}

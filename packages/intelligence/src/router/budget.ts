/**
 * In-memory daily spend tracker used by the model router as a cost guard.
 * Spend is keyed by UTC day; a new day resets the counter.
 */
export interface BudgetOptions {
  dailyLimitUsd: number;
  now?: () => Date;
}

export class Budget {
  readonly dailyLimitUsd: number;
  private readonly now: () => Date;
  private day: string;
  private spentUsd = 0;
  private calls = 0;

  constructor(options: BudgetOptions) {
    if (!(options.dailyLimitUsd >= 0)) throw new Error("dailyLimitUsd must be >= 0");
    this.dailyLimitUsd = options.dailyLimitUsd;
    this.now = options.now ?? (() => new Date());
    this.day = this.today();
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private rollover(): void {
    const today = this.today();
    if (today !== this.day) {
      this.day = today;
      this.spentUsd = 0;
      this.calls = 0;
    }
  }

  /** Records realised spend. Unknown cost (null) is counted as a call with zero dollars and flagged by callers. */
  record(costUsd: number | null): void {
    this.rollover();
    this.calls += 1;
    if (costUsd !== null && Number.isFinite(costUsd) && costUsd > 0) this.spentUsd += costUsd;
  }

  spentTodayUsd(): number {
    this.rollover();
    return this.spentUsd;
  }

  callsToday(): number {
    this.rollover();
    return this.calls;
  }

  remainingUsd(): number {
    this.rollover();
    return Math.max(0, this.dailyLimitUsd - this.spentUsd);
  }

  canSpend(estimateUsd: number): boolean {
    this.rollover();
    return this.spentUsd + Math.max(0, estimateUsd) <= this.dailyLimitUsd;
  }
}

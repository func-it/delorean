import "server-only";

import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The daily spending cap. Every Quote and every quoter Problem carries
 * `usage.cost_usd`; the BFF adds what it relays to the day's total (a UTC
 * day) and, once the total reaches `DAILY_BUDGET_USD`, answers
 * `503 daily_budget_exhausted` before calling the quoter.
 *
 * The total lives in one small JSON file, `{"day": "2026-10-04", "spent_usd": 1.25}`,
 * replaced atomically (written beside, fsynced, renamed over), so that a
 * restart of the container, even a kill in the middle of a write, finds either
 * the previous total or the new one, never half of one. Put the file on a volume.
 *
 * One process: the in-memory total is the truth after the first read, and the
 * calls are queued so that two answers arriving together cannot lose an
 * update. Several instances would each count their own spending: they need a
 * shared counter (Redis `INCRBYFLOAT` on a key per day) behind this same interface.
 *
 * The cap is soft by the quotes in flight: they were allowed before the total
 * reached the limit, and each is added when it ends.
 */
export interface BudgetStore {
  /** USD relayed so far today (UTC). */
  spentToday(): Promise<number>;
  /** Adds the cost of one relayed answer to today's total. */
  add(costUsd: number): Promise<void>;
}

interface Ledger {
  day: string;
  spent_usd: number;
}

/** USD are summed in millionths: the quoters' costs are fractions of a cent, and floats would drift. */
const MICRO = 1_000_000;

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Seconds until the next UTC midnight, at least 1. */
export function secondsUntilUtcMidnight(now: number): number {
  const next = Date.parse(`${utcDay(now)}T00:00:00Z`) + 86_400_000;
  return Math.max(1, Math.ceil((next - now) / 1000));
}

export class FileBudgetStore implements BudgetStore {
  private readonly file: string;
  private readonly now: () => number;
  private ledger: Promise<Ledger> | undefined;
  /** The calls run one after the other. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  spentToday(): Promise<number> {
    return this.exclusive(async () => (await this.today()).spent_usd);
  }

  add(costUsd: number): Promise<void> {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return Promise.resolve();
    return this.exclusive(async () => {
      const ledger = await this.today();
      ledger.spent_usd = (Math.round(ledger.spent_usd * MICRO) + Math.round(costUsd * MICRO)) / MICRO;
      await this.persist(ledger);
    });
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** The ledger of the current UTC day: the file's the first time, a fresh one when the day has changed. */
  private async today(): Promise<Ledger> {
    this.ledger ??= this.load();
    const ledger = await this.ledger;
    const day = utcDay(this.now());
    if (ledger.day !== day) {
      ledger.day = day;
      ledger.spent_usd = 0;
    }
    return ledger;
  }

  private async load(): Promise<Ledger> {
    const fresh = { day: utcDay(this.now()), spent_usd: 0 };
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[budget] cannot read ${this.file}:`, error);
      return fresh;
    }
    try {
      const { day, spent_usd } = JSON.parse(text) as Partial<Ledger>;
      if (typeof day === "string" && typeof spent_usd === "number" && Number.isFinite(spent_usd) && spent_usd >= 0) {
        return { day, spent_usd };
      }
      throw new Error("unexpected content");
    } catch (error) {
      console.error(`[budget] ${this.file} is unreadable, counting from zero:`, error);
      return fresh;
    }
  }

  /** A write that fails is logged, not thrown: the total stays right in memory and the quote is still answered. */
  private async persist(ledger: Ledger): Promise<void> {
    const temporary = `${this.file}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const handle = await open(temporary, "w");
      try {
        await handle.writeFile(`${JSON.stringify(ledger)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
    } catch (error) {
      console.error(`[budget] cannot write ${this.file}:`, error);
    }
  }
}

/** The cap in USD, read at request time; absent, 0 or invalid means no cap. */
export function dailyBudgetUsd(): number {
  const value = Number(process.env.DAILY_BUDGET_USD);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * What a call counts for when its answer says nothing of its cost: the quoter
 * did not answer (the BFF's own `quoter_unavailable`: too slow, unreachable,
 * out of contract) or failed without a usage. The call may have spent all the
 * same, so the budget takes a flat estimate, `UNANSWERED_QUOTE_COST_USD`
 * (0.002 by default, a few typical quotes; 0 counts nothing, an invalid value
 * is the default).
 */
export function unansweredQuoteCostUsd(): number {
  const raw = process.env.UNANSWERED_QUOTE_COST_USD;
  if (raw === undefined || raw === "") return DEFAULT_UNANSWERED_COST_USD;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_UNANSWERED_COST_USD;
}

const DEFAULT_UNANSWERED_COST_USD = 0.002;

/**
 * A client address's share of the day's budget, `IP_DAILY_BUDGET_USD`: one
 * address cannot spend the whole of it. Absent, a quarter of
 * `DAILY_BUDGET_USD` (and none when that is not set either); `0` turns it
 * off; an invalid value is the default. 0 means no cap per address.
 */
export function ipDailyBudgetUsd(): number {
  const raw = process.env.IP_DAILY_BUDGET_USD;
  const fallback = dailyBudgetUsd() * IP_SHARE;
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const IP_SHARE = 0.25;

/** What one address's quotes cost today (UTC). In memory: it starts again at a restart, the global ledger being the one kept. */
export interface IpBudgetStore {
  spentToday(key: string): Promise<number>;
  add(key: string, costUsd: number): Promise<void>;
}

/** How many addresses are kept at most; past that, the least recently used go first. */
const IP_CAPACITY = 50_000;

interface IpLedger {
  day: string;
  micro: number;
}

export class MemoryIpBudgetStore implements IpBudgetStore {
  private readonly ledgers = new Map<string, IpLedger>();
  private readonly now: () => number;
  private readonly capacity: number;

  constructor(now: () => number = Date.now, capacity: number = IP_CAPACITY) {
    this.now = now;
    this.capacity = capacity;
  }

  async spentToday(key: string): Promise<number> {
    const entry = this.ledgers.get(key);
    return entry && entry.day === utcDay(this.now()) ? entry.micro / MICRO : 0;
  }

  async add(key: string, costUsd: number): Promise<void> {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    const day = utcDay(this.now());
    const before = this.ledgers.get(key);
    const micro = (before?.day === day ? before.micro : 0) + Math.round(costUsd * MICRO);
    this.ledgers.delete(key);
    this.ledgers.set(key, { day, micro });
    for (const old of this.ledgers.keys()) {
      if (this.ledgers.size <= this.capacity) break;
      this.ledgers.delete(old);
    }
  }
}

let ipStore: IpBudgetStore | undefined;

/** The process's per-address store, built at its first use. */
export function ipBudgetStore(): IpBudgetStore {
  ipStore ??= new MemoryIpBudgetStore();
  return ipStore;
}

/** For tests: replaces the per-address store; without one, the next use builds it again. */
export function setIpBudgetStore(replacement?: IpBudgetStore): void {
  ipStore = replacement;
}

let store: BudgetStore | undefined;

/** The process's store, on `BUDGET_FILE` (`.data/budget.json` by default), built at its first use. */
export function budgetStore(): BudgetStore {
  store ??= new FileBudgetStore(process.env.BUDGET_FILE || ".data/budget.json");
  return store;
}

/** For tests: replaces the process's store; without one, the next use builds it from the environment again. */
export function setBudgetStore(replacement?: BudgetStore): void {
  store = replacement;
}

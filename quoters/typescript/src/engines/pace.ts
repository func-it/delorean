import { createHash } from 'node:crypto';
import { EngineError, type Engines, type Stage } from '../pipeline/ports.ts';

/**
 * A model's time, given to the fake engines for the load bench
 * (docs/architecture.md, "Fake latency"): the same cart takes the same time
 * in every quoter and every run, so the bench measures the runtimes, not the
 * models.
 */
export interface Pace {
  /** `real`: each call waits its stage's time, without holding the thread. */
  latency: 'off' | 'real';
  /** The milliseconds each call first keeps the processor busy, synchronously. */
  cpuMs: number;
}

/** Each stage's time, in milliseconds, before the jitter. */
const BASE_MS: Partial<Record<Stage, number>> = { guard: 400, parse: 1200, recount: 2500, identify: 300, judge: 350 };

/**
 * The time a call of `stage` reading `input` takes: its base, give or take
 * 20 %, the jitter drawn from SHA-256(stage + "\n" + input), in integer
 * arithmetic, as every quoter computes it.
 */
export function fakeMs(stage: Stage, input: string): number {
  const base = BigInt(BASE_MS[stage] ?? 0);
  const n = BigInt(createHash('sha256').update(`${stage}\n${input}`).digest().readUInt32BE(0));
  return Number((base * 4n) / 5n + (base * 2n * n) / (5n * 2n ** 32n));
}

/** The fake engines, each call paced: first `cpuMs` of busy processor, then, with real latency, its stage's time. */
export function paced(engines: Engines, pace: Pace): Engines {
  if (pace.latency === 'off' && pace.cpuMs === 0) return engines;
  const take = async (stage: Stage, input: string, signal: AbortSignal) => {
    busy(pace.cpuMs);
    if (pace.latency === 'real') await wait(fakeMs(stage, input), signal);
  };
  const { guard, parser, recounter, identifier, judge } = engines;
  return {
    ...engines,
    guard: {
      async check(text, call) {
        await take('guard', text, call.signal);
        return guard.check(text, call);
      },
    },
    parser: {
      async read(text, call, retry) {
        await take('parse', text, call.signal);
        return parser.read(text, call, retry);
      },
    },
    recounter: {
      async read(text, call) {
        await take('recount', text, call.signal);
        return recounter.read(text, call);
      },
    },
    identifier: {
      async identify(titles, call) {
        await take('identify', titles.join('\n'), call.signal);
        return identifier.identify(titles, call);
      },
    },
    judge: {
      async judge(text, lines, call) {
        await take('judge', text, call.signal);
        return judge.judge(text, lines, call);
      },
    },
  };
}

/** Keeps the processor busy `ms` milliseconds, as heavy parsing would: what CPU-bound work does to one thread. */
function busy(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spinning, on purpose
  }
}

/** Waits `ms` on a timer; a request that ends first fails the call as an engine that did not answer in time. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  const late = () => new EngineError('no answer in time', { usage: { engine: 'fake', calls: 1, costUsd: 0 } });
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(late());
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(late());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

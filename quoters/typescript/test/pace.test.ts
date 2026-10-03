import { describe, expect, it } from 'vitest';
import { fakeEngines } from '../src/engines/fake.ts';
import { fakeMs, paced } from '../src/engines/pace.ts';
import { EngineError } from '../src/pipeline/ports.ts';

// The fake engines' pace for the load bench (docs/architecture.md, "Fake
// latency"): the same time for the same cart, in every quoter.

describe('fakeMs', () => {
  it.each([
    ['guard', 'Heat', 385],
    ['parse', 'Back to the Future 1\nHeat', 1186],
    ['recount', 'Back to the Future 1\nHeat', 2770],
    ['identify', 'Heat', 316],
    ['judge', '', 377],
  ] as const)('gives the %s of %j %i ms, as the spec computes it', (stage, input, ms) => {
    expect(fakeMs(stage, input)).toBe(ms);
  });

  it('stays within 20 % of the base', () => {
    for (let i = 0; i < 500; i++) {
      const ms = fakeMs('parse', `cart ${i}`);
      expect(ms).toBeGreaterThanOrEqual(960);
      expect(ms).toBeLessThan(1440);
    }
  });
});

describe('paced', () => {
  const call = () => ({ signal: new AbortController().signal });

  it('leaves the fakes as they are, instant, when latency is off and no CPU is asked', () => {
    const engines = fakeEngines();
    expect(paced(engines, { latency: 'off', cpuMs: 0 })).toBe(engines);
  });

  it("waits the stage's time on a timer, then answers as the fake does", async () => {
    const engines = paced(fakeEngines(), { latency: 'real', cpuMs: 0 });
    const started = performance.now();
    const answer = await engines.guard.check('Heat', call());
    expect(performance.now() - started).toBeGreaterThanOrEqual(384);
    expect(answer).toMatchObject({ order: 1, steer: 0.01 });
  });

  it('identifies on the titles asked, one per line', async () => {
    const engines = paced(fakeEngines(), { latency: 'real', cpuMs: 0 });
    const started = performance.now();
    await engines.identifier.identify(['Heat'], call());
    expect(performance.now() - started).toBeGreaterThanOrEqual(315);
  });

  it('fails as an engine that did not answer in time when the request ends first', async () => {
    const engines = paced(fakeEngines(), { latency: 'real', cpuMs: 0 });
    const error = await engines.recounter.read('Heat', { signal: AbortSignal.timeout(20) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as Error).message).toBe('no answer in time');
  });

  it('keeps the processor busy first, synchronously', async () => {
    const engines = paced(fakeEngines(), { latency: 'off', cpuMs: 30 });
    let ticked = false;
    setTimeout(() => (ticked = true), 0);
    const started = performance.now();
    const pending = engines.judge.judge('Heat', [], call());
    // the busy loop ran before the call returned its promise: no timer could fire meanwhile
    expect(performance.now() - started).toBeGreaterThanOrEqual(30);
    expect(ticked).toBe(false);
    await pending;
  });
});

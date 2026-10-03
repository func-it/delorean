import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { describe, expect, it } from 'vitest';
import { cachedIdentifier, Lru } from '../src/engines/live/cache.ts';
import { pooled } from '../src/engines/live/index.ts';
import type { Identification, Identifier } from '../src/pipeline/ports.ts';

const call = { signal: new AbortController().signal };
const idle = { engine: 'jev-1.13', model: 'typesafe/jev-1.13', calls: 0, costUsd: 0 };

/** An identifier that answers `film` for every title, and keeps what it was asked. */
function jev(film: (title: string) => string = () => 'other') {
  const asked: string[][] = [];
  const identifier: Identifier = {
    identify: (titles) => {
      asked.push([...titles]);
      const identifications = titles.map((t) => ({ film: film(t), confidence: 0.9 }) as Identification);
      return Promise.resolve({ identifications, usage: { engine: 'jev-1.13', calls: titles.length, costUsd: 0.001 } });
    },
  };
  return { asked, identifier };
}

describe('Lru', () => {
  it('keeps the most recently used entries, a read making an entry recent', () => {
    const lru = new Lru<number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1);
    lru.set('c', 3);
    expect([lru.get('a'), lru.get('b'), lru.get('c')]).toEqual([1, undefined, 3]);
    expect(lru.length).toBe(2);
  });

  it('keeps nothing at size 0', () => {
    const lru = new Lru<number>(0);
    lru.set('a', 1);
    expect(lru.get('a')).toBeUndefined();
  });
});

describe('cachedIdentifier', () => {
  it('asks Jev only for the titles it has not kept, by merge key, and answers in the order of the titles', async () => {
    const { asked, identifier } = jev((t) => (t.includes('2') ? 'bttf_2' : 'other'));
    const cached = cachedIdentifier(identifier, new Lru(100), 'v1 jev', idle);
    await cached.identify(['Heat', 'Back to the Future 2'], call);
    const second = await cached.identify(['heat', 'Ronin', 'BACK TO THE FUTURE 2'], call);
    expect(asked).toEqual([['Heat', 'Back to the Future 2'], ['Ronin']]);
    expect(second.identifications.map((i) => i.film)).toEqual(['other', 'other', 'bttf_2']);
    expect(second.usage.calls).toBe(1);
  });

  it('makes no call when every title is kept', async () => {
    const { asked, identifier } = jev();
    const cached = cachedIdentifier(identifier, new Lru(100), 'v1 jev', idle);
    await cached.identify(['Heat'], call);
    const again = await cached.identify(['Heat'], call);
    expect(asked).toHaveLength(1);
    expect(again.usage).toEqual(idle);
  });

  it('starts afresh under another prompt version or model', async () => {
    const { asked, identifier } = jev();
    const lru = new Lru<Identification>(100);
    await cachedIdentifier(identifier, lru, 'v1 jev', idle).identify(['Heat'], call);
    await cachedIdentifier(identifier, lru, 'v2 jev', idle).identify(['Heat'], call);
    expect(asked).toEqual([['Heat'], ['Heat']]);
  });

  it('keeps no error, nor an answer out of the contract', async () => {
    let fail = true;
    const flaky: Identifier = {
      identify: (titles) =>
        fail
          ? Promise.reject(new Error('jev down'))
          : Promise.resolve({
              identifications: titles.map(() => ({ film: 'bttf_4' as never, confidence: 1 })),
              usage: idle,
            }),
    };
    const cached = cachedIdentifier(flaky, new Lru(100), 'v1 jev', idle);
    await expect(cached.identify(['Heat'], call)).rejects.toThrow('jev down');
    fail = false;
    await cached.identify(['Heat'], call);
    const { asked, identifier } = jev();
    const lru = new Lru<Identification>(100);
    const kept = cachedIdentifier(identifier, lru, 'v1 jev', idle);
    await kept.identify(['Heat'], call);
    expect(lru.length).toBe(1);
    expect(asked).toHaveLength(1);
  });
});

describe('pooled', () => {
  it("reuses the agent's connections from one call to the next", async () => {
    const sockets = new Set<unknown>();
    const server = createServer((req, res) => {
      sockets.add(req.socket);
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const agent = new Agent({ keepAliveTimeout: 10_000 });
    const fetch = pooled(agent);
    for (let i = 0; i < 6; i++) await (await fetch(url)).text();
    // kept alive: six calls on one or two connections, never one each
    expect(sockets.size).toBeLessThanOrEqual(2);
    await agent.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
});

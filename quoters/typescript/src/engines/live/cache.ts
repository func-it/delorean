import type { EngineUsage, Identification, Identifier } from '../../pipeline/ports.ts';
import { isFilm } from '../../cart.ts';
import { isUnit } from '../../pipeline/reading.ts';
import { annotate } from '../../telemetry/trace.ts';
import { titleKey } from '../../text.ts';

/**
 * Titles already identified, across requests (docs/architecture.md, §4). A
 * film depends on the title alone, and titles repeat ("Back to the Future 2"
 * comes back all day): Jev is asked only for the titles not kept. The key is
 * the title's merge key, under a scope that names what answered (the
 * identify prompt's version and JEV_MODEL), so a new prompt or model starts
 * afresh. Only answers are kept, never an error.
 */
export function cachedIdentifier(
  inner: Identifier,
  cache: Lru<Identification>,
  scope: string,
  /** What the stage took when every title was kept: the engine's name, and no call. */
  idle: EngineUsage,
): Identifier {
  return {
    async identify(titles, call) {
      const key = (title: string) => `${scope}\n${titleKey(title)}`;
      const kept = titles.map((t) => cache.get(key(t)));
      const asked = titles.filter((_, i) => kept[i] === undefined);
      annotate({ cache_hits: titles.length - asked.length });
      if (asked.length === 0) {
        return { identifications: kept as Identification[], usage: idle };
      }
      const answer = await inner.identify(asked, call);
      // only answers within the contract: one the pipeline refuses must be asked again
      asked.forEach((t, i) => {
        const id = answer.identifications[i];
        if (id && isFilm(id.film) && isUnit(id.confidence)) cache.set(key(t), id);
      });
      const fresh = answer.identifications[Symbol.iterator]();
      const identifications = kept.map((id) => id ?? (fresh.next().value as Identification));
      return { identifications, usage: answer.usage };
    },
  };
}

/** A map that keeps its `size` most recently used entries; size 0 keeps none. */
export class Lru<V> {
  readonly #size: number;
  readonly #entries = new Map<string, V>();

  constructor(size: number) {
    this.#size = size;
  }

  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    if (value !== undefined) {
      // most recent last: a Map iterates in insertion order
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    if (this.#size === 0) return;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.#size) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
  }

  get length(): number {
    return this.#entries.size;
  }
}

import type { Film, Line, Mention } from '../cart.ts';
import {
  EngineError,
  type Answered,
  type EngineUsage,
  type Engines,
  type Finding,
  type Guard,
  type Identifier,
  type Judge,
  type Reader,
} from '../pipeline/ports.ts';
import { titleKey, trimSpace } from '../text.ts';

/**
 * The engines of ENGINES=fake: deterministic stand-ins for Jev and the LLMs,
 * for end-to-end tests without OpenRouter, never in production. Their rules
 * are part of the test contract (docs/architecture.md, "Fake engines").
 */
export function fakeEngines(): Engines {
  return { name: 'fake', guard, parser, recounter, identifier, judge };
}

/** Lines of a cart that drive the fakes instead of naming films. */
export const DIRECTIVE = {
  /** Fails the judge's missing check. */
  unfaithful: '#fake:unfaithful',
  /** Fails the parse as an engine fails. */
  engineDown: '#fake:engine_down',
  /** Adds a copy of the first mention to the recount, which fails the count check of its film. */
  miscount: '#fake:miscount',
  /** Leaves the last mention out of the first reading only: the cart is priced on the second. */
  reread: '#fake:reread',
  /** Makes the recount answer off its schema at every call: the quote goes on without it. */
  recountOffSchema: '#fake:recount_offschema',
};
const DIRECTIVE_PREFIX = '#fake:';

/** Every fake stage is one free call. */
const usage = (): EngineUsage => ({ engine: 'fake', calls: 1, costUsd: 0 });

const hasLine = (text: string, line: string) => text.split('\n').includes(line);

const INJECTION_MARKS = ['ignore', 'disregard', 'oublie', 'instruction', 'system prompt', '<script', 'drop table'];
const THREE_LETTERS = /\p{L}{3}/u;

/** `steer` 0.99 on an injection mark in any case, else 0.01; `order` 1 when a line holds three letters in a row, else 0. */
const guard: Guard = {
  check(text) {
    const lower = text.toLowerCase();
    const steer = INJECTION_MARKS.some((mark) => lower.includes(mark)) ? 0.99 : 0.01;
    const order = THREE_LETTERS.test(text) ? 1 : 0;
    return Promise.resolve({ order, steer, usage: usage() });
  },
};

const QUANTITY_FIRST = /^(\d+) [x×] (.+)$/su;
const QUANTITY_LAST = /^(.+) [x×] (\d+)$/su;
/** A number in front, with no x: « 2 Back to the Future 2 ». */
const QUANTITY_BARE = /^(\d+) (.+)$/su;
/** Any way of naming the saga: a line that does and is not exactly one of its titles cannot be read safely. */
const SAGA_MENTION = /back to the future|bttf|future|futur|zukunft|futuro/u;

interface Reading {
  mentions: Mention[];
  /** The first line that cannot be read safely. */
  unreadable?: string;
}

/**
 * Each line that is not blank, and not a #fake: directive, is one mention, a
 * title with an optional quantity: "N x title", "N × title", "N title",
 * "title x N", "title × N", or a title alone for one copy. A line that names
 * the saga but is not exactly one of its titles (several titles, extra words,
 * another language, an abbreviation) is not read: it is returned as
 * `unreadable`. A title that does not mention the saga is another film.
 */
function readLines(text: string): Reading {
  const mentions: Mention[] = [];
  for (const line of text.split('\n').map(trimSpace)) {
    if (line === '' || line.startsWith(DIRECTIVE_PREFIX)) continue;
    const found = mention(line);
    const key = titleKey(found.title);
    if (!SAGA_TITLE.test(key) && SAGA_MENTION.test(key)) return { mentions, unreadable: line };
    mentions.push(found);
  }
  return { mentions };
}

function mention(line: string): Mention {
  for (const [pattern, quantityAt] of [
    [QUANTITY_FIRST, 1],
    [QUANTITY_LAST, 2],
    [QUANTITY_BARE, 1],
  ] as const) {
    const found = pattern.exec(line);
    const quantity = Number(found?.[quantityAt]);
    const title = found?.[quantityAt === 1 ? 2 : 1];
    if (title && quantity >= 1) return { title: trimSpace(title), quantity };
  }
  return { title: line, quantity: 1 };
}

/**
 * Each mention, or the outage of #fake:engine_down; with `leaveOutLast`, all
 * but the last mention.
 */
function read(text: string, leaveOutLast: boolean): Promise<Answered<Reading>> {
  if (hasLine(text, DIRECTIVE.engineDown)) {
    return Promise.reject(new EngineError(`fake engine unavailable (${DIRECTIVE.engineDown})`, { usage: usage() }));
  }
  const reading = readLines(text);
  if (leaveOutLast) reading.mentions.pop();
  return Promise.resolve({ ...reading, usage: usage() });
}

/** Reads every mention; but for a text with a #fake:reread line, its first reading leaves out the last one. */
const parser: Reader = {
  read: (text, _call, retry) => read(text, !retry && hasLine(text, DIRECTIVE.reread)),
};

/**
 * Reads every mention, blind; but for a text with a #fake:miscount line, one
 * more copy of the first; with a #fake:recount_offschema line it answers off
 * its schema.
 */
const recounter: Reader = {
  async read(text) {
    if (hasLine(text, DIRECTIVE.recountOffSchema)) {
      throw new EngineError(`fake recount: engine unavailable: answer off schema (${DIRECTIVE.recountOffSchema})`, {
        usage: usage(),
      });
    }
    const reading = await read(text, false);
    const [first] = reading.mentions;
    if (first && hasLine(text, DIRECTIVE.miscount)) first.quantity += 1;
    return reading;
  },
};

const SAGA_TITLE = /^back to the future (?:part )?(1|2|3|i|ii|iii)$/u;
const VOLUMES: Record<string, Film> = {
  '1': 'bttf_1',
  i: 'bttf_1',
  '2': 'bttf_2',
  ii: 'bttf_2',
  '3': 'bttf_3',
  iii: 'bttf_3',
};

/**
 * Knows the saga under its English title only: "back to the future" then 1,
 * 2, 3, i, ii or iii, with or without "part", in any case and spacing. Every
 * other title is another film.
 */
const identifier: Identifier = {
  identify(titles) {
    const identifications = titles.map((title) => {
      const volume = SAGA_TITLE.exec(titleKey(title))?.[1];
      return { film: (volume && VOLUMES[volume]) || 'other', confidence: 1 } as const;
    });
    return Promise.resolve({ identifications, usage: usage() });
  },
};

/**
 * Holds every reading faithful, but for the missing check, which scores 0
 * when the text has a #fake:unfaithful line, or when the reading lacks a
 * title the parser's full reading has.
 */
const judge: Judge = {
  judge(text, lines: readonly Line[]) {
    const findings: Finding[] = lines.flatMap((l) => [
      { check: 'asked' as const, label: l.title, score: 1 },
      { check: 'identity' as const, label: l.title, score: 1 },
    ]);
    const read = new Set(lines.map((l) => titleKey(l.title)));
    const lacks = readLines(text).mentions.some((m) => !read.has(titleKey(m.title)));
    findings.push({
      check: 'missing',
      label: 'the whole reading',
      score: hasLine(text, DIRECTIVE.unfaithful) || lacks ? 0 : 1,
    });
    return Promise.resolve({ findings, usage: usage() });
  },
};

# ADR 0001: read the cart with models, not with a deterministic parser

Status: accepted. Applies to the whole reading (`prepare` → `guard` → `parse` →
`identify` → `judge`, [architecture](../architecture.md#the-stages-of-post-v1quotes)).

## Context

The brief asks for a web app where the customer enters « un panier sous forme
de texte qui contient le nom des films achetés » and gets the order's price.
Its five examples are lists of titles written one per line, as in
`Back to the Future 1`. But the sentence says *text that contains the names of
the films*, and a customer does not write like an example: a sentence, a story
(« mon neveu adore Doc et sa DeLorean, je voudrais les deux premiers »), another
language (« Zurück in die Zukunft »), a quantity in words (« deux fois »,
« a pair of »), a film mentioned and not bought, a trilogy asked as a box set.
The price rules are a few lines of arithmetic
([`pricing.ts`](../../quoter/src/pricing.ts)); the difficulty is entirely in
turning a text into lines of (film, quantity).

## Decision

Models read, code counts. A language model extracts titles and quantities
under a strict JSON schema (GPT-6 Luna); another model class (Jev) classifies:
is it an order, which film is this title, is this reading faithful to the text.
A second reading (the recount) is compared with the first in code. The price is
computed by code from lines already identified, and **no amount ever comes out
of a model**. A cart the models cannot read faithfully is refused with a stable
code, never priced approximately.

## Alternatives considered

**A deterministic parser**: a catalogue of the film titles and their spellings,
a few regular expressions for quantities (`N x title`, `title x N`), a list of
numerals. On the brief's format it is exact, free, instant, reproducible and
needs no key or network; it prices the five examples without any model. It
would not read a title in another language, a quantity in words, a story, a
title with a typo, nor tell a film that is bought from one that is mentioned
(« je l'ai déjà vu »). The shared cases hold dozens of those
([`cases/quote`](../../cases/quote): 46 of the 81 need a model; only the 35
tagged `fake` are passed by the small deterministic reader).

**One model that also computes the price**: rejected at once: a model's
arithmetic is not an audit trail, and the whole design keeps amounts out of
reach of text (an injection in a cart can at worst misfile a title).

**A model without a judge or a recount**: cheaper and faster, but a wrong
reading would be priced. Counting is the weak point (Jev does not count): see
[the recount](../architecture.md#3-recount-a-second-reading).

## Consequences

What was measured, from [`docs/testing.md`](../testing.md#results-kept-from-the-earlier-benches):

- **Reading rate**: on the 46 reading cases, three runs each, GPT-6 Luna at
  effort `minimal` read the films right 135 times out of 138 (2026-10-03);
  the last full pass of the component benches (2026-10-02) was 133 of 138, one
  run lost to a provider error.
- **Latency**: the parse took 1.2 s at the median and 2.5 s at p90 (same
  matrix); the stages around it add Jev calls. Earlier live checks of the
  brief's fifth example took 3.3 to 5.9 s for a whole quote.
- **Cost**: $0.08 of parse per 1,000 carts, $0.17 with the identification (same
  matrix); about $0.0006 a quote in the earlier live checks.
- **Not re-measured** since the recount was added and moved to GPT-6 Luna
  without reasoning: the cost and latency of a whole quote, and the rate of
  right readings with this recount. They are said so in the testing guide.
- **Errors**: in the benches, no run priced a cart wrong: every wrong reading
  was refused by the judge or the recount comparison. The price of that
  safety is refusals of carts that were fine (the guard refused two real films
  whose titles read like orders in those runs).

Risks that remain, and their mitigations:

- *A wrong reading that both readings and the judge accept.* The recount is the
  parser's own model, so its errors are correlated with the parse's: it catches
  a model reading the same cart differently from one call to the next, not one
  that misreads it the same way twice. Mitigation: the judge holds each line to
  the text, and a quote left without a recount does not price a line of several
  copies (`503 quantity_unverified`).
- *A provider outage or slowness*: every model call is bounded (6 s), a request
  too (15 s); a recount that fails is left out rather than failing the quote.
- *An instruction hidden in a cart*: the guard, the fence around the text, and
  above all the fact that models answer among bounded options and never an amount.
- *Cost drift*: a daily budget and a share per address in the web app; the
  service does not start on real models without one.
- *Non-determinism*: the same cart can be read differently on two calls; the
  tests that guarantee the brief's five examples therefore run on the fake
  engines only, and the real models are checked by hand and by the benches.

## When we would choose the other

A deterministic parser is the better design if any of these holds: the catalogue
is closed and the input format is fixed (an order form, a CSV, a barcode scan);
no other language is needed; there is a latency or cost budget a model cannot
meet (a call per quote is a cost and seconds); the system must run offline;
an audit needs the same input to give the same output, byte for byte.

## A hybrid, already here

The fake engines (`ENGINES=fake`) contain exactly such a parser: it reads
titles written as `Back to the Future 1/2/3` (or `I`/`II`/`III`), with free
case and spacing, and quantities as `N x title`. It is the demo mode (the page
says so), it runs the end-to-end suite without a key, and it prices the brief's
five examples exactly. A product that wants the brief's format only could ship
it as the reader and keep the models for the carts it cannot parse.

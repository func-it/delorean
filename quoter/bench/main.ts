/**
 * The stage benches: each stage of the reading played alone, against cases whose answer is known, on the
 * quoter's own engines (the cases are cases/<stage>/). From quoter/:
 *
 *     npm run bench:stage -- list
 *     npm run bench:stage -- check
 *     npm run bench:stage -- run guard [--runs 3] [--name …] [--desc …] [--dry-run] [--max-usd 1]
 *     npm run bench:stage -- matrix --subject parse [--variants bench/variants.yaml] [--runs 3] [--max-usd 1] [--dry-run]
 *     npm run bench:stage -- table --subject parse [--date 2026-10-03]
 *
 * `check` is offline. `run` and `matrix` call OpenRouter, and refuse to unless RUN_LIVE=1 and OPENROUTER_API_KEY are
 * set; `--dry-run` counts what they would send, offline (a matrix reads OpenRouter's price list, which is free).
 * Langfuse is optional: with LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL the runs are kept there
 * as experiments; without, in reports/.
 */
import { main, UsageError } from './commands.ts';

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof UsageError ? 2 : 1);
});

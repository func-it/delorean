import "server-only";

import type { Catalog } from "@/lib/contract";
import { configuredQuoter, quoterClient } from "@/lib/quoter";

/** What the page learns from the quoter, which is the authority on both. */
export interface QuoterFacts {
  /** `fake` when the quoter reads with its deterministic stand-ins: the page then says so. */
  engines?: "live" | "fake";
  /** The prices and the saga discounts it applies, for the page's footer. */
  catalog?: Catalog;
}

/** How long the quoter has to answer a page: a page that waits on it is worse than one without its facts. */
const TIMEOUT_MS = 3000;
/** Neither its engines nor its prices change between two requests. */
const REVALIDATE_SECONDS = 60;

/**
 * Asks the quoter its engines (`GET /healthz`) and its catalog (`GET /v1/catalog`), once each a minute.
 * A quoter that cannot be reached, or answers out of contract, gives no fact: the page shows no banner and
 * no price line, and works all the same.
 */
export async function quoterFacts(): Promise<QuoterFacts> {
  const client = quoterClient(configuredQuoter());
  const options = () => ({ next: { revalidate: REVALIDATE_SECONDS }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const [health, catalog] = await Promise.all([
    client.GET("/healthz", options()).then(({ data }) => data, () => undefined),
    client.GET("/v1/catalog", options()).then(({ data }) => data, () => undefined),
  ]);
  return { engines: health?.engines, catalog };
}

import { QuoteWorkspace } from "@/components/QuoteWorkspace";
import { maxBodyBytes, maxInputTokens } from "@/lib/limits";
import { quoterFacts } from "@/lib/quoter-facts";
import { describePrices } from "@/lib/shelf";

// Read at each request: the limits are the environment's, the engines and the prices the quoter's.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { engines, catalog } = await quoterFacts();
  // The quoter's limits, one figure from here to it: the page says when a cart nears them, and sends no cart over the first.
  return (
    <QuoteWorkspace
      limits={{ maxBodyBytes: maxBodyBytes(), maxInputTokens: maxInputTokens() }}
      engines={engines}
      prices={describePrices(catalog)}
    />
  );
}

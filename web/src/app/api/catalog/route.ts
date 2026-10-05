import { configuredQuoter } from "@/lib/quoters";
import { relay } from "@/lib/bff";

/** Prices and discounts change with a deployment, not between two requests. */
const REVALIDATE_SECONDS = 60;

/** The catalog of the quoter. */
export async function GET() {
  const requestId = crypto.randomUUID();

  return relay(configuredQuoter(), requestId, (client, signal) =>
    client.GET("/v1/catalog", { next: { revalidate: REVALIDATE_SECONDS }, signal }),
  );
}

import { QuoteWorkspace } from "@/components/QuoteWorkspace";
import { configuredQuoters } from "@/lib/quoters";
import { requireSession } from "@/lib/session";

export default async function HomePage() {
  const { username } = await requireSession();
  // Names only: quoter URLs never reach the browser.
  const quoters = configuredQuoters().map((quoter) => quoter.name);
  return <QuoteWorkspace username={username} quoters={quoters} />;
}

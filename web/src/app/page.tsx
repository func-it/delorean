import { QuoteWorkspace } from "@/components/QuoteWorkspace";
import { configuredQuoters } from "@/lib/quoters";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ quoter?: string | string[] }> }) {
  const { quoter } = await searchParams;
  // `?quoter=python` picks a quoter for a demo; an unknown name falls back to the default one.
  // Names only: quoter URLs never reach the browser.
  const names = configuredQuoters().map((entry) => entry.name);
  const picked = typeof quoter === "string" && names.includes(quoter) ? quoter : names[0];
  return <QuoteWorkspace quoter={picked} />;
}

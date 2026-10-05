import { QuoteWorkspace } from "@/components/QuoteWorkspace";
import { maxBodyBytes, maxInputTokens } from "@/lib/limits";
import { configuredQuoters } from "@/lib/quoters";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ quoter?: string | string[] }> }) {
  const { quoter } = await searchParams;
  // `?quoter=python` picks a quoter for a demo; an unknown name falls back to the default one.
  // Names only: quoter URLs never reach the browser.
  const names = configuredQuoters().map((entry) => entry.name);
  const picked = typeof quoter === "string" && names.includes(quoter) ? quoter : names[0];
  // The quoters' limits, one figure from here to them: the page says when a cart nears them, and sends no cart over the first.
  return <QuoteWorkspace quoter={picked} limits={{ maxBodyBytes: maxBodyBytes(), maxInputTokens: maxInputTokens() }} />;
}

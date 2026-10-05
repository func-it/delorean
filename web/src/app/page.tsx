import { QuoteWorkspace } from "@/components/QuoteWorkspace";
import { maxBodyBytes, maxInputTokens } from "@/lib/limits";

export default function HomePage() {
  // The quoter's limits, one figure from here to it: the page says when a cart nears them, and sends no cart over the first.
  return <QuoteWorkspace limits={{ maxBodyBytes: maxBodyBytes(), maxInputTokens: maxInputTokens() }} />;
}

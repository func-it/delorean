import { QuoteWorkspace } from "@/components/QuoteWorkspace";
import { configuredBackends } from "@/lib/backends";
import { requireSession } from "@/lib/session";

export default async function HomePage() {
  const { username } = await requireSession();
  // Names only: backend URLs never reach the browser.
  const backends = configuredBackends().map((backend) => backend.name);
  return <QuoteWorkspace username={username} backends={backends} />;
}

import type { Usage } from "@/lib/contract";
import { formatDuration, formatUsd } from "@/lib/format";

import styles from "./UsageLine.module.css";

/** What answering cost: shown for a quote and for a refusal alike. */
export function UsageLine({ usage }: { usage: Usage }) {
  const engines = usage.engines === "fake" ? "moteurs factices" : "moteurs réels";
  return (
    <p className={styles.usage}>
      Réponse de l&apos;implémentation {usage.implementation} ({engines}) en {formatDuration(usage.duration_ms)}, pour
      un coût de {formatUsd(usage.cost_usd)}.
    </p>
  );
}

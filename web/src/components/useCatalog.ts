import { useEffect, useState } from "react";

import { type BffResult, requestCatalog } from "@/lib/bff-client";
import type { Catalog } from "@/lib/contract";

export type CatalogState = { status: "loading" } | { status: "ready"; catalog: Catalog } | { status: "failed" };

/** The catalog of the selected backend, fetched again when the selection changes. */
export function useCatalog(backend: string): CatalogState {
  const [loaded, setLoaded] = useState<{ backend: string; result: BffResult<Catalog> }>();

  useEffect(() => {
    const controller = new AbortController();
    requestCatalog(backend, controller.signal).then(
      (result) => setLoaded({ backend, result }),
      () => {}, // aborted: a newer selection took over
    );
    return () => controller.abort();
  }, [backend]);

  if (loaded?.backend !== backend) return { status: "loading" };
  return loaded.result.ok ? { status: "ready", catalog: loaded.result.data } : { status: "failed" };
}

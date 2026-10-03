import { useEffect, useState } from "react";

import { type BffResult, requestCatalog } from "@/lib/bff-client";
import type { Catalog } from "@/lib/contract";

export type CatalogState = { status: "loading" } | { status: "ready"; catalog: Catalog } | { status: "failed" };

/** The catalog of the selected quoter, fetched again when the selection changes. */
export function useCatalog(quoter: string): CatalogState {
  const [loaded, setLoaded] = useState<{ quoter: string; result: BffResult<Catalog> }>();

  useEffect(() => {
    const controller = new AbortController();
    requestCatalog(quoter, controller.signal).then(
      (result) => setLoaded({ quoter, result }),
      () => {}, // aborted: a newer selection took over
    );
    return () => controller.abort();
  }, [quoter]);

  if (loaded?.quoter !== quoter) return { status: "loading" };
  return loaded.result.ok ? { status: "ready", catalog: loaded.result.data } : { status: "failed" };
}

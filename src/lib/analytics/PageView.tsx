"use client";

import { useEffect } from "react";
import { track } from "./track";

/** Drop into any page/layout: one `page_view` per mount. */
export function PageView({ name, props }: { name: string; props?: Record<string, string | number | boolean> }) {
  useEffect(() => {
    track("page_view", { name, ...(props ?? {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  return null;
}

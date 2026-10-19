"use client";

import dynamic from "next/dynamic";

/**
 * The ONE lazy wrapper for the drawer's text editor (Tiptap). A lazy
 * component resolves per wrapper instance: the Ideas page mounts this same
 * wrapper hidden once after load, so by the time a drawer renders it, it is
 * already resolved and paints synchronously — a second wrapper would suspend
 * again on its own first render (seen 2026-10-19: ~300 ms of empty editor
 * box on the first edit after a reload).
 */
export const LazyIdeaDetailsEditor = dynamic(
  () => import("@/components/ideas/IdeaDetailsEditor"),
  { ssr: false, loading: () => null },
);

/** Fetches the chunk ahead of the first mount. */
export const preloadIdeaDetailsEditor = () => {
  void import("@/components/ideas/IdeaDetailsEditor");
};

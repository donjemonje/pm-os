import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

/**
 * Model calls may stay silent for minutes: a reading or judging call thinks before its first byte, and Node's fetch
 * gives up on any request that is silent for 300 seconds (no response headers yet, or no new piece of the body).
 * A call cut that way fails as "fetch failed" — it looks like a broken endpoint, is asked again, thinks for the same
 * time and is cut again (found 2026-11-19: four tries of one request, each dead at 301 s; the provider had refused
 * nothing).
 *
 * The Google SDK's own way of raising the limit (httpOptions.timeout) does nothing on Node 24: it looks for timeout
 * fields on the global dispatcher, and this runtime's dispatcher has none. So the limit is raised here, where it can
 * be: every request to a model host carries its own headers and body timeout. Requests to any other host keep the
 * runtime's defaults — a hung third-party call still fails after 300 s.
 *
 * It wraps the dispatcher that is in place (dispatcher.compose), so whatever the process had set stays in effect.
 */

/** A model host of Vertex AI: the global endpoint, a regional one, or a multi-region one. */
export function isModelHost(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return /(^|-)aiplatform\.googleapis\.com$/.test(host) || /^aiplatform\.[a-z0-9-]+\.rep\.googleapis\.com$/.test(host);
}

let installed: Dispatcher | null = null;

/**
 * From now on a request of this process to a host that `isLong` accepts may be silent for `limitMs` before the
 * runtime gives up on it. Called before every model call: when the dispatcher in place is already ours it does
 * nothing; when something replaced it, ours goes on top again.
 */
export function allowLongCalls(limitMs: number, isLong: (origin: string) => boolean = isModelHost): void {
  const current = getGlobalDispatcher();
  if (installed && current === installed) return;
  installed = current.compose((dispatch) => (opts, handler) =>
    dispatch(isLong(String(opts.origin ?? "")) ? { ...opts, headersTimeout: limitMs, bodyTimeout: limitMs } : opts, handler),
  );
  setGlobalDispatcher(installed);
}

/** TESTS ONLY: put a dispatcher back (the one in place before allowLongCalls) and forget ours. */
export function restoreDispatcher(previous: Dispatcher): void {
  installed = null;
  setGlobalDispatcher(previous);
}

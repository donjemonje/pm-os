/**
 * The internal alert of a search for a company's other addresses that ended "undecided" (Daniel 2026-11-22): the
 * customer is told nothing — there is nothing they can do — and PM-OS gets ONE email instead.
 *
 * Pure: when to alert, the key that stops repeats, and the text of the email. The sending is address-alert-send.ts.
 *
 *   - an alert goes out when a search ends "undecided" — candidates were found and PMOS AI did not judge them, or the
 *     search failed before it could;
 *   - never when PMOS AI was switched off by the test knob (COMPETITORS_AI=off): that is not a production state;
 *   - once per company per undecided result: the next search of the same company that ends undecided with the SAME
 *     candidates sends nothing; different candidates, or a "done" in between, send again. What was alerted is kept
 *     on the stored result (Competitor.addressSearch.alertedKey); a "done" result carries none.
 */

/** The key of an undecided result: its candidate addresses, whatever their order or letter case. "none" when it has no candidate (the search failed before it found any). */
export function undecidedAlertKey(candidateUrls: readonly string[]): string {
  const urls = [...new Set(candidateUrls.map((u) => u.trim().toLowerCase().replace(/\/+$/, "")).filter(Boolean))].sort();
  return urls.length ? urls.join("\n") : "none";
}

/**
 * Does this result send an alert?
 *   status          how the search ended
 *   aiOffByKnob     PMOS AI was not asked because the test knob switched it off
 *   key             undecidedAlertKey of this result's candidates
 *   earlierKey      what the company's stored result says was alerted (null: nothing, or a "done" came in between)
 */
export function shouldAlertUndecided(o: { status: string; aiOffByKnob: boolean; key: string; earlierKey: string | null }): boolean {
  if (o.status !== "undecided" || o.aiOffByKnob) return false;
  return o.key !== o.earlierKey;
}

/**
 * What the stored result carries as "alerted" after this search: the key when an alert was sent now or the same one
 * was sent before; nothing after a "done", and nothing while the test knob keeps PMOS AI off (so the first real
 * undecided result still alerts).
 */
export function alertedKeyAfter(o: { status: string; aiOffByKnob: boolean; key: string; earlierKey: string | null; sent: boolean }): string | null {
  if (o.status !== "undecided" || o.aiOffByKnob) return null;
  if (o.sent || o.key === o.earlierKey) return o.key;
  // The alert could not be sent: nothing is recorded, so the next undecided result tries again.
  return null;
}

/** The email, for PM-OS (not for a customer): plain words, the technical reason included. */
export function undecidedAlertEmail(o: { organization: string; company: string; website: string; candidates: ReadonlyArray<{ url: string; via?: string | null }>; note: string }): { subject: string; heading: string; paragraphs: string[]; note: string } {
  const n = o.candidates.length;
  const heading = `Other addresses of ${o.company} were not judged`;
  return {
    subject: `[PM-OS] ${heading} (${o.organization})`,
    heading,
    paragraphs: [
      n > 0
        ? `The search for the help center, developer docs and release notes of ${o.company} (organization: ${o.organization}; website: ${o.website}) found ${n} candidate address${n === 1 ? "" : "es"}, and PMOS AI did not say what ${n === 1 ? "it is" : "they are"}.`
        : `The search for the help center, developer docs and release notes of ${o.company} (organization: ${o.organization}; website: ${o.website}) ended without a result.`,
      "Nothing was added to the company's addresses.",
      `Why: ${o.note.trim() || "no reason was recorded"}`,
      ...(n > 0 ? [`Candidates: ${o.candidates.map((c) => (c.via ? `${c.url} (found by ${c.via})` : c.url)).join(" · ")}`] : []),
    ],
    note: "The customer sees no message about this. The search runs again after the next scan of the company's website. One email per company and set of candidates; a new email when the candidates change or after a search that ended well.",
  };
}

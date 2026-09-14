/**
 * Two-tone vote bar: existing votes in the accent, votes gained this import
 * in green. `max` is the largest total in the list it sits in, so bars are
 * comparable across rows (never a made-up scale).
 */
export function VoteBar({
  existing,
  added,
  max,
  width = 72,
  height = 4,
}: {
  existing: number;
  added: number;
  max: number;
  width?: number;
  height?: number;
}) {
  const scale = max > 0 ? 100 / max : 0;
  const ex = Math.min(100, existing * scale);
  const nw = Math.min(100 - ex, added * scale);
  return (
    <span
      aria-hidden
      className="inline-flex overflow-hidden rounded-full bg-[rgba(12,25,41,.08)]"
      style={{ width, height }}
    >
      <span className="h-full bg-primary" style={{ width: `${ex}%` }} />
      <span className="h-full bg-success" style={{ width: `${nw}%` }} />
    </span>
  );
}

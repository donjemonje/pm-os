/**
 * Progress ring with the percentage in the middle — the KPI panel's review
 * progress. Track is a faint ink; the arc glows softly in its color.
 */
export function Ring({
  value,
  size = 64,
  stroke = 6,
  color = "var(--app-accent)",
  label = true,
}: {
  /** 0–100 */
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  label?: boolean;
}) {
  const v = Math.max(0, Math.min(100, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${v}%`}
    >
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(12,25,41,.08)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`}
          style={{ filter: `drop-shadow(0 0 4px color-mix(in srgb, ${color} 55%, transparent))`, transition: "stroke-dasharray .4s ease" }}
        />
      </svg>
      {label && (
        <span className="font-title font-bold text-foreground" style={{ fontSize: size * 0.3 }}>
          {v}%
        </span>
      )}
    </span>
  );
}

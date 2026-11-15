import type { SVGProps } from "react";

/**
 * Menu icon for Competitors (the C2 design's mark): a quadrant with players
 * scattered across it and the target ringed top-right. Same props as a
 * lucide icon, so it sits in the sidebar's nav list beside them.
 */
export function CompetitorsIcon({
  size = 24,
  strokeWidth = 2,
  ...rest
}: SVGProps<SVGSVGElement> & { size?: number | string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d="M1.88 12h20.25M12 1.88v20.25" />
      <g fill="currentColor" stroke="none">
        <circle cx="15.75" cy="5.25" r="1.6" />
        <circle cx="20.25" cy="8.25" r="1.6" />
        <circle cx="7.5" cy="7.5" r="1.6" />
        <circle cx="7.5" cy="17.25" r="1.6" />
        <circle cx="3.75" cy="21" r="1.6" />
        <circle cx="17.25" cy="17.25" r="1.6" />
        <circle cx="20.25" cy="3.75" r="1.1" />
      </g>
      <circle cx="20.25" cy="3.75" r="2.6" strokeWidth={1} />
    </svg>
  );
}

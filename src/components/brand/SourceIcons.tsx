import type { SVGProps } from "react";

/**
 * The Zendesk and Jira marks as single-color glyphs, cropped to the mark
 * itself (no wordmark, no tile) so they sit in text like a Lucide icon and
 * take the surrounding color — the accent on the Merge board.
 */
type MarkProps = { size?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height">;

export function ZendeskMark({ size = 13, ...rest }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 2.9 24 18.2"
      fill="currentColor"
      aria-hidden
      {...rest}
    >
      <path d="M12.914 2.904v13.454L24 2.904H12.914zM0 21.096h11.086V7.642L0 21.096zm11.086-13.454A5.543 5.543 0 0 1 0 7.642h11.086zM12.914 21.096a5.543 5.543 0 0 1 11.086 0H12.914z" />
    </svg>
  );
}

export function JiraMark({ size = 13, ...rest }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden {...rest}>
      <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.005 1.005 0 0 0 23.013 0z" />
    </svg>
  );
}

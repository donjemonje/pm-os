"use client";

import { useEffect } from "react";
import { ExternalLink, X } from "lucide-react";

/**
 * In-page image viewer: a dimmed backdrop with the image at up to 90 % of the
 * viewport, a close button, Esc and a backdrop click to leave. Used wherever
 * PM-OS shows a picture that can be enlarged (competitor UI captures, …).
 */
export function Lightbox({ src, alt, caption, href, closeLabel, linkLabel, onClose }: {
  src: string;
  alt: string;
  caption?: string | null;
  /** The original file or page, offered as a link under the image. */
  href?: string | null;
  closeLabel: string;
  linkLabel?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div role="dialog" aria-modal="true" aria-label={alt} onClick={onClose} className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(12,25,41,.72)] p-6 backdrop-blur-[4px]" data-testid="lightbox">
      <button type="button" onClick={onClose} aria-label={closeLabel} className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-[#1f2f47] shadow hover:bg-white" data-testid="lightbox-close">
        <X size={18} />
      </button>
      <figure className="m-0 flex max-h-full max-w-full flex-col items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} className="max-h-[85vh] max-w-[90vw] rounded-inner bg-white object-contain shadow-[0_24px_60px_-20px_rgba(0,0,0,.6)]" />
        {(caption || href) && (
          <figcaption className="flex max-w-[90vw] items-center gap-3 text-[12.5px] text-white/85">
            {caption && <span className="truncate">{caption}</span>}
            {href && linkLabel && (
              <a href={href} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-white hover:underline">{linkLabel}<ExternalLink size={12} /></a>
            )}
          </figcaption>
        )}
      </figure>
    </div>
  );
}

"use client";

/**
 * A card of the Competitors table that floats above everything (Daniel 2026-11-22). It is drawn at the end of the
 * page (a portal to document.body), not inside the table, so neither the table's scrolling box nor the page cuts it.
 * Where it goes is one rule (table-view.ts placeCard): under the element it was opened from when the whole card fits
 * there, else above it when it fits there, else on the side with more room with its height capped to that room and
 * its own scrolling inside. "Bottom" is the bottom of the visible window. The card's real height is measured after it
 * is drawn and again whenever it grows, and it follows scrolling and resizing.
 *
 * `lock` — for a card opened by a CLICK: while it is open, scrolling is caught, so the page and the table do not
 * move under it (wheel and touch). Scrolling inside the card still works, and stops at the card's end instead of
 * passing on to the page. Closing the card gives scrolling back. A hover card is never locked: it closes when the
 * pointer leaves.
 */
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { boxCanScroll, placeCard, type CardPlacement } from "@/lib/competitors/table-view";
import { cn } from "@/lib/utils";

export function Floating({ align = "left", lock = false, className, children, ...rest }: { align?: "left" | "center"; lock?: boolean } & HTMLAttributes<HTMLDivElement>) {
  const anchor = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CardPlacement | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const host = anchor.current?.parentElement;
      const el = card.current;
      if (!host || !el) return;
      const r = host.getBoundingClientRect();
      // The card's real height, whatever cap it has now: its whole content plus its borders.
      const height = el.scrollHeight + (el.offsetHeight - el.clientHeight);
      const next = placeCard({ top: r.top, bottom: r.bottom, left: r.left, width: r.width }, { width: el.offsetWidth, height }, { width: window.innerWidth, height: window.innerHeight }, align);
      setPos((p) => (p && p.top === next.top && p.left === next.left && p.maxHeight === next.maxHeight ? p : next));
    };
    place();
    // Placed again whenever the card changes size or content ("Show more", an editor opening), and on scroll and resize.
    const grown = new ResizeObserver(place);
    const changed = new MutationObserver(place);
    if (card.current) {
      grown.observe(card.current);
      changed.observe(card.current, { childList: true, subtree: true, characterData: true });
    }
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { grown.disconnect(); changed.disconnect(); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [align]);
  useEffect(() => {
    if (!lock) return;
    // A scrolling box of the card, from where the pointer is up to the card itself, that can still move this way.
    const cardScrolls = (target: EventTarget | null, deltaY: number): boolean => {
      const el = card.current;
      if (!el || !(target instanceof Element) || !el.contains(target)) return false;
      for (let box: Element | null = target; box; box = box === el ? null : box.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(box).overflowY) && boxCanScroll(box, deltaY)) return true;
      }
      return false;
    };
    const onWheel = (e: WheelEvent) => { if (!cardScrolls(e.target, e.deltaY)) e.preventDefault(); };
    let lastY = 0;
    const onTouchStart = (e: TouchEvent) => { lastY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? lastY;
      const deltaY = lastY - y;
      lastY = y;
      if (!cardScrolls(e.target, deltaY)) e.preventDefault();
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    return () => {
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("touchstart", onTouchStart, { capture: true });
      window.removeEventListener("touchmove", onTouchMove, { capture: true });
    };
  }, [lock]);
  return (
    <>
      <span ref={anchor} hidden />
      {createPortal(
        <div ref={card} {...rest} className={cn("fixed z-[60] overflow-y-auto overscroll-contain", className)} data-side={pos?.side} style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, maxHeight: pos ? pos.maxHeight : undefined, visibility: pos ? "visible" : "hidden" }}>{children}</div>,
        document.body,
      )}
    </>
  );
}

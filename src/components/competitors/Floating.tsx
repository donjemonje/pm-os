"use client";

/**
 * A card of the Competitors table that floats above everything (Daniel 2026-11-22). It is drawn at the end of the
 * page (a portal to document.body), not inside the table, so neither the table's scrolling box nor the page cuts it.
 * It sits under the element it was opened from — left-aligned or centred — moves above it when there is no room
 * below, stays inside the window, and follows scrolling and resizing. A card taller than the window scrolls inside.
 *
 * `lock` — for a card opened by a CLICK: while it is open, scrolling is caught, so the page and the table do not
 * move under it (wheel and touch). Scrolling inside the card still works, and stops at the card's end instead of
 * passing on to the page. Closing the card gives scrolling back. A hover card is never locked: it closes when the
 * pointer leaves.
 */
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { boxCanScroll } from "@/lib/competitors/table-view";
import { cn } from "@/lib/utils";

export function Floating({ align = "left", lock = false, className, children, ...rest }: { align?: "left" | "center"; lock?: boolean } & HTMLAttributes<HTMLDivElement>) {
  const anchor = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const host = anchor.current?.parentElement;
      const el = card.current;
      if (!host || !el) return;
      const r = host.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = Math.max(8, Math.min(align === "center" ? r.left + r.width / 2 - w / 2 : r.left, window.innerWidth - w - 8));
      const below = r.bottom + 6;
      // Under the anchor; above it when there is no room below and there is room above; never off the top or the bottom of the window.
      const wanted = below + h > window.innerHeight - 8 && r.top - 6 - h >= 8 ? r.top - 6 - h : below;
      const top = Math.max(8, Math.min(wanted, window.innerHeight - h - 8));
      setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }));
    };
    place();
    const grown = new ResizeObserver(place);
    if (card.current) grown.observe(card.current);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { grown.disconnect(); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
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
        <div ref={card} {...rest} className={cn("fixed z-[60] max-h-[calc(100vh-16px)] overflow-y-auto overscroll-contain", className)} style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}>{children}</div>,
        document.body,
      )}
    </>
  );
}

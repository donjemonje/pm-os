import Image from "next/image";
import { brand } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * The PM-OS brain mark at text size — the face of PMOS wherever the UI says
 * PMOS did something (read a ticket, classified it, drafted a document).
 * Product copy never says "AI"; it says PMOS, and this mark sits beside it.
 */
export function PmosMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <Image
      src={brand.logoStandalone}
      alt="PMOS"
      width={size}
      height={size}
      className={cn("inline-block shrink-0 select-none object-contain align-[-3px]", className)}
      style={{ width: size, height: size }}
    />
  );
}

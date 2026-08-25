import Link from "next/link";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { cn } from "@/lib/utils";

const BASE_HEIGHT = 38;

type BrandLockupProps = {
  height?: number;
  priority?: boolean;
  showSubtitle?: boolean;
  className?: string;
  href?: string;
};

export function BrandLockup({
  height = BASE_HEIGHT,
  priority,
  showSubtitle = true,
  className,
  href,
}: BrandLockupProps) {
  const scale = height / BASE_HEIGHT;
  const gap = 11.4 * scale;
  const titleSize = 15.2 * scale;
  const subtitleSize = 9.5 * scale;
  const dividerHeight = height * 0.8;

  const content = (
    <div className={cn("flex items-center", className)} style={{ gap }}>
      <div className="flex shrink-0 items-center">
        <BrandLogo height={height} priority={priority} variant="withWordmark" />
        <div
          className="bg-[#d9d9d9]"
          style={{ marginLeft: gap, width: 1, height: dividerHeight }}
          aria-hidden
        />
      </div>
      <div className="min-w-0">
        <div
          className="font-brand font-bold tracking-tight"
          style={{ fontSize: titleSize }}
        >
          <span className="text-[#f3f1fb]">PM</span>
          <span className="text-[#1488c8]">-OS</span>
        </div>
        {showSubtitle && (
          <div
            className="font-body leading-tight text-brand-text"
            style={{ fontSize: subtitleSize }}
          >
            Product Management
            <br />
            Operating System
          </div>
        )}
      </div>
    </div>
  );

  if (href) {
    return <Link href={href}>{content}</Link>;
  }

  return content;
}

import Image from "next/image";
import { brand } from "@/lib/brand";
import { cn } from "@/lib/utils";

type BrandLogoVariant = "standalone" | "withWordmark";

type BrandLogoProps = {
  className?: string;
  height?: number;
  priority?: boolean;
  /** Use `withWordmark` when PM-OS text is rendered beside the logo */
  variant?: BrandLogoVariant;
};

export function BrandLogo({
  className,
  height = 48,
  priority,
  variant = "standalone",
}: BrandLogoProps) {
  const width = Math.round(height * 2.5);
  const src =
    variant === "withWordmark" ? brand.logoWithWordmark : brand.logoStandalone;

  return (
    <Image
      src={src}
      alt="PM-OS"
      width={width}
      height={height}
      className={cn("object-contain", className)}
      style={{ width: "auto", height, maxWidth: width }}
      priority={priority}
    />
  );
}

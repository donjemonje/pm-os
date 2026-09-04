import { neuralBackgrounds } from "@/lib/neural-backgrounds";

export function AuthNeuralBackground({
  children,
  /** Card width — "md" (default, 28rem) or "lg" (32rem) for two-column forms. */
  width = "md",
}: {
  children: React.ReactNode;
  width?: "md" | "lg";
}) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div
        className="pointer-events-none fixed inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: `url('${neuralBackgrounds.framed}')` }}
        aria-hidden
      />
      <div
        className="pointer-events-none fixed inset-0 bg-gradient-to-b from-[#050A15]/30 via-transparent to-[#050A15]/50"
        aria-hidden
      />
      <div className={`relative z-10 w-full ${width === "lg" ? "max-w-lg" : "max-w-md"}`}>
        {children}
      </div>
    </div>
  );
}

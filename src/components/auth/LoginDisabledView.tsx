import { AuthNeuralBackground } from "@/components/auth/AuthNeuralBackground";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { brand } from "@/lib/brand";
import { LOGIN_DISABLED_MESSAGE } from "@/lib/feature-flags";

export function LoginDisabledView() {
  return (
    <AuthNeuralBackground>
      <div
        className="rounded-2xl border border-white/10 bg-[#050A15]/85 p-8 text-center shadow-2xl backdrop-blur-xl"
        style={{ boxShadow: `0 25px 50px -12px ${brand.accentFaint}` }}
      >
        <BrandLogo height={56} className="mx-auto mb-4" priority />
        <h1 className="font-title text-xl font-bold text-brand-text">{LOGIN_DISABLED_MESSAGE}</h1>
        <p className="font-subtitle mt-2 text-sm text-brand-muted">
          Sign-in and registration are temporarily unavailable. Please try again later.
        </p>
      </div>
    </AuthNeuralBackground>
  );
}

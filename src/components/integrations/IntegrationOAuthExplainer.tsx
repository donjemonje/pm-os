import { Shield } from "lucide-react";

type IntegrationOAuthExplainerProps = {
  provider: "Jira" | "Google Drive";
  connected?: boolean;
};

const STEPS = [
  { title: "Click Connect", body: "PMOS opens the official sign-in page for your account." },
  { title: "Review & allow", body: "You approve what PMOS can access — only your workspace data." },
  { title: "You're connected", body: "Imports work until you disconnect from your account settings." },
];

export function IntegrationOAuthExplainer({
  provider,
  connected,
}: IntegrationOAuthExplainerProps) {
  if (connected) return null;

  return (
    <div className="mb-6 rounded-xl border border-border bg-background p-5 text-left">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
        <Shield size={16} className="text-primary" />
        How {provider} integration works
      </div>
      <ol className="space-y-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-3 text-sm">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
              {i + 1}
            </span>
            <div>
              <div className="font-medium text-foreground">{step.title}</div>
              <div className="text-muted">{step.body}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function IntegrationUnavailable({
  provider,
  adminHint,
}: {
  provider: string;
  adminHint?: string;
}) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center text-sm text-amber-900">
      <p className="font-medium">{provider} isn&apos;t available yet</p>
      <p className="mt-2 text-amber-800">
        {adminHint ?? "Ask your PMOS administrator to enable this integration."}
      </p>
    </div>
  );
}

export function IntegrateButton({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white transition hover:bg-primary-hover"
    >
      {label}
    </a>
  );
}

import { Brain } from "lucide-react";
import { JiraMark, ZendeskMark } from "@/components/brand/SourceIcons";

/** "12 tickets · 3 Jira issues · 5 ideas" as three small icon counts. */
export function UsageCounts({ zen, jira, ideas }: { zen: number; jira: number; ideas: number }) {
  const cell = (icon: React.ReactNode, n: number, title: string) => (
    <span title={title} className={`inline-flex items-center gap-1 ${n === 0 ? "opacity-40" : ""}`}>
      <span className="inline-flex text-primary">{icon}</span>
      {n}
    </span>
  );
  return (
    <span className="inline-flex shrink-0 items-center gap-3 font-mono text-[11px] text-[#7a8496]">
      {cell(<ZendeskMark size={11} />, zen, `${zen} Zendesk ticket${zen === 1 ? "" : "s"}`)}
      {cell(<JiraMark size={11} />, jira, `${jira} Jira issue${jira === 1 ? "" : "s"}`)}
      {cell(<Brain size={12} strokeWidth={2.25} fill="currentColor" fillOpacity={0.3} />, ideas, `${ideas} PM-OS idea${ideas === 1 ? "" : "s"}`)}
    </span>
  );
}

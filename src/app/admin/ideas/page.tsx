import { requireAdminPage } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { CATALOG_PROMPT_VERSION, CATALOG_SYSTEM_PROMPT } from "@/lib/ideas/catalog";
import { MATCH_PROMPT_VERSION, MATCH_SYSTEM_PROMPT } from "@/lib/ideas/match";
import { PARSE_PROMPT_VERSION, PARSE_SYSTEM_PROMPT } from "@/lib/ideas/field-parse";
import { SPLIT_PROMPT_VERSION, SPLIT_SYSTEM_PROMPT } from "@/lib/ideas/split";
import { mergeIdeasJiraConfig } from "@/lib/ideas/jira-mapping";
import { AdminShell } from "../AdminShell";
import { IdeasOutputConfig } from "./IdeasOutputConfig";

export default async function AdminIdeasPage() {
  const admin = await requireAdminPage("/admin/ideas");

  const organizations = await db.organization.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      workspace: {
        select: {
          id: true,
          ideasConfig: true,
          jiraConnection: { select: { ideasIssueType: true } },
        },
      },
    },
  });

  return (
    <AdminShell
      user={admin}
      title="Ideas"
      description="How review results land in each customer's Jira: field mapping, write policies, description format. Changes apply to the next merge."
    >
      <IdeasOutputConfig
        prompts={[
          {
            id: "parse",
            title: `Customer field parsing (${PARSE_PROMPT_VERSION}, Gemini)`,
            note: "One call per import over the unique raw customer-field values: clean names out of lists and qualifiers, plus the all-customers flag. Gated per org by Field parsing (AI); runs on the Gemini model (IDEAS_PARSE_MODEL / GEMINI_MODEL env).",
            text: PARSE_SYSTEM_PROMPT,
          },
          {
            id: "catalog",
            title: `Classification & idea generation (${CATALOG_PROMPT_VERSION})`,
            note: "Runs once per imported ticket: FR/bug/needs-details, product line, platforms, customers, and the product-voiced title/summary. The org's catalogs (Settings → Ideas) and the ticket's mapped fields (module hint, reporter's why-build/insights) are appended per ticket.",
            text: CATALOG_SYSTEM_PROMPT,
          },
          {
            id: "split",
            title: `Ticket breakdown (${SPLIT_PROMPT_VERSION})`,
            note: "Runs only for tickets classification flags as holding more than one distinct user problem (request_count > 1) — each problem becomes its own idea, capped at 4, with an escape hatch back to a single idea. Sub-ideas then run through matching independently.",
            text: SPLIT_SYSTEM_PROMPT,
          },
          {
            id: "match",
            title: `Jira backlog matching (${MATCH_PROMPT_VERSION})`,
            note: "Runs per feature request: does it duplicate an idea already in the ideas list (Jira-born, an earlier import, or an earlier ticket of this import)? Unmatched requests join the candidate list, so similar tickets in one import consolidate. Jira disconnected just means fewer candidates.",
            text: MATCH_SYSTEM_PROMPT,
          },
        ]}
        organizations={organizations
          .filter((org) => org.workspace)
          .map((org) => ({
            id: org.id,
            name: org.name,
            slug: org.slug,
            config: mergeIdeasJiraConfig(org.workspace?.ideasConfig),
            // null = no Jira connection yet; the issue-type control is hidden.
            ideasIssueType: org.workspace?.jiraConnection?.ideasIssueType ?? null,
          }))}
      />
    </AdminShell>
  );
}

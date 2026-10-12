import { requireAdminPage } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import {
  CATALOG_PROMPT_VERSION,
  CATALOG_SYSTEM_PROMPT,
} from "@/lib/ideas/catalog";
import {
  MATCH_GROUP_SYSTEM_PROMPT,
  MATCH_PROMPT_VERSION,
  MATCH_SYSTEM_PROMPT,
} from "@/lib/ideas/match";
import {
  PARSE_PROMPT_VERSION,
  PARSE_SYSTEM_PROMPT,
} from "@/lib/ideas/field-parse";
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
            note: "Runs only for tickets classification flags as holding more than one separately shippable capability (request_count > 1) — each capability becomes its own idea, capped at 6, with an escape hatch back to a single idea. Sub-ideas then run through matching independently.",
            text: SPLIT_SYSTEM_PROMPT,
          },
          {
            id: "match-group",
            title: `Merge group reconciliation (${MATCH_PROMPT_VERSION})`,
            note: "Phase 2, one call per group of two or more requests judged to be one idea (parallel): confirm or split the grouping and write the merged idea from the template — with the existing idea's text when the group merges into one.",
            text: MATCH_GROUP_SYSTEM_PROMPT,
          },
          {
            id: "match",
            title: `Jira backlog matching (${MATCH_PROMPT_VERSION})`,
            note: "Phase 1, all at once: every feature request is matched against existing ideas, unrepresented Jira issues, and every other request of the same import. The answers are folded into groups deterministically; groups of two or more then get the reconciliation prompt below.",
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
            ideasIssueType:
              org.workspace?.jiraConnection?.ideasIssueType ?? null,
          }))}
      />
    </AdminShell>
  );
}

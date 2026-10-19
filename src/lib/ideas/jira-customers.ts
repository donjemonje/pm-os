import { GoogleGenAI, Type } from "@google/genai";
import { getGeminiLocation, getVertexProjectId } from "../vertex-config";
import { buildCustomerResolver, customerKey, isAllCustomers } from "./customer-key";
import { type CatalogCustomer, JIRA_CUSTOMERS_PROMPT_VERSION } from "./customer-mentions";
import { ledgerKey, recordVerdict } from "./ledger";
import { geminiUsage, type StageHooks } from "./trace";

/**
 * Tier 2 of customer-mentions.ts: the AI pass over Jira issue text (Gemini,
 * same client and ledger pattern as field-parse.ts).
 */

function getModel(): string {
  return (
    process.env.IDEAS_PARSE_MODEL?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    "gemini-2.5-flash"
  );
}

export const JIRA_CUSTOMERS_SYSTEM_PROMPT = `You read product backlog issues (Jira) for a product team and list the customers each issue names.

A customer is a company or organization the issue says asked for, is affected by, or is the reason for the work — "requested by Acme", "Acme and Globex need…", "for the Acme deployment". For each issue return the customer names exactly as written in the issue (keep casing and punctuation). Rules:
- Only names the issue text itself contains. Never infer, expand or invent a name; an empty list is the correct answer when no customer is named — most issues name none.
- Not customers: the product's own name or modules, competitors mentioned for comparison, technology vendors or tools (AWS, Jira, Slack), people's names, generic words ("the customer", "clients", "a bank").
- When the issue says the work is for everyone ("all customers", "all clients"), return the single name "All Customers".
- Company names can look odd ("84Shield", "RiverMark Inc.") — oddness alone never disqualifies a name. A name from the customer catalog counts whenever the issue clearly refers to that company, in any spelling.

Return one result per input issue, in the same order, with key echoed exactly.`;

let client: GoogleGenAI | null = null;
let clientKey = "";
function getClient(): GoogleGenAI {
  const project = getVertexProjectId();
  const location = getGeminiLocation();
  const key = `${project}|${location}`;
  if (!client || clientKey !== key) {
    client = new GoogleGenAI({ vertexai: true, project, location });
    clientKey = key;
  }
  return client;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          key: { type: Type.STRING },
          customers: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["key", "customers"],
      },
    },
  },
  required: ["results"],
};

export interface IssueText {
  key: string;
  title: string;
  body: string;
}

/** Issues per model call — bodies are clipped, so this stays well inside the window. */
const BATCH = 25;
const BODY_CLIP = 2000;

/**
 * Tier 2: names the model reads in each issue. Catalog spellings are
 * canonicalized through the customer key (aliases included); everything
 * else comes back as written. One ledger row per call, like every stage.
 */
export async function extractJiraCustomers(
  workspaceId: string,
  issues: IssueText[],
  catalog: CatalogCustomer[],
  hooks?: StageHooks,
): Promise<{ byKey: Map<string, string[]>; model: string; calls: number }> {
  const model = getModel();
  const byKey = new Map<string, string[]>();
  if (issues.length === 0) return { byKey, model, calls: 0 };
  const resolve = buildCustomerResolver(catalog);
  const catalogList = catalog
    .filter((c) => !isAllCustomers(c.name))
    .map((c) => (c.aliases?.length ? `${c.name} (also: ${c.aliases.join(", ")})` : c.name));
  let calls = 0;
  for (let i = 0; i < issues.length; i += BATCH) {
    const chunk = issues.slice(i, i + BATCH);
    const userMessage =
      `CUSTOMER CATALOG (known customers; match these in any spelling):\n` +
      (catalogList.length ? catalogList.map((c) => `- ${c}`).join("\n") : "(empty)") +
      `\n\nISSUES:\n` +
      chunk
        .map(
          (it) =>
            `[${it.key}]\nSummary: ${it.title}\nDescription: ${it.body.slice(0, BODY_CLIP) || "(none)"}`,
        )
        .join("\n\n");
    const aiStart = performance.now();
    const response = await getClient().models.generateContent({
      model,
      contents: userMessage,
      config: {
        systemInstruction: JIRA_CUSTOMERS_SYSTEM_PROMPT,
        temperature: 0,
        thinkingConfig: { thinkingBudget: 2048 },
        maxOutputTokens: 16000,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    const aiMs = performance.now() - aiStart;
    calls++;
    let parsed: { results?: unknown };
    try {
      parsed = JSON.parse(response.text ?? "");
    } catch {
      const finish = response.candidates?.[0]?.finishReason ?? "unknown";
      throw new Error(`Jira customer extraction returned invalid JSON (finish: ${finish})`);
    }
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    const ledgerInput = { system: JIRA_CUSTOMERS_SYSTEM_PROMPT, user: userMessage };
    const dbStart = performance.now();
    await recordVerdict(
      workspaceId,
      ledgerKey("jira-customers", JIRA_CUSTOMERS_PROMPT_VERSION, model, ledgerInput),
      {
        stage: "jira-customers",
        promptVersion: JIRA_CUSTOMERS_PROMPT_VERSION,
        model,
        input: ledgerInput,
        verdict: { results },
      },
    );
    hooks?.call({ aiMs, dbMs: performance.now() - dbStart, tokens: geminiUsage(response.usageMetadata) });
    for (const r of results) {
      const row = (r ?? {}) as Record<string, unknown>;
      if (typeof row.key !== "string") continue;
      const names = Array.isArray(row.customers)
        ? row.customers.filter((n): n is string => typeof n === "string" && !!n.trim())
        : [];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const n of names) {
        const canonical = resolve(n.trim());
        const k = customerKey(canonical);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(canonical);
      }
      byKey.set(row.key, out);
    }
  }
  return { byKey, model, calls };
}

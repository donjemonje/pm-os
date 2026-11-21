/**
 * Which model makes which call of the capability analysis (Daniel 2026-11-15: a model per step, the Gemini 4 line-up;
 * 2026-11-16: the defaults after the reading was rebuilt and tested by hand).
 *
 * Three roles, with their defaults in code:
 *   read  — gemini-4-argon:  map, the reading (a company in chunks), second look, the pick of a company's
 *                            other addresses. Not gemini-4-hydrogen: it cannot go below "low" thinking and billed
 *                            ~57% of its output as thinking on the reading (measured 2026-11-15).
 *   match — gemini-4-argon:  match (a company's new items against the rows that exist).
 *   judge — gemini-4-carbon: unify (capabilities, the review, features) and domains. It thinks a lot — the hand
 *                            test of 2026-11-16 billed 14.7k of 17.7k output tokens as thinking — and every run
 *                            records it apart.
 * Each role has an environment override: COMPETITORS_MODEL_READ, COMPETITORS_MODEL_MATCH, COMPETITORS_MODEL_JUDGE.
 * The old single COMPETITORS_MODEL decides nothing any more: no code reads it.
 *
 * A `gemini-*` id runs on Gemini (Vertex, a response schema); anything else on the Anthropic provider (forced tool
 * use). The model of every call is recorded with its tokens (analysis/usage.ts). How much a role THINKS is a
 * setting per role too (THINKING_DEFAULTS below).
 *
 * Pure: no database, no network — the environment is a parameter.
 */

export const MODEL_ROLES = ["read", "match", "judge"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export const MODEL_DEFAULTS: Record<ModelRole, string> = {
  read: "gemini-4-argon",
  match: "gemini-4-argon",
  judge: "gemini-4-carbon",
};

export const MODEL_ENV: Record<ModelRole, string> = {
  read: "COMPETITORS_MODEL_READ",
  match: "COMPETITORS_MODEL_MATCH",
  judge: "COMPETITORS_MODEL_JUDGE",
};

/** The prompts of the feature, in run order, and the role that makes each. Data: moving a prompt to another role is an edit of this table. */
export const PROMPT_ROLES = {
  map: "read",
  reading: "read",
  unify: "judge",
  unify_review: "judge",
  unify_features: "judge",
  domains: "judge",
  match: "match",
  second_look: "read",
  // Not a step of an analysis run: the search for a company's other addresses (addresses.ts) asks what each candidate is.
  addresses: "read",
} as const satisfies Record<string, ModelRole>;
export type PromptId = keyof typeof PROMPT_ROLES;

type Env = Record<string, string | undefined>;

/** The model of a role: its environment override when one is set (not blank), else the default in code. */
export function modelFor(role: ModelRole, env: Env = process.env): string {
  return env[MODEL_ENV[role]]?.trim() || MODEL_DEFAULTS[role];
}

export function competitorsModels(env: Env = process.env): Record<ModelRole, string> {
  return { read: modelFor("read", env), match: modelFor("match", env), judge: modelFor("judge", env) };
}

/** The model that makes a prompt. */
export function modelOfPrompt(prompt: PromptId, env: Env = process.env): string {
  return modelFor(PROMPT_ROLES[prompt], env);
}

/** "read gemini-4-argon · match gemini-4-argon · judge gemini-4-carbon" — what a run row and a log line say. */
export function modelsLine(models: Record<ModelRole, string>): string {
  return MODEL_ROLES.map((r) => `${r} ${models[r]}`).join(" · ");
}

// ————— How much a role thinks —————

/**
 * The thinking level of a role. A model's own thinking is billed as output, so how much a call thinks is a setting
 * per role, like its model, with the defaults in code (Daniel 2026-11-16: "start with medium, see results, maybe
 * high" — never "low" for the steps that build the table):
 *   read  — medium: map, the reading, second look, other addresses.
 *   match — high:   match — deciding which row of ours a company's item is.
 *   judge — medium: unify and domains — the calls that shape the catalog.
 * Each role has an environment override — COMPETITORS_THINKING_READ, _MATCH, _JUDGE. A value that is not a level
 * is ignored.
 *
 * The old COMPETITORS_THINKING — one value for every role — is NOT honoured any more: dev set it to "low", and it
 * silently forced low on the reading, unify and domains. A value still set there decides nothing; the run's log
 * and Administration → Competitors say so (retiredThinkingOverride).
 */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export const THINKING_DEFAULTS: Record<ModelRole, ThinkingLevelName> = {
  read: "medium",
  match: "high",
  judge: "medium",
};

export const THINKING_ENV: Record<ModelRole, string> = {
  read: "COMPETITORS_THINKING_READ",
  match: "COMPETITORS_THINKING_MATCH",
  judge: "COMPETITORS_THINKING_JUDGE",
};
/** RETIRED: the one setting that used to override the level of every role. It is read only to say that it decides nothing. */
export const THINKING_ENV_ALL = "COMPETITORS_THINKING";

function levelOf(v: string | undefined): ThinkingLevelName | null {
  const t = v?.trim().toLowerCase();
  return t && (THINKING_LEVELS as readonly string[]).includes(t) ? (t as ThinkingLevelName) : null;
}

/** The thinking level of a role: the role's own override when it is a level, else the default in code. COMPETITORS_THINKING is never read for it. */
export function thinkingFor(role: ModelRole, env: Env = process.env): ThinkingLevelName {
  return levelOf(env[THINKING_ENV[role]]) ?? THINKING_DEFAULTS[role];
}

/** The value of the retired COMPETITORS_THINKING when the environment still sets one — so a run and the admin screen can say it is ignored; null when it is not set. */
export function retiredThinkingOverride(env: Env = process.env): string | null {
  return env[THINKING_ENV_ALL]?.trim() || null;
}

export function competitorsThinking(env: Env = process.env): Record<ModelRole, ThinkingLevelName> {
  return { read: thinkingFor("read", env), match: thinkingFor("match", env), judge: thinkingFor("judge", env) };
}

/** "read medium · match high · judge medium" — what a run's log says next to its models. */
export function thinkingLine(levels: Record<ModelRole, ThinkingLevelName>): string {
  return MODEL_ROLES.map((r) => `${r} ${levels[r]}`).join(" · ");
}

export type ModelProvider = "gemini" | "claude";
export function providerOf(model: string): ModelProvider {
  return /^gemini/i.test(model) ? "gemini" : "claude";
}

/**
 * Did the provider refuse the model id itself — an id Vertex does not know, does not serve in this region, or this
 * project may not use? HTTP 404; or 400 / 403 with a message about the model; or a message that says so.
 */
export function modelRefused(e: { status?: unknown; message?: unknown }): boolean {
  const status = typeof e.status === "number" ? e.status : null;
  const message = typeof e.message === "string" ? e.message : "";
  if (status === 404) return true;
  const aboutModel = /\bmodels?\b|publisher/i.test(message);
  if ((status === 400 || status === 403) && aboutModel) return true;
  return aboutModel && /NOT_FOUND|not found|does not exist|is not supported|not available|unknown model|invalid model|no access|permission denied/i.test(message);
}

/**
 * What a run says when a model call failed for a reason it cannot wait out. Always names the step and the model;
 * when the model id itself was refused it says so first, with the setting that chooses it. The provider's own words
 * follow, cut — the run stores 300 characters, and the step and the model must be among them.
 */
export function callFailureMessage(e: { status?: unknown; message?: unknown }, at: { step: string; role: ModelRole; model: string }): string {
  const said = (typeof e.message === "string" ? e.message : String(e.message ?? "")).replace(/\s+/g, " ").trim();
  const step = at.step.replace(/_/g, " ");
  const head = modelRefused(e)
    ? `The model "${at.model}" was refused by Vertex in the ${step} step (role ${at.role}: set ${MODEL_ENV[at.role]} to a model this project can use)`
    : `PMOS AI call failed in the ${step} step (model ${at.model}, role ${at.role})`;
  return `${head}${said ? ` — ${said}` : ""}`.slice(0, 300);
}

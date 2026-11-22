import { REVIEW_FIX_PROMPT, REVIEW_NOT_UNDERSTOOD_PROMPT, REVIEW_REPEATS_PROMPT } from "../knowledge-review-prompts";
import { NEWS_INTAKE_PROMPT } from "../news/intake";
import { TABLE_NEW_INTAKE_PROMPT } from "../news/table-prompt-new-intake";
import { REEVALUATE_SYSTEM_PROMPT } from "../reevaluate-prompt";
import { BUILD_DOMAIN_PROMPT, READ_PAGES_PROMPT, SORT_FEATURES_PROMPT, type PromptDef } from "./blocks";

/**
 * A prompt that is kept as one text in its own file (not built from shared blocks yet) as a prompt of the registry:
 * its text is taken as it is, so it is printed, versioned and checked for copied block text like the others.
 */
export function plainPrompt(name: string, title: string, text: string): PromptDef {
  return { name, title, paragraphs: text.split("\n\n").map((paragraph) => paragraph.split("\n")) };
}

/** The review step of a company's feature list (knowledge-review-prompts.ts): repeats, missing parts, names not understood. */
export const REVIEW_REPEATS_DEF = plainPrompt("review-repeats", "Review of a feature list: the same feature listed more than once", REVIEW_REPEATS_PROMPT);
export const REVIEW_FIX_DEF = plainPrompt("review-fix", "Review of a feature list: features with a missing part", REVIEW_FIX_PROMPT);
export const REVIEW_NOT_UNDERSTOOD_DEF = plainPrompt("review-not-understood", "Review of a feature list: names the reading could not explain", REVIEW_NOT_UNDERSTOOD_PROMPT);
/** One capability's row of the table is scored again (reevaluate-prompt.ts). */
export const REEVALUATE_ROW_DEF = plainPrompt("reevaluate-row", "Re-evaluate one capability's row of the table", REEVALUATE_SYSTEM_PROMPT);

/**
 * Every competitors prompt, in the order the work runs: a company's feature list is read and reviewed (repeats,
 * missing parts, names not understood), its features are sorted into domains, each domain of the table is built and
 * one row of it can be scored again; later, new and changed pages are read for news, and a newly found feature is
 * placed in the table. The read, sort, build, news and table prompts are built from shared blocks (prompts/blocks.ts);
 * the review and re-evaluate prompts are each one text in their own file. A printed prompt says, for each shared
 * block, which of these other prompts use it; `npm run competitors:prompts` prints them all.
 */
export const PROMPTS: PromptDef[] = [
  READ_PAGES_PROMPT,
  REVIEW_REPEATS_DEF,
  REVIEW_FIX_DEF,
  REVIEW_NOT_UNDERSTOOD_DEF,
  SORT_FEATURES_PROMPT,
  BUILD_DOMAIN_PROMPT,
  REEVALUATE_ROW_DEF,
  NEWS_INTAKE_PROMPT,
  TABLE_NEW_INTAKE_PROMPT,
];

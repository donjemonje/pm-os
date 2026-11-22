import { NEWS_INTAKE_PROMPT } from "../news/intake";
import { TABLE_NEW_INTAKE_PROMPT } from "../news/table-prompt-new-intake";
import { BUILD_DOMAIN_PROMPT, READ_PAGES_PROMPT, SORT_FEATURES_PROMPT, type PromptDef } from "./blocks";

/**
 * Every prompt that is built from shared blocks (prompts/blocks.ts), in the order the work runs: a company's feature
 * list is read, its features are sorted into domains, each domain of the table is built; later, new and changed
 * pages are read for news, and a newly found feature is placed in the table. A printed prompt says, for each shared block, which of these other prompts use it;
 * `npm run competitors:prompts` prints them all.
 */
export const PROMPTS: PromptDef[] = [READ_PAGES_PROMPT, SORT_FEATURES_PROMPT, BUILD_DOMAIN_PROMPT, NEWS_INTAKE_PROMPT, TABLE_NEW_INTAKE_PROMPT];

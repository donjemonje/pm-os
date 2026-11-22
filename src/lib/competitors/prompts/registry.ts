import { NEWS_INTAKE_PROMPT } from "../news/intake";
import { READ_PAGES_PROMPT, type PromptDef } from "./blocks";

/**
 * Every prompt that is built from shared blocks (prompts/blocks.ts). A printed prompt says, for each shared block,
 * which of these other prompts use it; `npm run competitors:prompts` prints them all.
 * A prompt that is not here yet (the table prompts) still holds its rules as its own text.
 */
export const PROMPTS: PromptDef[] = [READ_PAGES_PROMPT, NEWS_INTAKE_PROMPT];

/**
 * The prompts of the REVIEW step of a company's features knowledge base (Daniel 2026-11-22): the read's list is the
 * first layer; the review makes the second layer from it — repeats merged, missing parts fixed, names that were not
 * understood looked at again. Small in, small out: only what needs a fix is sent, only fixes come back.
 * Prompts live in the app code only. Pure: text constants.
 */

/** One call per company: names and one line per feature go in; only the groups that are the same feature come back. */
export const REVIEW_REPEATS_PROMPT = `Below is the list of features of one company's product, read from its pages in several separate readings. The same feature may be listed more than once, under the same name or under different names.

Find the features that are the same feature listed more than once.

Two lines are the same feature when they describe the same thing the product does for the same users in the same way. Different wording, a different page, or a different product name of the company for the same thing is still the same feature.
They are NOT the same when they do different things, even when they solve the same problem, belong to the same module, or one is a part of the other. When you are not sure, they are not the same.

Return only the groups of two or more. For each group write:
- keep: the code of the line that describes the feature best.
- same: the codes of the other lines that are this same feature.
- why: up to about 12 words: what they both are.

A code appears in at most one group. Lines that have no repeat are not returned. Use only the codes given.`;

/** One call per batch of pages: only the features that miss something, with only their own pages. Only fixes come back. */
export const REVIEW_FIX_PROMPT = `Below are a few features of one company's product that were read from its pages, each with what is missing in it, and the pages they were read from. Each page has a code, its kind, its title, its address and its text.

For each feature, supply only what is missing, from the pages given.

- quote and page: when a quote is missing: one sentence copied word for word from a page, character for character as it stands in the page's text, that best shows what the feature does, and that page's code. Copy it from one place in one page; never join two places, never correct or tidy the wording. When no sentence of the pages shows the feature, write "" for both.
- strength: for that quote: "explains" when the page explains how the feature works; "describes" when it says what it does in a sentence or two; "names" when it only names it. "" with no quote.
- users: when users are missing: everyone who has the problem the feature solves, each with name (a job title, or the type of the program or AI agent) and kind ("person" or "agent"). An empty list when not asked.
- workflows: when workflows are missing: one to three workflows of the user this feature is part of, the closest first, each with workflow and step. An empty list when not asked.
- how_it_works: when it is missing or too long: how this company's solution works and how that solves the problem, in simple words, at most 350 characters. "" when not asked.

Use only the pages given, never what you know about this company. One line per feature given; use only the codes given.`;

/** One call per company: the names the read did not understand, against the whole list. */
export const REVIEW_NOT_UNDERSTOOD_PROMPT = `Below are names that a reading of one company's pages met but could not explain, and the list of the company's features as read from all its pages. Another page may have explained a name that one page only mentioned.

For each name say whether a feature of the list is that thing.

- name: the name as given.
- feature: the code of the feature that is this thing, or "" when no feature of the list is.
- why: up to about 10 words.

A name is a feature of the list only when the feature clearly is the thing the name stands for: its own name, the company's name for it, or what it does says so. A name that is a whole product or module made of many features is not one feature: answer "". When you are not sure, answer "". Use only the codes given.`;

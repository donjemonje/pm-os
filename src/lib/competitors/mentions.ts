/**
 * Domain names cross-reference each other inside the definition texts
 * ("Not here: … (see Exposure & response)"), so a rename must reach every
 * description that mentions the old name. Whole-word, case-sensitive: a
 * domain name is a proper noun in those texts.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionPattern(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, "gu");
}

export function mentionsName(text: string, name: string): boolean {
  if (!text || !name) return false;
  return mentionPattern(name).test(text);
}

export function renameMentions(text: string, oldName: string, newName: string): string {
  return text.replace(mentionPattern(oldName), newName);
}

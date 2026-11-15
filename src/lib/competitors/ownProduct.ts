/**
 * The chip text for a capability's own product. The field may carry a mapping
 * note after a semicolon ("Monitor; also surfaced in Investigate"); the chip
 * shows the part before it and the title shows the whole value. Pure; client-safe.
 */
export function ownProductLabel(value: string): string {
  const head = value.split(";")[0]?.trim() ?? "";
  return head || value.trim();
}

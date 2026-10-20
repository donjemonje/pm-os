import { listAllFields } from "../jira";
import { ATTRIBUTE_LABELS, writableAttributes, type IdeasJiraConfig, type MappedAttribute } from "./jira-mapping";

/**
 * The Jira field ids behind the writable mapped attributes (Admin → Ideas
 * → Jira field names), shared by the sync plan and the import's snapshot
 * (which stores exactly those fields for the drawer's offline diff). The
 * site's field list is cached a few minutes — one call per import or sync.
 */

const FIELDS_TTL_MS = 10 * 60 * 1000;
const fieldsCache = new Map<string, { expiresAt: number; value: Map<string, { id: string; name: string }> }>();

export async function cachedAllFields(workspaceId: string): Promise<Map<string, { id: string; name: string }>> {
  const hit = fieldsCache.get(workspaceId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await listAllFields(workspaceId);
  fieldsCache.set(workspaceId, { expiresAt: Date.now() + FIELDS_TTL_MS, value });
  return value;
}

export async function resolveWritableFieldIds(
  workspaceId: string,
  config: IdeasJiraConfig
): Promise<{ byAttr: Map<MappedAttribute, string>; warnings: string[] }> {
  const warnings: string[] = [];
  const all = await cachedAllFields(workspaceId);
  const byAttr = new Map<MappedAttribute, string>(
    writableAttributes(config).flatMap((attr) => {
      const hit = all.get(config.fields[attr].jiraField.toLowerCase());
      if (!hit) {
        warnings.push(
          `Jira field "${config.fields[attr].jiraField}" (${ATTRIBUTE_LABELS[attr]}) not found on this Jira site — skipped. Fix the name in Admin → Ideas.`
        );
        return [];
      }
      return [[attr, hit.id] as const];
    })
  );
  return { byAttr, warnings };
}

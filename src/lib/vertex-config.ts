/**
 * Gemini Enterprise Agent Platform (formerly Vertex AI) settings.
 * Used when AI_PROVIDER=vertex (the default).
 *
 * Auth uses Google Application Default Credentials (ADC). Point
 * GOOGLE_APPLICATION_CREDENTIALS at a service-account key file, or run
 * `gcloud auth application-default login` for local dev. The service account
 * needs the "Vertex AI User" role on the project.
 */

/** GCP project that hosts the enabled Anthropic models. */
export const DEFAULT_VERTEX_PROJECT_ID = "pm-os-9d992";

/**
 * Vertex location for the Anthropic models. They are not served in single
 * regions for this project (us-east5 & co. return 429 — no quota); they run
 * on the "global", "us" and "eu" multi-region endpoints, all drawing from the
 * shared anthropic-claude-opus lineage quota bucket. "eu" is the default:
 * every customer is in Israel/EU for now (a US customer would get "us"), and
 * prompt-cache entries become readable in seconds there vs ~30s on "global".
 * Override via VERTEX_LOCATION.
 */
export const DEFAULT_VERTEX_LOCATION = "eu";

/**
 * Vertex region for the Gemini models. Gemini has no "eu" alias — it is
 * served per region; europe-west1 (Belgium) is the EU default. Override via
 * GEMINI_LOCATION.
 */
export const DEFAULT_GEMINI_LOCATION = "europe-west1";

export function getGeminiLocation(): string {
  return process.env.GEMINI_LOCATION?.trim() || DEFAULT_GEMINI_LOCATION;
}

/**
 * Enabled module "claude-opus-4-8", version "claude-opus-4-8@default".
 * Override via VERTEX_MODEL in .env.
 */
export const DEFAULT_VERTEX_MODEL = "claude-opus-4-8@default";

export function getVertexProjectId(): string {
  return (
    process.env.VERTEX_PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    DEFAULT_VERTEX_PROJECT_ID
  );
}

export function getVertexLocation(): string {
  return (
    process.env.VERTEX_LOCATION?.trim() ||
    process.env.CLOUD_ML_REGION?.trim() ||
    DEFAULT_VERTEX_LOCATION
  );
}

export function getVertexModel(): string {
  return process.env.VERTEX_MODEL?.trim() || DEFAULT_VERTEX_MODEL;
}

/**
 * Vertex is considered configured when a project id is resolvable. Credentials
 * come from Google Application Default Credentials, which may live in an env
 * var, a key file, or the gcloud well-known file — google-auth-library resolves
 * them lazily, so we can't reliably detect them here. The real auth check
 * therefore happens on the first request; operators can hard-disable Vertex
 * with VERTEX_ENABLED=false.
 */
export function isVertexEnabled(): boolean {
  if (process.env.VERTEX_ENABLED === "false") return false;
  return Boolean(getVertexProjectId());
}

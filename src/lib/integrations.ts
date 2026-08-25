/** Show OAuth developer setup panels (env, callback URLs) — off in production for end users. */
export function showIntegrationAdminSetup(): boolean {
  const flag = process.env.PMOS_SHOW_OAUTH_ADMIN_SETUP?.trim().toLowerCase();
  if (flag === "true" || flag === "1") return true;
  if (flag === "false" || flag === "0") return false;
  return process.env.NODE_ENV === "development";
}

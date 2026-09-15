import pkg from "../../package.json";

/**
 * The app version, from package.json — the single source of truth. Bumped
 * at release (development → main) per git-flow; features in flight belong
 * to the next version listed in versions_prod_changes.md. Shown in the user
 * menu (bottom-left) so anyone can tell which version they are on.
 */
export const APP_VERSION: string = pkg.version;

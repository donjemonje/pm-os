/**
 * Password policy — one definition shared by the API (enforced) and the
 * set-password forms (live ✓/✗ checklist). Dependency-free.
 *
 * Rules: at least 8 characters, one lowercase letter, one uppercase letter,
 * one digit, one symbol (anything that is not a letter or digit, spaces
 * included).
 */

export const PASSWORD_MIN_LENGTH = 8;

export type PasswordRule = {
  key: "length" | "lower" | "upper" | "digit" | "symbol";
  label: string;
  test: (password: string) => boolean;
};

export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    key: "length",
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    test: (p) => p.length >= PASSWORD_MIN_LENGTH,
  },
  { key: "lower", label: "A lowercase letter (a–z)", test: (p) => /[a-z]/.test(p) },
  { key: "upper", label: "An uppercase letter (A–Z)", test: (p) => /[A-Z]/.test(p) },
  { key: "digit", label: "A digit (0–9)", test: (p) => /[0-9]/.test(p) },
  {
    key: "symbol",
    label: "A symbol (e.g. ! @ # $ % - _)",
    test: (p) => /[^A-Za-z0-9]/.test(p),
  },
];

/** Rules the password does NOT satisfy (empty = valid). */
export function passwordRuleFailures(password: string): PasswordRule[] {
  return PASSWORD_RULES.filter((rule) => !rule.test(password));
}

export function isPasswordValid(password: string): boolean {
  return passwordRuleFailures(password).length === 0;
}

/** The single error message the API returns for any policy failure. */
export const PASSWORD_POLICY_MESSAGE =
  `Password must be at least ${PASSWORD_MIN_LENGTH} characters and include a ` +
  `lowercase letter, an uppercase letter, a digit, and a symbol`;

import { expect, test } from "@playwright/test";
import { QA_USER } from "./helpers";
import {
  ensureWindowHeadroom,
  loginExpecting2fa,
  passTwoFactorChallenge,
  TEST_TOTP_SECRET,
  totpFor,
} from "./two-factor-helpers";

/**
 * Auth negative paths (release QA 2.0.0, inventory AUTH-03 / AUTH-08 /
 * AUTH-25). Written against origin/development 22b1799; none of these
 * surfaces is touched by feature/face_lift_v2.
 *
 * AUTH-03 bad credentials: wrong password and unknown email get the same
 *         "Invalid email or password" 401 (no hint which), empty fields 400,
 *         and no session cookie is ever set; the login form shows the message.
 * AUTH-08 2FA brute force: after 5 wrong codes on one pending session the
 *         endpoint answers 429, a CORRECT code is refused while the minute
 *         lasts, and the challenge works again once the window has passed.
 *         The 60 s wait is the limiter's window — timing by design.
 * AUTH-25 admin path without a session: /admin → /login?from=/admin,
 *         /api/admin/users → 401 (the proxy gate, before any DB lookup).
 *
 * Not covered on purpose: /api/auth/login has NO rate limiter (AUTH-26 is an
 * open product decision — recorded as a finding, not tested, not fixed).
 */

const INVALID = "Invalid email or password";
const TOO_MANY = "Too many attempts — wait a minute and try again";

test.describe("Auth negative paths (AUTH-03, AUTH-08, AUTH-25)", () => {
  test("AUTH-03 wrong password, unknown email and empty fields are refused without a session cookie", async ({
    page,
    request,
  }) => {
    const wrong = await request.post("/api/auth/login", {
      data: { email: QA_USER.email, password: "not-the-password" },
    });
    expect(wrong.status()).toBe(401);
    expect(await wrong.json()).toEqual({ error: INVALID });
    expect(wrong.headers()["set-cookie"], "no cookie on a wrong password").toBeUndefined();

    const unknown = await request.post("/api/auth/login", {
      data: { email: "qa+nobody-here@pm-os.io", password: QA_USER.password },
    });
    expect(unknown.status()).toBe(401);
    expect(await unknown.json()).toEqual({ error: INVALID }); // identical — no enumeration
    expect(unknown.headers()["set-cookie"]).toBeUndefined();

    for (const data of [{}, { email: QA_USER.email }, { password: "x" }, { email: "", password: "" }]) {
      const empty = await request.post("/api/auth/login", { data });
      expect(empty.status(), JSON.stringify(data)).toBe(400);
      expect(empty.headers()["set-cookie"]).toBeUndefined();
    }
    // Nothing above left a session behind: /api/auth/me is still anonymous.
    expect((await request.get("/api/auth/me")).status()).toBe(401);

    // The form shows the same message and stays on /login.
    await page.goto("/login");
    await page.locator("#email").fill(QA_USER.email);
    await page.locator("#password").fill("not-the-password");
    await page.getByRole("button", { name: /log in/i }).click();
    await expect(page.getByText(INVALID)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator("aside")).toHaveCount(0);
  });

  test("AUTH-08 2FA code guessing is rate-limited per pending session, then recovers after the window", async ({
    page,
  }) => {
    // 5 wrong codes + the 60 s limiter window + one real TOTP login.
    test.setTimeout(180_000);

    await loginExpecting2fa(page, QA_USER.email, QA_USER.password);
    const guess = (code: string) => page.request.post("/api/auth/two-factor", { data: { code } });

    const windowStart = Date.now();
    for (let i = 0; i < 5; i++) {
      const res = await guess("000000");
      expect(res.status(), `wrong code #${i + 1}`).toBe(400);
      expect((await res.json()).error).toMatch(/didn't match or was already used/);
    }
    const sixth = await guess("000000");
    expect(sixth.status(), "6th attempt inside the window").toBe(429);
    expect(await sixth.json()).toEqual({ error: TOO_MANY });

    // A correct code is refused too while the limiter holds — and the UI says so.
    await ensureWindowHeadroom(8_000);
    const realCode = totpFor(TEST_TOTP_SECRET).generate();
    const limited = await guess(realCode);
    expect(limited.status(), "correct code while rate-limited").toBe(429);
    await page.locator("#code").fill(realCode);
    await page.getByRole("button", { name: /verify/i }).click();
    await expect(page.getByText(TOO_MANY)).toBeVisible();
    await expect(page).toHaveURL(/\/login\/2fa/);
    expect((await page.request.get("/api/auth/me")).status(), "still fenced").toBe(401);

    // Wait out the limiter window (60 s from the first wrong attempt), then a
    // fresh code from the enrolled secret gets through. Timing by design.
    const remaining = 61_000 - (Date.now() - windowStart);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    await passTwoFactorChallenge(page);
    expect((await page.request.get("/api/auth/me")).status()).toBe(200);
  });

  test("AUTH-25 admin page and API without a session: redirect with from=/admin, API 401", async ({
    page,
    request,
  }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login\?from=%2Fadmin$/);
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/login\?from=%2Fadmin%2Fusers$/);

    for (const path of ["/api/admin/users", "/api/admin/organizations"]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    }
    const post = await request.post("/api/admin/users", {
      data: { name: "x", email: "qa+anon@pm-os.io", organizationName: "Nope" },
    });
    expect(post.status()).toBe(401);
  });
});

/** Competitors — the internal alert of an undecided address search: when it goes out, the key that stops repeats, the email's text. Pure module. */
import { describe, expect, it } from "vitest";
import { alertedKeyAfter, shouldAlertUndecided, undecidedAlertEmail, undecidedAlertKey } from "@/lib/competitors/address-alert";
import { readAddressSearch } from "@/lib/competitors/addresses";

describe("undecidedAlertKey", () => {
  it("is the same for the same candidates, whatever their order, case or trailing slash", () => {
    expect(undecidedAlertKey(["https://help.acme.test/", "https://docs.acme.test"])).toBe(undecidedAlertKey(["https://DOCS.acme.test/", "https://help.acme.test"]));
  });
  it("differs when the candidates differ; \"none\" with no candidate", () => {
    expect(undecidedAlertKey(["https://help.acme.test"])).not.toBe(undecidedAlertKey(["https://help.acme.test", "https://docs.acme.test"]));
    expect(undecidedAlertKey([])).toBe("none");
  });
});

describe("shouldAlertUndecided — one alert per company per undecided result", () => {
  const key = undecidedAlertKey(["https://help.acme.test"]);
  it("alerts on a first undecided result", () => {
    expect(shouldAlertUndecided({ status: "undecided", aiOffByKnob: false, key, earlierKey: null })).toBe(true);
  });
  it("does not repeat for the same candidates", () => {
    expect(shouldAlertUndecided({ status: "undecided", aiOffByKnob: false, key, earlierKey: key })).toBe(false);
  });
  it("alerts again when the candidates differ, and after a \"done\" in between (which clears what was alerted)", () => {
    expect(shouldAlertUndecided({ status: "undecided", aiOffByKnob: false, key, earlierKey: undecidedAlertKey(["https://docs.acme.test"]) })).toBe(true);
    expect(alertedKeyAfter({ status: "done", aiOffByKnob: false, key: "none", earlierKey: key, sent: false })).toBeNull();
    expect(shouldAlertUndecided({ status: "undecided", aiOffByKnob: false, key, earlierKey: null })).toBe(true);
  });
  it("never for a result that is not undecided, and never while the test knob keeps PMOS AI off", () => {
    expect(shouldAlertUndecided({ status: "done", aiOffByKnob: false, key, earlierKey: null })).toBe(false);
    expect(shouldAlertUndecided({ status: "waiting", aiOffByKnob: false, key, earlierKey: null })).toBe(false);
    expect(shouldAlertUndecided({ status: "undecided", aiOffByKnob: true, key, earlierKey: null })).toBe(false);
  });
});

describe("alertedKeyAfter — what the stored result remembers", () => {
  const key = undecidedAlertKey(["https://help.acme.test"]);
  it("the key after an alert that went out, and when the same one went out before", () => {
    expect(alertedKeyAfter({ status: "undecided", aiOffByKnob: false, key, earlierKey: null, sent: true })).toBe(key);
    expect(alertedKeyAfter({ status: "undecided", aiOffByKnob: false, key, earlierKey: key, sent: false })).toBe(key);
  });
  it("nothing when the email could not be sent (the next undecided result tries again) and nothing with the test knob", () => {
    expect(alertedKeyAfter({ status: "undecided", aiOffByKnob: false, key, earlierKey: null, sent: false })).toBeNull();
    expect(alertedKeyAfter({ status: "undecided", aiOffByKnob: true, key, earlierKey: key, sent: false })).toBeNull();
  });
  it("the stored result keeps it, and only when it is there", () => {
    expect(readAddressSearch({ status: "undecided", at: "2026-11-22T10:00:00.000Z", trigger: "scan", candidates: 1, added: 0, note: "x", scanId: null, alertedKey: key })?.alertedKey).toBe(key);
    expect(readAddressSearch({ status: "done", at: "2026-11-22T10:00:00.000Z", trigger: "scan", candidates: 1, added: 1, note: "", scanId: null })).not.toHaveProperty("alertedKey");
  });
});

describe("undecidedAlertEmail — for PM-OS, in plain words", () => {
  it("names the organization, the company, the candidates and the reason, and says nothing was added", () => {
    const mail = undecidedAlertEmail({ organization: "Globex", company: "Acme", website: "https://acme.test", candidates: [{ url: "https://help.acme.test", via: "link" }, { url: "https://docs.acme.test" }], note: "PMOS AI's answer is unusable: no pick for A2" });
    expect(mail.subject).toBe("[PM-OS] Other addresses of Acme were not judged (Globex)");
    const body = mail.paragraphs.join("\n");
    expect(body).toContain("organization: Globex");
    expect(body).toContain("found 2 candidate addresses");
    expect(body).toContain("Nothing was added");
    expect(body).toContain("Why: PMOS AI's answer is unusable: no pick for A2");
    expect(body).toContain("Candidates: https://help.acme.test (found by link) · https://docs.acme.test");
    expect(mail.note).toContain("The customer sees no message");
  });
  it("one candidate; and a search that failed before it found any", () => {
    expect(undecidedAlertEmail({ organization: "Globex", company: "Acme", website: "https://acme.test", candidates: [{ url: "https://help.acme.test" }], note: "x" }).paragraphs[0]).toContain("found 1 candidate address, and PMOS AI did not say what it is");
    const none = undecidedAlertEmail({ organization: "Globex", company: "Acme", website: "https://acme.test", candidates: [], note: "" });
    expect(none.paragraphs[0]).toContain("ended without a result");
    expect(none.paragraphs.join("\n")).toContain("Why: no reason was recorded");
    expect(none.paragraphs.join("\n")).not.toContain("Candidates:");
  });
});

/** Competitors — the model boundary (lib/competitors/ai.ts): the string cleaners, an unusable answer, a streamed answer; and the page key that keeps a video id. Pure parts only. */
import { describe, expect, it } from "vitest";
import { AnswerError, CALL_TIMEOUT_MS, collectStream, cut, NO_USAGE, tidy, type StreamPiece } from "@/lib/competitors/ai";
import { pageKey } from "@/lib/competitors/url";

describe("tidy", () => {
  it("cuts a leaked next-field fragment and a dangling quote-comma", () => {
    expect(tidy("Automated detection rule generation (Auto YARA)','domain':'Cyber Threat")).toBe("Automated detection rule generation (Auto YARA)");
    expect(tidy("IBM Security SOAR (IBM Resilient)','")).toBe("IBM Security SOAR (IBM Resilient)");
    expect(tidy("Payment Fraud Intelligence (PFI)\",")).toBe("Payment Fraud Intelligence (PFI)");
  });
  it("leaves ordinary values and balanced quotes alone", () => {
    expect(tidy("Know what matters. Act first.")).toBe("Know what matters. Act first.");
    expect(tidy('supports "Splunk", "QRadar" and more')).toBe('supports "Splunk", "QRadar" and more');
    expect(tidy("Splunk, QRadar")).toBe("Splunk, QRadar");
    expect(tidy("  Boston, MA ")).toBe("Boston, MA");
  });
});

describe("pageKey keeps a video id", () => {
  it("drops queries everywhere except youtube.com/watch", () => {
    expect(pageKey(new URL("https://www.youtube.com/watch?v=abc123&t=10s"))).toBe("https://www.youtube.com/watch?v=abc123");
    expect(pageKey(new URL("https://youtube.com/watch?list=1"))).toBe("https://youtube.com/watch");
    expect(pageKey(new URL("https://e.com/watch?v=abc"))).toBe("https://e.com/watch");
  });
});

describe("cut", () => {
  it("keeps short strings and cuts long ones at a word boundary", () => {
    expect(cut("short name", 80)).toBe("short name");
    expect(cut("AI service network indicator feeds for shadow AI discovery and policy enforcement", 80)).toBe("AI service network indicator feeds for shadow AI discovery and policy");
  });
  it("falls back to a hard cut when there is no usable space", () => {
    expect(cut("x".repeat(100), 80)).toBe("x".repeat(80));
  });
});

describe("AnswerError — an unusable answer was still a billed call", () => {
  it("carries the tokens the call used, so the run counts them", () => {
    const e = new AnswerError("PMOS AI did not finish its answer (finish: MAX_TOKENS, 9000 chars)", { input: 4200, output: 17000, cached: 0, thinking: 9000 });
    expect(e.usage).toEqual({ input: 4200, output: 17000, cached: 0, thinking: 9000 });
    expect(e.name).toBe("AnswerError");
  });
  it("without usage (an injected answer, a test) it counts nothing", () => {
    expect(new AnswerError("invalid JSON").usage).toEqual(NO_USAGE);
  });
});

describe("a streamed answer (no default timeout can cut a long answer)", () => {
  async function* pieces(list: StreamPiece[]): AsyncGenerator<StreamPiece> {
    for (const p of list) yield p;
  }
  const part = (text: string, thought = false) => ({ candidates: [{ content: { parts: [{ text, thought }] } }] });
  it("puts the text of every piece together, in order — the JSON arrives in pieces", async () => {
    const r = await collectStream(pieces([part('{"capabili'), part('ties": ['), { candidates: [{ content: { parts: [{ text: "]}" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 500_000, candidatesTokenCount: 40, thoughtsTokenCount: 10, cachedContentTokenCount: 0 } }]));
    expect(r.text).toBe('{"capabilities": []}');
    expect(JSON.parse(r.text)).toEqual({ capabilities: [] });
    expect(r.finish).toBe("STOP");
    expect(r.usage).toEqual({ input: 500_000, output: 50, cached: 0, thinking: 10 });
  });
  it("never takes the model's own thoughts for the answer", async () => {
    const r = await collectStream(pieces([part("thinking about the pages…", true), part('{"a":1}'), { candidates: [{ finishReason: "STOP" }] }]));
    expect(r.text).toBe('{"a":1}');
  });
  it("keeps the last finish reason and the last usage report; a stream that says neither is unknown and unbilled", async () => {
    const cut = await collectStream(pieces([{ ...part('{"a":'), usageMetadata: { promptTokenCount: 10 } }, { candidates: [{ finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 7 } }]));
    expect(cut.finish).toBe("MAX_TOKENS");
    expect(cut.usage.output).toBe(7);
    const empty = await collectStream(pieces([]));
    expect(empty).toEqual({ text: "", finish: "unknown", usage: { ...NO_USAGE } });
  });
  it("the one explicit ceiling of a call is an hour — far above the 5 minutes a default used to allow", () => {
    expect(CALL_TIMEOUT_MS).toBe(60 * 60_000);
  });
});

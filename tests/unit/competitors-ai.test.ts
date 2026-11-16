/** Competitors — the model boundary (lib/competitors/ai.ts): the string cleaners, an unusable answer, a streamed answer; and the page key that keeps a video id. Pure parts only. */
import { describe, expect, it } from "vitest";
import { AnswerError, CALL_TIMEOUT_MS, collectStream, cut, NO_USAGE, RAW_ANSWER_KEPT, rawForRecord, tidy, type StreamPiece } from "@/lib/competitors/ai";
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
    expect(empty).toEqual({ text: "", finish: "unknown", usage: { ...NO_USAGE }, pieces: 0, textPieces: 0 });
  });
  it("the one explicit ceiling of a call is an hour — far above the 5 minutes a default used to allow", () => {
    expect(CALL_TIMEOUT_MS).toBe(60 * 60_000);
  });
});

describe("an unusable answer keeps its text — the evidence (first real run: \"invalid JSON (finish: STOP, 75 chars)\" and nothing left to read)", () => {
  /** A plain answer of the page-by-page map with seven codes is exactly 75 characters — and valid. */
  const ordinary = '{"release_notes": ["P201", "P202", "P203", "P204", "P205", "P206", "P207"]}';
  it("an ordinary answer of that call can be 75 characters long and parse: the length alone says nothing", () => {
    expect(ordinary).toHaveLength(75);
    expect(JSON.parse(ordinary)).toEqual({ release_notes: ["P201", "P202", "P203", "P204", "P205", "P206", "P207"] });
  });
  it("whatever made it unreadable — a markdown fence, two objects joined, a piece lost or doubled in the join, a cut — the text is kept as it came", () => {
    const candidates = [
      '```json\n{"release_notes": []}\n```',
      '{"release_notes": []}{"release_notes": []}',
      '{"release_notes": ["P201", "P202", "P2"P204", "P205"]}',
      '{"release_notes": ["P201", "P202", "P203", "P203", "P20',
      "[]\n[]",
    ];
    for (const text of candidates) {
      expect(() => JSON.parse(text), text).toThrow();
      const e = new AnswerError("PMOS AI (gemini-4-argon) returned invalid JSON", { ...NO_USAGE, input: 20_000, output: 30 }, text);
      expect(e.raw).toBe(text);
      expect(e.usage.input).toBe(20_000);
    }
  });
  it("an empty answer keeps the empty text; a provider that gave no text at all keeps null", () => {
    expect(new AnswerError("empty", NO_USAGE, "").raw).toBe("");
    expect(new AnswerError("no structured answer").raw).toBeNull();
  });
  it("a long unusable answer keeps its start and its end — where a cut or a second object shows — and says how much was left out", () => {
    const long = `{"capabilities": [${"x".repeat(10_000)}]}{"oops": 1}`;
    const kept = rawForRecord(long);
    expect(kept.startsWith('{"capabilities": [xxx')).toBe(true);
    expect(kept.endsWith(']}{"oops": 1}')).toBe(true);
    expect(kept).toContain(`…[${(long.length - RAW_ANSWER_KEPT).toLocaleString("en-US")} characters left out]…`);
    expect(kept.length).toBeLessThan(RAW_ANSWER_KEPT + 60);
    expect(rawForRecord("short")).toBe("short");
    expect(new AnswerError("x", NO_USAGE, long).raw).toBe(kept);
  });
  it("the stream says how it delivered the answer: how many pieces, how many carried text — to tell a bad answer from a bad join", async () => {
    async function* pieces(list: StreamPiece[]): AsyncGenerator<StreamPiece> {
      for (const p of list) yield p;
    }
    const text = (t: string, thought = false): StreamPiece => ({ candidates: [{ content: { parts: [{ text: t, thought }] } }] });
    const r = await collectStream(pieces([text("thinking…", true), text('{"release_notes": ['), text('"P201"'), text("]}"), { candidates: [{ finishReason: "STOP" }] }]));
    expect(r).toMatchObject({ text: '{"release_notes": ["P201"]}', finish: "STOP", pieces: 5, textPieces: 3 });
  });
});

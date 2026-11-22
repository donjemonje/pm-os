/**
 * Prints the prompts that are built from shared blocks (src/lib/competitors/prompts), for a person to read:
 *
 *   npm run competitors:prompts -- [--out=<folder>] [--check=<folder>]
 *
 * Each shared block is marked with its name and the other prompts that use it. PMOS AI never sees the marks.
 * --out: writes one file per prompt (<name>.txt) into the folder instead of printing.
 * --check: a prompt that also lives as a text file outside the app (its `file`) is compared with that file in the
 *          folder, character for character; a difference is reported and the exit code is 1.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printPrompt, promptText, promptVersion } from "../src/lib/competitors/prompts/blocks";
import { PROMPTS } from "../src/lib/competitors/prompts/registry";

const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith("--out="))?.slice(6);
const check = args.find((a) => a.startsWith("--check="))?.slice(8);

if (out) mkdirSync(out, { recursive: true });
for (const p of PROMPTS) {
  const printed = printPrompt(p, PROMPTS);
  if (out) { writeFileSync(join(out, `${p.name}.txt`), printed); console.log(`${promptVersion(p)} → ${join(out, `${p.name}.txt`)}`); }
  else console.log(`${"=".repeat(100)}\n${printed}`);
}

if (check) {
  for (const p of PROMPTS.filter((x) => x.file)) {
    const path = join(check, p.file!);
    if (!existsSync(path)) { console.log(`CHECK ${p.name}: ${path} not found`); process.exitCode = 1; continue; }
    const file = readFileSync(path, "utf8").trim();
    const ours = promptText(p);
    if (file === ours) { console.log(`CHECK ${p.name}: the same as ${p.file}`); continue; }
    let at = 0;
    while (at < file.length && at < ours.length && file[at] === ours[at]) at++;
    console.log(`CHECK ${p.name}: DIFFERS from ${p.file} at character ${at}\n  file: …${JSON.stringify(file.slice(Math.max(0, at - 40), at + 80))}\n  app:  …${JSON.stringify(ours.slice(Math.max(0, at - 40), at + 80))}`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// Regression: validate-umbrella-artifact measured the `## Stable Program Goal` block as 0 chars
// whenever a blank line followed the heading (multiline-regex `$` bug), so an oversize /goal
// block inside a code fence always passed. Builds umbrella variants from the pass.md fixture
// and checks the length rule (> 4000 chars => fail, with the real char count).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(here, "validate-umbrella-artifact.mjs");
const base = fs.readFileSync(path.join(here, "fixtures", "validate-umbrella-artifact", "pass.md"), "utf8");

const fence = (body) => `\`\`\`\n${body}\n\`\`\``;
const big = "x".repeat(5000);
const cases = [
  { name: "fenced block under limit passes", body: fence("y".repeat(3000)), expect: null },
  { name: "fenced block over limit fails with real count", body: fence(big), expect: "(5000 chars)" },
  { name: "'## ' and '---' inside the fence do not cut it short",
    body: fence(`${"a".repeat(2500)}\n## not a heading\n---\n${"b".repeat(2500)}`), expect: "exceeds 4000" },
  { name: "unfenced content over limit fails", body: big, expect: "section content exceeds 4000" },
  { name: "CRLF line endings measured too", body: fence(big), crlf: true, expect: "(5000 chars)" },
  { name: "empty section fails", body: "", expect: "is empty" },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "umbrella-goal-"));
spawnSync("git", ["init", "-q"], { cwd: tmp }); // pin the validator's git root to tmp

let failed = 0;
for (const [i, c] of cases.entries()) {
  // Replace everything between the Stable Program Goal heading and the next "## " heading.
  let doc = base.replace(/(## Stable Program Goal[^\n]*\n)[\s\S]*?(\n## )/, `$1\n${c.body}\n$2`);
  if (c.crlf) doc = doc.replace(/\r?\n/g, "\r\n");
  const file = `umbrella-case-${i}.md`;
  fs.writeFileSync(path.join(tmp, file), doc);

  const res = spawnSync(process.execPath, [validator, file], { cwd: tmp, encoding: "utf8" });
  const goalFailures = JSON.parse(res.stdout).failures.filter((f) => /Stable Program Goal/.test(f));
  const ok = c.expect === null
    ? goalFailures.length === 0
    : goalFailures.length === 1 && goalFailures[0].includes(c.expect);
  if (ok) {
    console.log(`ok   ${c.name}`);
  } else {
    failed++;
    console.log(`FAIL ${c.name}\n  expected: ${c.expect ?? "no goal failure"}\n  got: ${JSON.stringify(goalFailures)}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? "\nAll Stable Program Goal checks passed" : `\n${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;

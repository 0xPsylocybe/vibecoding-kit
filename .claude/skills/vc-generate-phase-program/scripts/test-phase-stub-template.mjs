#!/usr/bin/env node
// Regression: a phase stub is also a `_PLAN_` file, so the PostToolUse plan hook runs
// validate-plan-artifact.mjs on it as well as validate-phase-stub.mjs. The template and the
// pass.md fixture used to satisfy only the latter, so every freshly generated stub failed the
// hook. This renders both into a throwaway `process/features/*/active/` tree (the plan validator
// requires that location) and demands zero failures from BOTH validators.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(here, "..");
const skillsDir = path.resolve(skillDir, "..");
const stubValidator = path.join(here, "validate-phase-stub.mjs");
const planValidator = path.join(skillsDir, "vc-generate-plan", "scripts", "validate-plan-artifact.mjs");

const date = "06-11-26";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phase-stub-"));
// Own git repo so validate-phase-stub's `git rev-parse --show-toplevel` resolves HERE,
// never to whatever repo the temp dir might happen to live under.
spawnSync("git", ["init", "-q"], { cwd: tmp });
const folderRel = `process/features/demo/active/demo-program_${date}`;
fs.mkdirSync(path.join(tmp, folderRel), { recursive: true });

const template = fs
  .readFileSync(path.join(skillDir, "templates", "phase-stub-template.md"), "utf8")
  .replaceAll("{dd-mm-yy}", date);
const fixture = fs.readFileSync(path.join(here, "fixtures", "validate-phase-stub", "pass.md"), "utf8");

const cases = [
  // Template: zero warnings too (--strict), it is the canonical shape.
  { name: "template", file: `phase-01-demo_PLAN_${date}.md`, body: template, strict: true },
  // Fixture: minimal by design (no Touchpoints etc.), so only failures count.
  { name: "pass.md fixture", file: `phase-05-inner-loop_PLAN_${date}.md`, body: fixture, strict: false },
];

let failed = 0;
for (const c of cases) {
  const rel = `${folderRel}/${c.file}`;
  fs.writeFileSync(path.join(tmp, rel), c.body);
  for (const [label, script] of [["validate-phase-stub", stubValidator], ["validate-plan-artifact", planValidator]]) {
    const args = [script, rel, ...(c.strict ? ["--strict"] : [])];
    const res = spawnSync(process.execPath, args, { cwd: tmp, encoding: "utf8" });
    let report;
    try {
      report = JSON.parse(res.stdout);
    } catch {
      report = { failures: [`unparseable output: ${res.stdout || res.stderr}`] };
    }
    if (res.status === 0 && report.failures.length === 0) {
      console.log(`ok   ${c.name} -> ${label}`);
    } else {
      failed++;
      console.log(`FAIL ${c.name} -> ${label}\n  - ${report.failures.join("\n  - ")}`);
    }
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? "\nAll phase-stub checks passed" : `\n${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;

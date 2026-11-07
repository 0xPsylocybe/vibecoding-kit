#!/usr/bin/env node
// Single source of truth for what CI checks, on every OS (Windows + Debian jobs both call it).
// Runs the kit validators, every hook / skill-script test and the e2e install trials, then
// prints one summary. Kit-only (under .github/, never installed into projects).
//
//   node .github/scripts/run-kit-tests.mjs                 # everything
//   node .github/scripts/run-kit-tests.mjs --only=validators
//   node .github/scripts/run-kit-tests.mjs --only=tests
//   node .github/scripts/run-kit-tests.mjs --skip-e2e      # fast local loop
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith("--only=")) || "").slice("--only=".length);
const skipE2e = args.includes("--skip-e2e");

// Validators run by CI. Generators (generate-skills-catalog) stay out: this runner must not
// modify the working tree.
const VALIDATORS = [
  "vc-audit-vc/scripts/validate-agent-parity.mjs",
  "vc-audit-vc/scripts/validate-skills.mjs",
  "vc-audit-vc/scripts/validate-guide-sync.mjs",
  "vc-audit-vc/scripts/validate-protocol-wiring.mjs",
  "vc-audit-vc/scripts/validate-seeds.mjs",
  "vc-audit-context/scripts/validate-context-discovery.mjs",
  "vc-audit-context/scripts/validate-skill-routing.mjs",
  "vc-audit-context/scripts/validate-skill-cross-refs.mjs",
  "vc-audit-context/scripts/validate-skill-dependencies.mjs",
  "vc-audit-context/scripts/validate-confusable-skills.mjs",
  "vc-audit-plans/scripts/validate-plan-inventory.mjs",
  "vc-generate-context/scripts/validate-all-context.mjs",
  "vc-audit-vc/scripts/validate-skill-invocation-wiring.mjs",
  "vc-audit-context/scripts/validate-protocol-discovery.mjs",
  "vc-audit-context/scripts/validate-skill-keywords.mjs",
  "vc-audit-vc/scripts/validate-kit-portability.mjs",
].map((rel) => [".claude/skills/" + rel]);

// Known gaps: still RUN and reported, but they do not fail the job. Each entry needs a reason
// and should be removed as soon as it is fixed — this list must only shrink.
const KNOWN_GAPS = new Map([
  [".codex/hooks/lib/__tests__/usage-limits-cache.test.cjs",
    "copy of the .claude test, but .codex/hooks/lib/usage-limits-cache.cjs is a Codex-specific variant (readCodexCredentials, hasProviderRuntimeOverride); needs its own test"],
]);

function listFiles(relDir, re) {
  const dir = path.join(root, relDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => `${relDir}/${f}`);
}

function activePlans() {
  const found = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (/_PLAN_.*\.md$/.test(e.name)) found.push(child);
    }
  };
  walk("process/general-plans/active");
  const features = path.join(root, "process/features");
  if (fs.existsSync(features)) {
    for (const f of fs.readdirSync(features)) walk(`process/features/${f}/active`);
  }
  return found.sort();
}

function tests() {
  const list = [];
  for (const mirror of [".claude", ".codex"]) {
    list.push(...listFiles(`${mirror}/hooks/__tests__`, /\.test\.cjs$/));
    list.push(...listFiles(`${mirror}/hooks/lib/__tests__`, /\.test\.cjs$/));
    list.push(...listFiles(`${mirror}/hooks/scout-block/tests`, /^test-.*\.cjs$/));
  }
  for (const skill of fs.readdirSync(path.join(root, ".claude/skills")).sort()) {
    list.push(...listFiles(`.claude/skills/${skill}/scripts`, /^test-.*\.mjs$/));
  }
  return list.map((rel) => [rel]);
}

// Child environment: deterministic git identity (the e2e commits) and, on Windows, Git Bash
// ahead of System32 so `bash install.sh` never resolves to WSL's bash.exe.
const env = { ...process.env };
for (const [k, v] of [["GIT_AUTHOR_NAME", "kit-ci"], ["GIT_AUTHOR_EMAIL", "kit-ci@example.invalid"],
  ["GIT_COMMITTER_NAME", "kit-ci"], ["GIT_COMMITTER_EMAIL", "kit-ci@example.invalid"]]) {
  if (!env[k]) env[k] = v;
}
if (process.platform === "win32") {
  const gitBin = path.join(env.ProgramFiles || "C:\\Program Files", "Git", "bin");
  if (fs.existsSync(gitBin)) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
    env[key] = `${gitBin}${path.delimiter}${env[key] || ""}`;
  }
}

const groups = [];
if (!only || only === "validators") {
  groups.push(["validators", VALIDATORS]);
  const plans = activePlans();
  if (plans.length) {
    groups.push(["plan artifacts", [[".claude/skills/vc-generate-plan/scripts/validate-plan-artifact.mjs", ...plans]]]);
  }
}
if (!only || only === "tests") {
  groups.push(["tests", tests()]);
  if (!skipE2e) groups.push(["e2e", [["--test", "e2e-kit-flows.test.mjs"]]]);
}

const failures = [];
const gapsHit = [];
let total = 0;
for (const [name, commands] of groups) {
  console.log(`\n== ${name} (${commands.length})`);
  for (const argv of commands) {
    total++;
    const started = Date.now();
    const res = spawnSync(process.execPath, argv, { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const ok = res.status === 0;
    const label = argv.join(" ");
    const gap = KNOWN_GAPS.get(argv[0]);
    const status = ok ? (gap ? "ok* " : "ok  ") : (gap ? "GAP " : "FAIL");
    console.log(`${status} ${label} (${Date.now() - started} ms)`);
    if (!ok && gap) gapsHit.push(`${label}: ${gap}`);
    else if (!ok) failures.push({ label, output: `${res.stdout || ""}${res.stderr || ""}${res.error ? res.error.message : ""}` });
    else if (gap) console.log(`     ^ listed as known gap but passes now — remove it from KNOWN_GAPS`);
  }
}

for (const f of failures) {
  console.log(`\n---- output: ${f.label}\n${f.output.split("\n").slice(-60).join("\n")}`);
}
if (gapsHit.length) console.log(`\nKnown gaps (not failing the run):\n- ${gapsHit.join("\n- ")}`);
console.log(`\n${total - failures.length - gapsHit.length}/${total} passed, ${gapsHit.length} known gap(s), ${failures.length} failure(s) on ${process.platform} (node ${process.version})`);
process.exitCode = failures.length ? 1 : 0;

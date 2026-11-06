#!/usr/bin/env node
// Regression: validate-context-discovery / validate-skills failed with
// ".agents/skills does not resolve to .claude/skills" on Windows installs without Developer
// Mode, where .agents/skills is a real-directory COPY (the supported fallback). Builds each
// possible state in a temp root and checks the shared inspect + classify verdict.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectAgentsSkillsMirror, classifyAgentsSkillsMirror } from "./shared-skill-utils.mjs";

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agents-mirror-"));
  write(path.join(root, ".claude/skills/vc-a/SKILL.md"), "---\nname: vc-a\n---\nbody\n");
  write(path.join(root, ".claude/skills/vc-b/scripts/x.mjs"), "export {};\n");
  return root;
}
const copy = (root) => fs.cpSync(path.join(root, ".claude/skills"), path.join(root, ".agents/skills"), { recursive: true });
const mirror = (root, rel) => path.join(root, ".agents/skills", rel);

const cases = [
  { name: "missing", setup: () => {}, kind: "missing", level: "fail" },
  {
    name: "directory link (junction on Windows, symlink elsewhere)",
    setup: (r) => fs.symlinkSync(path.join(r, ".claude/skills"), path.join(r, ".agents/skills"), "junction"),
    kind: "symlink", level: "ok",
  },
  {
    name: "link to another directory",
    setup: (r) => {
      fs.mkdirSync(path.join(r, "elsewhere"));
      fs.symlinkSync(path.join(r, "elsewhere"), path.join(r, ".agents/skills"), "junction");
    },
    kind: "wrong-symlink", level: "fail",
  },
  {
    name: "placeholder file from core.symlinks=false",
    setup: (r) => write(path.join(r, ".agents/skills"), "../.claude/skills"),
    kind: "placeholder-file", level: "fail",
  },
  { name: "identical copy", setup: copy, kind: "copy", level: "ok" },
  {
    name: "copy differing only in CRLF",
    setup: (r) => { copy(r); write(mirror(r, "vc-a/SKILL.md"), "---\r\nname: vc-a\r\n---\r\nbody\r\n"); },
    kind: "copy", level: "ok",
  },
  {
    name: "copy ignores node_modules",
    setup: (r) => { copy(r); write(mirror(r, "vc-b/node_modules/dep/index.js"), "x"); },
    kind: "copy", level: "ok",
  },
  {
    name: "stale copy: changed file",
    setup: (r) => { copy(r); write(mirror(r, "vc-a/SKILL.md"), "old\n"); },
    kind: "copy", level: "fail", message: "changed vc-a/SKILL.md",
  },
  {
    name: "stale copy: missing skill",
    setup: (r) => { copy(r); fs.rmSync(mirror(r, "vc-b"), { recursive: true }); },
    kind: "copy", level: "fail", message: "missing vc-b/scripts/x.mjs",
  },
  {
    name: "copy with leftovers of a removed skill",
    setup: (r) => { copy(r); write(mirror(r, "vc-old/SKILL.md"), "gone\n"); },
    kind: "copy", level: "warn", message: "vc-old/SKILL.md",
  },
];

let failed = 0;
for (const c of cases) {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
  try {
    c.setup(root);
    const result = inspectAgentsSkillsMirror(root);
    const verdict = classifyAgentsSkillsMirror(result);
    const ok = result.kind === c.kind
      && verdict.level === c.level
      && (!c.message || (verdict.message || "").includes(c.message));
    if (ok) console.log(`ok   ${c.name} -> ${verdict.level}`);
    else {
      failed++;
      console.log(`FAIL ${c.name}: got kind=${result.kind} level=${verdict.level} msg=${verdict.message}`);
    }
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}: threw ${e.message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
console.log(failed === 0 ? "\nAll .agents/skills mirror checks passed" : `\n${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = (() => {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
})();

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const inputPaths = args.filter((arg) => !arg.startsWith("--"));
const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  if (strict) failures.push(message);
  else warnings.push(message);
}

function exists(relPath) {
  return fs.existsSync(path.join(root, relPath));
}

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

function hasSection(text, name) {
  return new RegExp(`^##\\s+${name}\\b`, "im").test(text);
}

/**
 * Return the text a user would paste as /goal from `## Stable Program Goal`.
 *
 * Line-based on purpose: the previous multiline regex let `$` match at the end of
 * the first line, so a blank line after the heading measured 0 chars and an
 * oversize fenced block always passed. Fence-aware so a `## ` or `---` inside the
 * code block does not end the section early.
 *
 * @returns {{ content: string, fenced: boolean }} first fenced block's inner text
 *   when the section has one (that is what gets pasted), else the trimmed section.
 */
function extractStableGoalBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Stable Program Goal\b/i.test(l));
  if (start === -1) return { content: "", fenced: false };

  const section = [];
  let fence = null; // opening fence marker while inside a code block
  for (const line of lines.slice(start + 1)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    } else if (!fence && (/^##\s/.test(line) || /^---\s*$/.test(line))) {
      break;
    }
    section.push(line);
  }

  const open = section.findIndex((l) => /^\s*(`{3,}|~{3,})/.test(l));
  if (open !== -1) {
    const openMarker = section[open].trim().match(/^(`{3,}|~{3,})/)[1];
    const rest = section.slice(open + 1);
    const close = rest.findIndex((l) => {
      const m = l.trim().match(/^(`{3,}|~{3,})\s*$/);
      return m && m[1][0] === openMarker[0] && m[1].length >= openMarker.length;
    });
    const inner = close === -1 ? rest : rest.slice(0, close);
    return { content: inner.join("\n").trim(), fenced: true };
  }
  return { content: section.join("\n").trim(), fenced: false };
}

function isUmbrellaActivePath(relPath) {
  return (
    /^process\/features\/[^/]+\/active\//.test(relPath) ||
    /^process\/features\/[^/]+\/completed\//.test(relPath)
  );
}

function resolvePath(inputPath) {
  // Accept absolute paths or paths relative to cwd/root
  if (path.isAbsolute(inputPath)) {
    const rel = path.relative(root, inputPath);
    return rel;
  }
  return inputPath;
}

function validateUmbrella(relPath) {
  const absPath = path.join(root, relPath);

  if (!fs.existsSync(absPath)) {
    fail(`${relPath} does not exist on disk`);
    return null;
  }
  if (!relPath.endsWith(".md")) {
    fail(`${relPath} is not a markdown file`);
    return null;
  }
  if (!isUmbrellaActivePath(relPath)) {
    warn(`${relPath} is not under process/features/*/active/ or process/features/*/completed/ — skipping path check`);
  }

  const text = read(relPath);
  const lines = text.split("\n");
  const localFailuresBefore = failures.length;
  const localWarningsBefore = warnings.length;

  // YAML frontmatter: first line must be ---
  if (lines[0] !== "---") {
    fail(`${relPath} missing YAML frontmatter (line 1 must be '---')`);
  }

  // Extract frontmatter block
  const fmEnd = lines.indexOf("---", 1);
  const frontmatter = fmEnd > 0 ? lines.slice(1, fmEnd).join("\n") : "";

  if (!/phase:\s*umbrella/.test(frontmatter)) {
    fail(`${relPath} YAML frontmatter does not contain 'phase: umbrella'`);
  }

  // Filename convention: a real umbrella plan under process/features/*/active|completed
  // MUST carry the literal token `umbrella` in its filename ({program-slug}-umbrella_PLAN_{date}.md).
  // Scoped to feature paths so synthetic fixtures (pass.md/fail.md) run by direct path are exempt.
  if (isUmbrellaActivePath(relPath) && !/umbrella/i.test(path.basename(relPath))) {
    fail(`${relPath} declares 'phase: umbrella' but filename is missing the 'umbrella' token — name it {program-slug}-umbrella_PLAN_{date}.md`);
  }

  // Required sections
  if (!hasSection(text, "Program Goal Charter")) {
    fail(`${relPath} missing '## Program Goal Charter' section`);
  }

  if (!hasSection(text, "Stable Program Goal")) {
    fail(`${relPath} missing '## Stable Program Goal' section`);
  } else {
    // Check /goal block length ≤ 4000 chars (the /goal command rejects longer blocks)
    const goal = extractStableGoalBlock(text);
    if (goal.content.length === 0) {
      fail(`${relPath} Stable Program Goal section is empty — it must hold the copy-pasteable /goal block`);
    } else if (goal.content.length > 4000) {
      fail(`${relPath} Stable Program Goal ${goal.fenced ? "fenced /goal block" : "section content"} exceeds 4000 chars (${goal.content.length} chars)`);
    }
  }

  if (!hasSection(text, "Current Execution State")) {
    fail(`${relPath} missing '## Current Execution State' section`);
  }

  // Canonical heading is '## Phase Ordering'; '## Phase Sequence' accepted as a legacy alias
  // (dual-accept — some completed-program umbrellas still carry the old heading; non-breaking).
  if (!hasSection(text, "Phase Ordering") && !hasSection(text, "Phase Sequence")) {
    fail(`${relPath} missing '## Phase Ordering' section`);
  }

  if (!hasSection(text, "Program Status Table")) {
    fail(`${relPath} missing '## Program Status Table' section`);
  }

  if (!hasSection(text, "Validate Contract")) {
    fail(`${relPath} missing '## Validate Contract' section`);
  }

  // Cross-reference: extract phase file paths from the Phase Ordering table (alias: Phase Sequence)
  const phaseSeqMatch =
    text.match(/^## Phase Ordering\b([\s\S]*?)(?=\n## |\n---\n|$)/im) ||
    text.match(/^## Phase Sequence\b([\s\S]*?)(?=\n## |\n---\n|$)/im);
  if (phaseSeqMatch) {
    const phaseSeqContent = phaseSeqMatch[1];
    // Find lines that reference process/features/ or process/general-plans/ paths
    const pathPattern = /`?(process\/(?:features\/[^/]+|general-plans)\/(?:active|completed)\/[^`\s|]+\.md)`?/g;
    let match;
    while ((match = pathPattern.exec(phaseSeqContent)) !== null) {
      const phasePath = match[1];
      if (!exists(phasePath)) {
        fail(`${relPath} Phase Sequence references missing file: ${phasePath}`);
      }
    }
  }

  // Warnings
  if (!/Per-Phase Loop|per-phase loop|Per-Phase Entry/i.test(text)) {
    warn(`${relPath} missing '## Per-Phase Loop' or equivalent section (recommended)`);
  }

  if (!hasSection(text, "Global Constraints")) {
    warn(`${relPath} missing '## Global Constraints' section (recommended)`);
  }

  if (!hasSection(text, "Durable Report Destinations")) {
    warn(`${relPath} missing '## Durable Report Destinations' section (recommended)`);
  }

  return {
    path: relPath,
    failures: failures.length - localFailuresBefore,
    warnings: warnings.length - localWarningsBefore,
    lines: lines.length,
  };
}

// Determine which plans to check
let planPaths = [];

if (inputPaths.length > 0) {
  planPaths = inputPaths.map(resolvePath);
} else {
  // Auto-scan for umbrella plans
  const featureBase = path.join(root, "process/features");
  if (fs.existsSync(featureBase)) {
    const features = fs.readdirSync(featureBase);
    for (const feature of features) {
      for (const subdir of ["active", "completed"]) {
        const dir = path.join(featureBase, feature, subdir);
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (!file.endsWith(".md")) continue;
            // Select umbrellas by YAML frontmatter `phase: umbrella` (the discovery source of
            // truth). The filename token `umbrella` is then ENFORCED separately (see validateUmbrella)
            // — e.g. `vc-system-implementation-umbrella_PLAN_09-06-26.md`.
            let fmHasUmbrella = false;
            try {
              const content = fs.readFileSync(path.join(dir, file), "utf8");
              const fl = content.split("\n");
              if (fl[0] === "---") {
                const end = fl.indexOf("---", 1);
                const fm = end > 0 ? fl.slice(1, end).join("\n") : "";
                fmHasUmbrella = /phase:\s*umbrella/.test(fm);
              }
            } catch {
              // unreadable file — skip
            }
            if (fmHasUmbrella) {
              planPaths.push(`process/features/${feature}/${subdir}/${file}`);
            }
          }
        }
      }
    }
  }
  if (planPaths.length === 0) {
    warnings.push("No umbrella plans found in process/features/*/active/ or process/features/*/completed/");
  }
}

const checkedPlans = [];
for (const relPath of planPaths) {
  const result = validateUmbrella(relPath);
  if (result) checkedPlans.push(result);
}

const result = {
  checkedPlans,
  strict,
  warnings,
  failures,
};

console.log(JSON.stringify(result, null, 2));

if (failures.length > 0) {
  process.exitCode = 1;
}

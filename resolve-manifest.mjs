#!/usr/bin/env node

/**
 * resolve-manifest.mjs — Glob-based manifest resolver for vibecode-pro-max-kit.
 *
 * Resolves vc-manifest.json include/exclude/kitOnly patterns to a flat file list.
 * Supports both v2.1+ (glob) and legacy v2.0.x (explicit list) formats.
 *
 * Usage:
 *   node resolve-manifest.mjs                       # newline-separated file list
 *   node resolve-manifest.mjs --root /path/to/kit   # resolve from a specific directory
 *   node resolve-manifest.mjs --json                 # full JSON output with metadata
 *   node resolve-manifest.mjs --kit-only             # only kit-exclusive files
 *
 * Zero dependencies — Node.js built-ins only.  Requires Node >= 22.
 */

import fs from "node:fs";
import path from "node:path";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(name);
}

function option(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const rootDir = path.resolve(option("--root") || process.cwd());
const jsonMode = flag("--json");
const kitOnlyMode = flag("--kit-only");

// ── Manifest loading ──────────────────────────────────────────────────────────

const manifestPath = path.join(rootDir, "vc-manifest.json");

if (!fs.existsSync(manifestPath)) {
  console.error(`Error: vc-manifest.json not found at ${manifestPath}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (err) {
  console.error(`Error: Failed to parse vc-manifest.json: ${err.message}`);
  process.exit(1);
}

// ── Version check ─────────────────────────────────────────────────────────────

function semverGte(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true; // equal
}

const version = manifest.version || "0.0.0";
const useGlob = semverGte(version, "2.1.0");

// ── Glob resolution (v2.1+) ──────────────────────────────────────────────────

/**
 * Recursively walk a directory and return all file paths (including dotfiles).
 */
function walkDirAll(dirPath) {
  const files = [];
  const fullDir = path.join(rootDir, dirPath);
  if (!fs.existsSync(fullDir)) return files;

  function walk(current, rel) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullEntry = path.join(current, entry.name);
      const relEntry = path.join(rel, entry.name).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(fullEntry, relEntry);
      } else if (entry.isFile()) {
        files.push(relEntry);
      }
    }
  }

  walk(fullDir, dirPath);
  return files;
}

/**
 * Check if a filename matches a dotfile pattern like .??* (dot + 2+ chars).
 */
function isDotfile(filename) {
  return filename.startsWith(".") && filename.length >= 3;
}

/**
 * Resolve glob patterns to file paths within rootDir.
 * Returns sorted array of relative paths (files only, no directories).
 *
 * fs.globSync on Node 22 does NOT match dotfiles with ** patterns.
 * Dotfile-targeted patterns (containing /.??* or explicit dotfile names after /**)
 * are resolved by walking the directory tree instead.
 */
function toPosix(p) {
  return p.split(path.sep).join("/");
}

function resolveGlobPatterns(patterns) {
  const matches = new Set();

  for (const pattern of patterns) {
    // Detect dotfile-targeted patterns:
    //   "dir/**/.??*"           -> walk dir, include all dotfiles
    //   "dir/**/.gitkeep"       -> walk dir, include specific dotfile
    //   "dir/**/.env.example"   -> walk dir, include specific dotfile
    const dotfileMatch = pattern.match(/^(.+)\/\*\*\/(\..+)$/);
    if (dotfileMatch) {
      const baseDir = dotfileMatch[1];
      const dotPattern = dotfileMatch[2]; // e.g. ".??*", ".gitkeep", ".env.example"
      const allFiles = walkDirAll(baseDir);
      for (const f of allFiles) {
        const basename = path.basename(f);
        if (dotPattern === ".??*") {
          // Match any dotfile with 3+ char name
          if (isDotfile(basename)) matches.add(f);
        } else {
          // Exact dotfile name match
          if (basename === dotPattern) matches.add(f);
        }
      }
      continue;
    }

    let results;
    try {
      results = fs.globSync(pattern, { cwd: rootDir, exclude: [] });
    } catch {
      // Pattern returned no results or glob error — skip
      continue;
    }
    for (const p of results) {
      // fs.globSync returns "\\"-separated paths on Windows; the manifest, the merge/exclude
      // checks and .vc-installed-files all use "/". Without this, install.sh overwrote the
      // user's .claude/settings.json (merge match failed) and excludes never applied.
      matches.add(toPosix(p));
    }
  }

  // Filter to files only (globSync can return directories)
  const files = [];
  for (const p of matches) {
    const fullPath = path.join(rootDir, p);
    try {
      if (fs.statSync(fullPath).isFile()) {
        files.push(p);
      }
    } catch {
      // stat failed (broken symlink, etc.) — skip
    }
  }

  return files.sort();
}

/**
 * Check if a file path matches any of the exclude patterns.
 * Uses efficient string checks for the known patterns.
 */
function matchesExclude(filePath, excludePatterns) {
  for (const pattern of excludePatterns) {
    // Exact match
    if (filePath === pattern) return true;

    // Pattern ending with /** — directory prefix match
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3); // remove /**
      if (filePath.startsWith(prefix + "/") || filePath === prefix) return true;
    }

    // Pattern starting with **/ — suffix match
    if (pattern.startsWith("**/")) {
      const suffix = pattern.slice(3); // remove **/
      // suffix could be a dir pattern like .git/**
      if (suffix.endsWith("/**")) {
        const dirName = suffix.slice(0, -3); // e.g. ".git"
        if (
          filePath.includes("/" + dirName + "/") ||
          filePath.startsWith(dirName + "/")
        ) {
          return true;
        }
      } else if (suffix.includes("*")) {
        // suffix is a basename glob like *.test.js — match against path.basename
        const escaped = suffix.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        const re = new RegExp("^" + escaped + "$");
        if (re.test(path.basename(filePath))) return true;
      } else {
        // suffix is a plain file/dir name like .logs
        if (
          filePath.includes("/" + suffix + "/") ||
          filePath.startsWith(suffix + "/") ||
          filePath.endsWith("/" + suffix) ||
          filePath === suffix
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Check if a file path matches any of a set of glob patterns (for kitOnly matching).
 * Supports: exact files, dir/** patterns, and simple * wildcards.
 */
function matchesPatternList(filePath, patterns) {
  for (const pattern of patterns) {
    // Exact match
    if (filePath === pattern) return true;

    // dir/** pattern
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      if (filePath.startsWith(prefix + "/") || filePath === prefix) return true;
    }

    // Simple wildcard: e.g. README-preview*.html
    if (pattern.includes("*") && !pattern.includes("**")) {
      const regex = new RegExp(
        "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
      );
      if (regex.test(filePath)) return true;
    }
  }
  return false;
}

/**
 * Returns true if a manifest entry string is an exact file path (no glob metacharacters).
 */
function isExactPath(entry) {
  return !/[*?[\]{}]/.test(entry);
}

function resolveGlob() {
  const includePatterns = manifest.include || [];
  const excludePatterns = manifest.exclude || [];
  const kitOnlyPatterns = manifest.kitOnly || [];
  const mergeList = manifest.merge || [];
  const copyIfMissingList = manifest.copyIfMissing || [];
  const stripList = manifest.strip || [];
  const symlinkMap = manifest.symlinks || {};

  // 1. Resolve all include patterns
  const allFiles = resolveGlobPatterns(includePatterns);

  // 2. Post-filter excludes
  const filtered = allFiles.filter((f) => !matchesExclude(f, excludePatterns));

  // 3. Split into managed files and kit-only files
  const managedFiles = filtered.filter(
    (f) => !matchesPatternList(f, kitOnlyPatterns),
  );
  const kitOnlyFiles = resolveGlobPatterns(kitOnlyPatterns).filter(
    (f) => !matchesExclude(f, excludePatterns),
  );

  // 4. Resolve copyIfMissing patterns to actual file paths
  const copyIfMissingResolved = [];
  for (const pattern of copyIfMissingList) {
    let results;
    try {
      results = fs.globSync(pattern, { cwd: rootDir, exclude: [] });
    } catch {
      continue;
    }
    for (const p of results) {
      const fullPath = path.join(rootDir, p);
      try {
        if (fs.statSync(fullPath).isFile()) {
          copyIfMissingResolved.push(toPosix(p));
        }
      } catch {
        // skip
      }
    }
  }
  copyIfMissingResolved.sort();

  // Kit-integrity guard: collect exact declared paths that are absent on disk.
  // Only EXACT paths (no glob metacharacters) are checked — a glob matching zero
  // files is normal and is NOT flagged here.
  const missingDeclared = [...new Set(
    includePatterns
      .filter(isExactPath)
      .filter((p) => !fs.existsSync(path.join(rootDir, p)))
  )].sort();

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          files: managedFiles,
          kitOnly: kitOnlyFiles.sort(),
          merge: mergeList,
          copyIfMissing: copyIfMissingResolved,
          strip: stripList,
          symlinks: symlinkMap,
          legacyDeletions: manifest.legacyDeletions || [],
          ownedPaths: [...new Set([...managedFiles, ...(manifest.legacyDeletions || [])])].sort(),
          missingDeclared,
        },
        null,
        2,
      ),
    );
  } else if (kitOnlyMode) {
    console.log(kitOnlyFiles.sort().join("\n"));
  } else {
    console.log(managedFiles.join("\n"));
  }
}

// ── Legacy resolution (v2.0.x) ───────────────────────────────────────────────

// Final v2.0.4 deletions array — embedded for one-time migration
const LEGACY_DELETIONS = [
  ".claude/skills/add-worktree",
  ".claude/skills/agent-browser",
  ".claude/skills/audit-context",
  ".claude/skills/audit-plans",
  ".claude/skills/audit-vc",
  ".claude/skills/chrome-devtools",
  ".claude/skills/ck-autoresearch",
  ".claude/skills/ck-debug",
  ".claude/skills/ck-predict",
  ".claude/skills/ck-scenario",
  ".claude/skills/ck-security",
  ".claude/skills/context-engineering",
  ".claude/skills/docs",
  ".claude/skills/docs-seeker",
  ".claude/skills/frontend-design",
  ".claude/skills/generate-context",
  ".claude/skills/generate-plan",
  ".claude/skills/mcp-management",
  ".claude/skills/merge-worktree",
  ".claude/skills/preview",
  ".claude/skills/problem-solving",
  ".claude/skills/repomix",
  ".claude/skills/scout",
  ".claude/skills/sequential-thinking",
  ".claude/skills/team",
  ".claude/skills/tech-graph",
  ".claude/skills/watzup",
  ".claude/skills/web-testing",
  ".claude/skills/xia",
  ".claude/agents/code-reviewer.md",
  ".claude/agents/code-simplifier.md",
  ".claude/agents/debugger.md",
  ".claude/agents/execute-agent.md",
  ".claude/agents/fast-mode-agent.md",
  ".claude/agents/git-manager.md",
  ".claude/agents/innovate-agent.md",
  ".claude/agents/plan-agent.md",
  ".claude/agents/research-agent.md",
  ".claude/agents/tester.md",
  ".claude/agents/ui-ux-designer.md",
  ".claude/agents/update-process-agent.md",
  ".codex/agents/code-reviewer.toml",
  ".codex/agents/code-simplifier.toml",
  ".codex/agents/debugger.toml",
  ".codex/agents/execute-agent.toml",
  ".codex/agents/fast-mode-agent.toml",
  ".codex/agents/git-manager.toml",
  ".codex/agents/innovate-agent.toml",
  ".codex/agents/plan-agent.toml",
  ".codex/agents/research-agent.toml",
  ".codex/agents/tester.toml",
  ".codex/agents/ui-ux-designer.toml",
  ".codex/agents/update-process-agent.toml",
  ".claude/hooks/lib/ck-config-utils.cjs",
  ".codex/hooks/lib/ck-config-utils.cjs",
  ".claude/CLAUDE.md",
];

function walkDir(dirPath) {
  const files = [];
  const fullDir = path.join(rootDir, dirPath);
  if (!fs.existsSync(fullDir)) return files;

  function walk(current, rel) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullEntry = path.join(current, entry.name);
      const relEntry = path.join(rel, entry.name).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(fullEntry, relEntry);
      } else if (entry.isFile()) {
        files.push(relEntry);
      }
    }
  }

  walk(fullDir, dirPath);
  return files;
}

function resolveLegacy() {
  const managed = manifest.managed || [];
  const managedDirs = manifest.managedDirs || [];
  const seedsDir = manifest.seedsDir || "";
  const symlinkMap = manifest.symlinks || {};
  const deletions = manifest.deletions || [];

  const allFiles = new Set();

  // Individual managed files
  for (const f of managed) {
    const fullPath = path.join(rootDir, f);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      allFiles.add(f);
    }
  }

  // Managed directories (recursive)
  for (const dir of managedDirs) {
    for (const f of walkDir(dir)) {
      allFiles.add(f);
    }
  }

  // Seeds directory
  if (seedsDir) {
    for (const f of walkDir(seedsDir)) {
      allFiles.add(f);
    }
  }

  const sorted = [...allFiles].sort();

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          files: sorted,
          kitOnly: [],
          merge: [],
          copyIfMissing: [],
          strip: [],
          symlinks: symlinkMap,
          deletions: deletions,
          legacyDeletions: LEGACY_DELETIONS,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(sorted.join("\n"));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (useGlob) {
  resolveGlob();
} else {
  resolveLegacy();
}

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

let root;
try {
  root = execSync('git rev-parse --show-toplevel', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
} catch {
  // Not a git repository — fall back to process.cwd() so the script still works on new projects.
  root = process.cwd();
}
export { root };

export function abs(relPath) {
  return path.join(root, relPath);
}

export function exists(relPath) {
  return fs.existsSync(abs(relPath));
}

// Normalize CRLF -> LF at the single read point. On Windows checkouts with
// core.autocrlf=true the working tree has \r\n, which breaks every LF-only
// regex downstream (frontmatter delimiters, block comparisons).
export function read(relPath) {
  return fs.readFileSync(abs(relPath), "utf8").replace(/\r\n/g, "\n");
}

export function parseFrontmatterText(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields = {};
  const keys = [];
  const lines = match[1].split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const item = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) continue;
    const [, key, rawValue] = item;
    keys.push(key);

    if (rawValue === ">-" || rawValue === "|" || rawValue === ">") {
      const blockLines = [];
      let cursor = index + 1;
      while (cursor < lines.length && /^  /.test(lines[cursor])) {
        blockLines.push(lines[cursor].replace(/^  /, ""));
        cursor += 1;
      }
      fields[key] = blockLines.join(" ").trim();
      index = cursor - 1;
      continue;
    }

    fields[key] = rawValue.replace(/^["']|["']$/g, "");
  }
  return { fields, keys };
}

export function parseFrontmatter(file) {
  return parseFrontmatterText(read(file));
}

export function loadRoutingPolicy() {
  const policyPath = ".claude/skills/vc-audit-context/references/skill-routing-policy.json";
  if (!exists(policyPath)) {
    return {
      path: policyPath,
      canonicalRoutingSurfaces: [],
      allowlistedSkills: {},
    };
  }
  const parsed = JSON.parse(read(policyPath));
  return {
    path: policyPath,
    canonicalRoutingSurfaces: Array.isArray(parsed.canonicalRoutingSurfaces)
      ? parsed.canonicalRoutingSurfaces
      : [],
    allowlistedSkills: parsed.allowlistedSkills && typeof parsed.allowlistedSkills === "object"
      ? parsed.allowlistedSkills
      : {},
  };
}

export function listSkillDirs() {
  const skillsDir = abs(".claude/skills");
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function loadSkillInventory() {
  const policy = loadRoutingPolicy();
  const surfaceTexts = new Map();
  for (const relPath of policy.canonicalRoutingSurfaces) {
    if (exists(relPath)) surfaceTexts.set(relPath, read(relPath));
  }

  return listSkillDirs().map((skill) => {
    const skillPath = `.claude/skills/${skill}/SKILL.md`;
    const text = exists(skillPath) ? read(skillPath) : "";
    const parsed = exists(skillPath) ? parseFrontmatter(skillPath) : null;
    const fields = parsed?.fields || {};
    const aliases = new Set([skill]);
    if (fields.name) aliases.add(fields.name);
    if (fields.name?.startsWith("ck:")) aliases.add(fields.name.slice(3));

    const routedFrom = [];
    for (const [surface, content] of surfaceTexts.entries()) {
      if ([...aliases].some((alias) => content.includes(`\`${alias}\``) || content.includes(alias))) {
        routedFrom.push(surface);
      }
    }

    return {
      folder: skill,
      path: skillPath,
      text,
      frontmatter: fields,
      frontmatterKeys: parsed?.keys || [],
      aliases: [...aliases],
      allowlisted: Object.prototype.hasOwnProperty.call(policy.allowlistedSkills, skill),
      allowlistReason: policy.allowlistedSkills[skill] || null,
      routedFrom,
    };
  });
}

export function normalizeSkillName(name) {
  return name
    .toLowerCase()
    .replace(/^ck:/, "")
    .replace(/[^a-z0-9]+/g, "");
}

export function levenshtein(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let row = 0; row <= a.length; row += 1) matrix[row][0] = row;
  for (let col = 0; col <= b.length; col += 1) matrix[0][col] = col;
  for (let row = 1; row <= a.length; row += 1) {
    for (let col = 1; col <= b.length; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

export function extractRelativeReferences(text) {
  const patterns = [
    /`((?:references|scripts|templates|assets)\/[^`\s)]+)`/g,
    /\((?:\.\/)?((?:references|scripts|templates|assets)\/[^)\s]+)\)/g,
  ];
  const found = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      found.add(match[1]);
    }
  }
  return [...found].sort();
}

export function extractSkillMentions(text, aliasesBySkill) {
  const mentioned = new Set();
  for (const [skill, aliases] of aliasesBySkill.entries()) {
    if ([...aliases].some((alias) => text.includes(`\`${alias}\``))) {
      mentioned.add(skill);
    }
  }
  return [...mentioned].sort();
}

// Dirs that a copy may legitimately lack or hold (local installs / caches).
const MIRROR_IGNORED_DIRS = new Set(["node_modules", "__pycache__", ".venv"]);

function listFilesRecursive(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!MIRROR_IGNORED_DIRS.has(entry.name)) listFilesRecursive(path.join(dir, entry.name), base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, path.join(dir, entry.name)).split(path.sep).join("/"));
    }
  }
  return out;
}

function sameContent(a, b) {
  const bufA = fs.readFileSync(a);
  const bufB = fs.readFileSync(b);
  if (bufA.equals(bufB)) return true;
  // A copy made on a core.autocrlf checkout may differ only in line endings.
  return bufA.toString("utf8").replace(/\r\n/g, "\n") === bufB.toString("utf8").replace(/\r\n/g, "\n");
}

/**
 * Inspect `.agents/skills` (Codex skill discovery) against `.claude/skills`.
 *
 * The kit ships it as a symlink, but Windows without Developer Mode cannot create one:
 * the installer / vc-update then keep a real-directory COPY, and a plain git checkout
 * with core.symlinks=false writes a small text file holding the link target instead.
 *
 * @returns {{
 *   kind: "missing" | "symlink" | "wrong-symlink" | "placeholder-file" | "copy",
 *   target?: string,                 // link target text (placeholder-file)
 *   missing?: string[],              // copy: files in .claude/skills absent from the copy
 *   changed?: string[],              // copy: files whose content differs
 *   extra?: string[],                // copy: files only in the copy (stale leftovers)
 * }}
 */
export function inspectAgentsSkillsMirror(rootDir = root) {
  const source = path.join(rootDir, ".claude/skills");
  const mirror = path.join(rootDir, ".agents/skills");

  let stat;
  try {
    stat = fs.lstatSync(mirror);
  } catch {
    return { kind: "missing" };
  }

  // Symlinks and Windows junctions both resolve through realpath.
  const resolvesToSource = fs.existsSync(source)
    && fs.existsSync(mirror)
    && fs.realpathSync(mirror) === fs.realpathSync(source);
  if (resolvesToSource) return { kind: "symlink" };
  if (stat.isSymbolicLink()) return { kind: "wrong-symlink" };
  if (stat.isFile()) {
    return { kind: "placeholder-file", target: fs.readFileSync(mirror, "utf8").trim() };
  }

  const sourceFiles = fs.existsSync(source) ? new Set(listFilesRecursive(source)) : new Set();
  const mirrorFiles = new Set(listFilesRecursive(mirror));
  const missing = [];
  const changed = [];
  for (const rel of sourceFiles) {
    if (!mirrorFiles.has(rel)) missing.push(rel);
    else if (!sameContent(path.join(source, rel), path.join(mirror, rel))) changed.push(rel);
  }
  const extra = [...mirrorFiles].filter((rel) => !sourceFiles.has(rel));
  return { kind: "copy", missing: missing.sort(), changed: changed.sort(), extra: extra.sort() };
}

/**
 * Turn an inspectAgentsSkillsMirror() result into a validator verdict.
 * Shared by validate-context-discovery.mjs and validate-skills.mjs so both agree.
 *
 * @returns {{ level: "ok" | "warn" | "fail", message?: string }}
 */
export function classifyAgentsSkillsMirror(result) {
  const sample = (list) => `${list.slice(0, 3).join(", ")}${list.length > 3 ? ", …" : ""} (${list.length})`;
  const resync = "re-sync with: cp -r .claude/skills/. .agents/skills/";

  switch (result.kind) {
    case "symlink":
      return { level: "ok" };
    case "missing":
      return { level: "fail", message: ".agents/skills missing" };
    case "wrong-symlink":
      return { level: "fail", message: ".agents/skills does not resolve to .claude/skills" };
    case "placeholder-file":
      // git with core.symlinks=false wrote the link target as a text file: Codex sees no skills.
      return {
        level: "fail",
        message: `.agents/skills is a plain file holding "${result.target}" (symlink checked out without symlink support) — enable Developer Mode + git config core.symlinks true and re-checkout, or replace it with a copy: rm .agents/skills && mkdir .agents/skills && ${resync.replace("re-sync with: ", "")}`,
      };
    case "copy": {
      // Missing or changed files mean Codex runs stale skills: that is a real defect.
      const stale = [...result.missing, ...result.changed];
      if (stale.length > 0) {
        const parts = [];
        if (result.missing.length) parts.push(`missing ${sample(result.missing)}`);
        if (result.changed.length) parts.push(`changed ${sample(result.changed)}`);
        return { level: "fail", message: `.agents/skills is a stale copy of .claude/skills — ${parts.join("; ")}; ${resync}` };
      }
      // Leftovers are expected: `cp -r` never deletes files of removed skills. Harmless but noisy.
      if (result.extra.length > 0) {
        return {
          level: "warn",
          message: `.agents/skills copy has files no longer in .claude/skills: ${sample(result.extra)} — delete them or rebuild the copy`,
        };
      }
      // Identical copy = the supported Windows fallback (no Developer Mode); nothing to report.
      return { level: "ok" };
    }
    default:
      return { level: "fail", message: `.agents/skills in unknown state: ${result.kind}` };
  }
}

export function writeJsonFile(relPath, data) {
  const target = abs(relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
}

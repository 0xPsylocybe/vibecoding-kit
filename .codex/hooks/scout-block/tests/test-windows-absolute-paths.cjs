#!/usr/bin/env node
/**
 * test-windows-absolute-paths.cjs - Absolute / Windows path handling
 *
 * Regression for: on win32 the vendored 'ignore' lib threw
 *   "path should be a `path.relative()`d string, but got "C:/Users/.../file""
 * and the hook failed open (exit 0), so nothing was ever blocked.
 * Also covers: folders ABOVE the project root must not trigger blocks
 * (a project living under .../build/app must not be fully blocked).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMatcher, matchPath, DEFAULT_PATTERNS } = require('../pattern-matcher.cjs');
const { checkScoutBlock, toProjectRelativePath } = require('../../lib/scout-checker.cjs');

let passed = 0;
let failed = 0;

function check(desc, fn, expected) {
  let actual;
  try {
    actual = fn();
  } catch (e) {
    actual = `THREW: ${e.message}`;
  }
  if (actual === expected) {
    console.log(`\x1b[32m✓\x1b[0m ${desc}`);
    passed++;
  } else {
    console.log(`\x1b[31m✗\x1b[0m ${desc}: expected ${expected}, got ${actual}`);
    failed++;
  }
}

// --- matchPath never throws on drive-letter paths ---------------------------
const matcher = createMatcher(DEFAULT_PATTERNS);
check('drive path into node_modules is blocked',
  () => matchPath(matcher, 'C:/Users/dev/proj/node_modules/x/index.js').blocked, true);
check('drive path with backslashes is blocked',
  () => matchPath(matcher, 'C:\\Users\\dev\\proj\\.git\\HEAD').blocked, true);
check('drive path to source file is allowed',
  () => matchPath(matcher, 'C:/Users/dev/proj/src/app.js').blocked, false);
check('bare drive is allowed (no throw)',
  () => matchPath(matcher, 'C:').blocked, false);

// --- odd relative inputs seen in real hook logs (each used to crash) --------
for (const odd of ['.', '..', '././/././/|from ', './/./']) {
  check(`odd input ${JSON.stringify(odd)} does not throw`, () => matchPath(matcher, odd).blocked, false);
}
check('repeated ./ before node_modules is still blocked',
  () => matchPath(matcher, '././/node_modules/x').blocked, true);
check('inner .. resolving into node_modules is blocked',
  () => matchPath(matcher, 'src/../node_modules/x').blocked, true);

// --- full checkScoutBlock flow with a real project root ---------------------
// Root deliberately lives under a "build" folder: before the fix every file in
// it was blocked because the absolute path contained "/build/".
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-win-'));
const root = path.join(tmp, 'build', 'app');
fs.mkdirSync(path.join(root, '.git'), { recursive: true });

const run = (filePath) => checkScoutBlock({
  toolName: 'Read',
  toolInput: { file_path: filePath },
  options: { cwd: root, ckignorePath: path.join(tmp, 'missing.vcignore'), checkBroadPatterns: false }
}).blocked;

check('absolute node_modules inside root is blocked',
  () => run(path.join(root, 'node_modules', 'lib', 'a.js')), true);
check('absolute forward-slash path inside root is blocked',
  () => run(path.join(root, 'dist', 'bundle.js').replace(/\\/g, '/')), true);
check('source file under a "build" ancestor is allowed',
  () => run(path.join(root, 'src', 'main.py')), false);
check('project root itself is allowed',
  () => run(root), false);
check('path outside root still evaluated (node_modules blocked)',
  () => run(path.join(tmp, 'other', 'node_modules', 'x.js')), true);

if (process.platform === 'win32') {
  // Git Bash style "/c/Users/..." must resolve to the same project path
  const msys = root.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  check('Git Bash style path is relativized',
    () => toProjectRelativePath(`${msys}/src/a.js`, root), 'src/a.js');
  check('Git Bash style node_modules is blocked',
    () => run(`${msys}/node_modules/a.js`), true);
}

check('relative paths are returned unchanged',
  () => toProjectRelativePath('src/a.js', root), 'src/a.js');

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

/**
 * Tests for privacy-checker Bash command scanning
 * Run: node .claude/hooks/lib/__tests__/privacy-checker.test.cjs
 *
 * Regression: any command containing the text ".env." was blocked, including JS
 * property access such as `node -e "console.log(process.env.HOME)"`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkPrivacy, extractEnvTokens } = require('../privacy-checker.cjs');

let passed = 0;
let failed = 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-'));
const configDir = path.join(tmp, '.claude'); // no .vc.json -> block enabled, no allowlist

function bashBlocked(command) {
  return checkPrivacy({ toolName: 'Bash', toolInput: { command }, options: { configDir } }).blocked;
}

function check(desc, actual, expected) {
  if (actual === expected) {
    console.log(`\x1b[32m✓\x1b[0m ${desc}`);
    passed++;
  } else {
    console.log(`\x1b[31m✗\x1b[0m ${desc}: expected ${expected}, got ${actual}`);
    failed++;
  }
}

// Must stay blocked (real secret files)
const blocked = [
  'cat .env',
  'cat .env.local',
  'cat ./config/.env.production',
  'cat /app/.env',
  'cat prod.env',
  'FILE=.env.local; cat $FILE',
  'echo $(cat .env)',
  'grep KEY "path with/.env"',
  'source .env && npm start',
];
for (const cmd of blocked) check(`blocked: ${cmd}`, bashBlocked(cmd), true);

// Must be allowed (property access, not files)
const allowed = [
  'node -e "console.log(process.env.HOME)"',
  'node -e "const s=require(\'x\'); console.log(s.env.X)"',
  "node -e \"console.log(process.env['PATH'])\"",
  'node -e "console.log(process.env)"',
  'cat .env.example',
  'ls src',
];
for (const cmd of allowed) check(`allowed: ${cmd}`, bashBlocked(cmd), false);

// A real file shaped like property access stays protected
const cwd = process.cwd();
try {
  process.chdir(tmp);
  fs.writeFileSync(path.join(tmp, 'config.env.local'), 'SECRET=1');
  check('existing config.env.local is still extracted',
    extractEnvTokens('cat config.env.local', tmp).includes('.env.local'), true);
  check('existing config.env.local is still blocked', bashBlocked('cat config.env.local'), true);
} finally {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

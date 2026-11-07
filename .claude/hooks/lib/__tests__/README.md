# Hook Library Tests

Unit tests for the shared hook libraries in `.claude/hooks/lib/`.

## Files

- `context-builder.test.cjs` - session context assembly
- `privacy-checker.test.cjs` - privacy-block path extraction (real `.env` files blocked, `process.env.X` allowed)
- `project-detector.test.cjs` - project / git / Python detection helpers
- `statusline.test.cjs` - helpers and parser logic shared with the statusline (colors, context bar, transcript parsing, usage cache rendering)
- `transcript-parser-signals.test.cjs` - run-record signal extraction in `transcript-parser.cjs` (phaseCompletes, agentSpawns, teamCreates, taskCreates, sendMessages, writes, controlTokens; one global `_signalIndex`)
- `usage-limits-cache.test.cjs` - usage quota cache helper
- `vc-config-utils.test.cjs` - config, path sanitizing, git root and plan resolution
- `statusline-suite.cjs` - aggregate runner for the statusline-related suites

The former `statusline-integration` / `statusline-scenarios` suites were removed: they exercised a
`.claude/statusline.cjs` entrypoint that the kit does not ship.

## Running Tests

All kit tests (hooks, skill script tests, e2e) on any OS — this is what CI runs on Windows and Debian:

```bash
node .github/scripts/run-kit-tests.mjs
```

A single suite:

```bash
node .claude/hooks/lib/__tests__/vc-config-utils.test.cjs
```

## Portability Rules

Tests run on Windows (Git Bash) and Debian in CI, so:

- use `os.tmpdir()` and `path.join`, never a literal `/tmp`;
- compare paths by equivalence (`path.resolve`), not as POSIX strings;
- do not rely on POSIX `echo` semantics in `execSync` (Windows uses `cmd.exe`); prefer `node -p`.

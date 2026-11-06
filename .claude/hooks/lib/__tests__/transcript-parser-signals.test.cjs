/**
 * Tests for additive signal extraction in transcript-parser.cjs (Phase 2 — vc-runtime-harness).
 *
 * Covers fixtures F1–F15 from the phase-02 plan: phaseCompletes (spaced/unspaced, 3 sources,
 * ordering), teamCreates, taskCreates (additive vs legacy todos[]), sendMessages, writes,
 * agentSpawns, cross-signal monotonic index, backward-compat, and the A0 direct-call lazy-init.
 *
 * Run: node .claude/hooks/lib/__tests__/transcript-parser-signals.test.cjs
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  parseTranscript,
  processEntry
} = require('../transcript-parser.cjs');

let passed = 0;
let failed = 0;

function assertEquals(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, msg = '') {
  if (!value) throw new Error(msg || 'Expected truthy value');
}

function assertDeepEquals(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg}\n  Expected: ${e}\n  Actual: ${a}`);
  }
}

// parseTranscript is async; the hand-rolled harness here collects async tests
// and runs them sequentially in the runner at the bottom of this file.
const asyncTests = [];
function asyncTest(name, fn) {
  asyncTests.push({ name, fn });
}

async function parse(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-parser-signals-'));
  const file = path.join(dir, 'stream.jsonl');
  const jsonl = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(file, jsonl, 'utf8');
  try {
    return await parseTranscript(file);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const assistantText = text => ({ message: { role: 'assistant', content: [{ type: 'text', text }] } });
const userText = text => ({ message: { role: 'user', content: [{ type: 'text', text }] } });

// F1 — assistant text, spaced marker
asyncTest('F1: assistant text spaced "PHASE_COMPLETE: PLAN"', async () => {
  const r = await parse([assistantText('Done. PHASE_COMPLETE: PLAN')]);
  assertEquals(r.phaseCompletes.length, 1, 'one phaseComplete');
  assertDeepEquals(r.phaseCompletes[0], {
    phase: 'PLAN', source: 'assistant', raw: 'PHASE_COMPLETE: PLAN', index: 0,
    agentId: null
  }, 'F1 element');
});

// F2 — assistant text, unspaced marker
asyncTest('F2: assistant text unspaced "PHASE_COMPLETE:PLAN"', async () => {
  const r = await parse([assistantText('PHASE_COMPLETE:PLAN now')]);
  assertEquals(r.phaseCompletes.length, 1, 'one phaseComplete');
  assertEquals(r.phaseCompletes[0].phase, 'PLAN', 'normalized phase');
  assertEquals(r.phaseCompletes[0].raw, 'PHASE_COMPLETE:PLAN', 'raw preserves unspaced');
  assertEquals(r.phaseCompletes[0].source, 'assistant', 'assistant source');
});

// F3 — user text marker
asyncTest('F3: user text block carries marker → source "user"', async () => {
  const r = await parse([userText('please confirm PHASE_COMPLETE: RESEARCH')]);
  assertEquals(r.phaseCompletes.length, 1, 'one phaseComplete');
  assertEquals(r.phaseCompletes[0].source, 'user', 'user source');
  assertEquals(r.phaseCompletes[0].phase, 'RESEARCH', 'phase');
});

// F4 — tool_result string content marker
asyncTest('F4: tool_result string content → source "tool_result"', async () => {
  const r = await parse([{
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'log: PHASE_COMPLETE: EVL' }]
    }
  }]);
  assertEquals(r.phaseCompletes.length, 1, 'one phaseComplete');
  assertEquals(r.phaseCompletes[0].source, 'tool_result', 'tool_result source');
  assertEquals(r.phaseCompletes[0].phase, 'EVL', 'phase');
});

// F5 — tool_result array content marker
asyncTest('F5: tool_result array {type:text} content → source "tool_result"', async () => {
  const r = await parse([{
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_b',
        content: [{ type: 'text', text: 'output\nPHASE_COMPLETE:SPEC' }]
      }]
    }
  }]);
  assertEquals(r.phaseCompletes.length, 1, 'one phaseComplete');
  assertEquals(r.phaseCompletes[0].source, 'tool_result', 'tool_result source');
  assertEquals(r.phaseCompletes[0].phase, 'SPEC', 'phase');
});

// F6 — multiple ordered markers across mixed sources, strictly increasing index
asyncTest('F6: ordered RESEARCH→SPEC→INNOVATE across mixed sources, monotonic index', async () => {
  const r = await parse([
    assistantText('PHASE_COMPLETE: RESEARCH'),
    userText('PHASE_COMPLETE:SPEC'),
    {
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_c', content: 'PHASE_COMPLETE: INNOVATE' }]
      }
    }
  ]);
  assertEquals(r.phaseCompletes.length, 3, 'three markers');
  assertEquals(r.phaseCompletes[0].phase, 'RESEARCH', 'first');
  assertEquals(r.phaseCompletes[1].phase, 'SPEC', 'second');
  assertEquals(r.phaseCompletes[2].phase, 'INNOVATE', 'third');
  assertEquals(r.phaseCompletes[0].source, 'assistant', 'first source');
  assertEquals(r.phaseCompletes[1].source, 'user', 'second source');
  assertEquals(r.phaseCompletes[2].source, 'tool_result', 'third source');
  assertEquals(r.phaseCompletes[0].index, 0, 'index 0');
  // chatMessages share the global _signalIndex: each text block also takes one index
  // (RESEARCH 0, its chatMessage 1, SPEC 2, its chatMessage 3, INNOVATE 4 from tool_result).
  assertEquals(r.phaseCompletes[1].index, 2, 'index 2');
  assertEquals(r.phaseCompletes[2].index, 4, 'index 4');
});

// F7 — TeamCreate tool_use
asyncTest('F7: TeamCreate tool_use → teamCreates[0] {team_name, id, index}', async () => {
  const r = await parse([{
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_y', name: 'TeamCreate', input: { team_name: 'vc-rh-plan' } }]
    }
  }]);
  assertEquals(r.teamCreates.length, 1, 'one teamCreate');
  assertDeepEquals(r.teamCreates[0], { team_name: 'vc-rh-plan', id: 'toolu_y', index: 0, agentId: null }, 'F7 element');
});

// F7b — TaskCreate tool_use: taskCreates populated AND legacy todos[] still populated
asyncTest('F7b: TaskCreate → taskCreates[0] {id,index} AND legacy todos[] still populated', async () => {
  const r = await parse([{
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_t', name: 'TaskCreate', input: { subject: 'do the thing' } }]
    }
  }]);
  assertEquals(r.taskCreates.length, 1, 'one taskCreate');
  assertDeepEquals(r.taskCreates[0], { id: 'toolu_t', index: 0, agentId: null }, 'F7b taskCreates element');
  // legacy todos[] untouched
  assertEquals(r.todos.length, 1, 'legacy todos still populated');
  assertEquals(r.todos[0].content, 'do the thing', 'legacy todo content preserved');
  assertEquals(r.todos[0].id, 'toolu_t', 'legacy todo id preserved');
});

// F8 — SendMessage with summary
asyncTest('F8: SendMessage (with summary) → sendMessages[0] {to,summary,id,index}', async () => {
  const r = await parse([{
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use', id: 'toolu_z', name: 'SendMessage',
        input: { to: 'researcher', summary: 'assign task 1' }
      }]
    }
  }]);
  assertEquals(r.sendMessages.length, 1, 'one sendMessage');
  assertDeepEquals(r.sendMessages[0], {
    to: 'researcher', summary: 'assign task 1', id: 'toolu_z', index: 0,
    agentId: null
  }, 'F8 element');
});

// F9 — SendMessage with string message, no summary → summary null
asyncTest('F9: SendMessage (string message, no summary) → summary null', async () => {
  const r = await parse([{
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use', id: 'toolu_z2', name: 'SendMessage',
        input: { to: 'researcher', message: 'hello there' }
      }]
    }
  }]);
  assertEquals(r.sendMessages.length, 1, 'one sendMessage');
  assertEquals(r.sendMessages[0].summary, null, 'summary null when absent');
  assertEquals(r.sendMessages[0].to, 'researcher', 'to captured');
  assertEquals(r.sendMessages[0].id, 'toolu_z2', 'id captured');
});

// F10 — Write tool_use → writes[0] via reused extractTarget
asyncTest('F10: Write tool_use → writes[0] {file_path,id,index} via extractTarget', async () => {
  const r = await parse([{
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use', id: 'toolu_w', name: 'Write',
        input: { file_path: 'process/x/X_SPEC_09-06-26.md', content: 'hi' }
      }]
    }
  }]);
  assertEquals(r.writes.length, 1, 'one write');
  assertDeepEquals(r.writes[0], {
    file_path: 'process/x/X_SPEC_09-06-26.md', id: 'toolu_w', index: 0,
    agentId: null
  }, 'F10 element');
  // Write still registers in .tools (unchanged behavior)
  assertEquals(r.tools.length, 1, 'Write still in tools[]');
  assertEquals(r.tools[0].name, 'Write', 'tools[0] is Write');
});

// F11 — Task tool_use → agentSpawns[0] AND legacy agents[] unchanged
asyncTest('F11: Task → agentSpawns[0] {subagent_type,id,index} AND legacy agents[] populated', async () => {
  const r = await parse([{
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use', id: 'toolu_x', name: 'Task',
        input: { subagent_type: 'vc-research-agent', description: 'research' }
      }]
    }
  }]);
  assertEquals(r.agentSpawns.length, 1, 'one agentSpawn');
  assertDeepEquals(r.agentSpawns[0], {
    subagent_type: 'vc-research-agent', model: null, id: 'toolu_x', index: 0,
    agentId: null
  }, 'F11 agentSpawns element');
  // legacy agents[] map view unchanged
  assertEquals(r.agents.length, 1, 'legacy agents[] populated');
  assertEquals(r.agents[0].type, 'vc-research-agent', 'legacy agents[0].type');
  assertEquals(r.agents[0].id, 'toolu_x', 'legacy agents[0].id');
});

// F11b — LIVE spawn tool name `Agent` (current Claude Code v2.x) → agentSpawns[0].
// Regression lock for the live-assert discovery (Loop-18): the live CLI emits subagent
// spawns as `Agent`, not the older `Task`. A real spawn was invisible under a Task-only
// match. Asserts BOTH names produce identical agentSpawns shape, incl. the `model` field.
asyncTest('F11b: Agent (live tool name) → agentSpawns[0] with model captured', async () => {
  const r = await parse([{
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use', id: 'toolu_ag', name: 'Agent',
        input: { subagent_type: 'vc-research-agent', model: 'sonnet', description: 'research' }
      }]
    }
  }]);
  assertEquals(r.agentSpawns.length, 1, 'one agentSpawn via Agent name');
  assertDeepEquals(r.agentSpawns[0], {
    subagent_type: 'vc-research-agent', model: 'sonnet', id: 'toolu_ag', index: 0,
    agentId: null
  }, 'F11b agentSpawns element (model captured)');
  assertEquals(r.agents[0].type, 'vc-research-agent', 'F11b legacy agents[0].type');
});

// F12 — cross-signal ordering: Task → Write → SendMessage → PHASE_COMPLETE (0,1,2,3)
asyncTest('F12: cross-signal shared monotonic index sequence 0,1,2,3', async () => {
  const r = await parse([
    { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { subagent_type: 'vc-plan-agent' } }] } },
    { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'a.md' } }] } },
    { message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'SendMessage', input: { to: 'x', summary: 'y' } }] } },
    assistantText('PHASE_COMPLETE: EXECUTE')
  ]);
  assertEquals(r.agentSpawns[0].index, 0, 'Task index 0');
  assertEquals(r.writes[0].index, 1, 'Write index 1');
  assertEquals(r.sendMessages[0].index, 2, 'SendMessage index 2');
  assertEquals(r.phaseCompletes[0].index, 3, 'phaseComplete index 3');
});

// F13 — backward-compat: tools+agents+todos with NO new signals; new arrays []; no _signalIndex
asyncTest('F13: backward-compat — existing fields intact; new arrays []; no _signalIndex key', async () => {
  const r = await parse([
    { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }] } },
    { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Task', input: { subagent_type: 'vc-tester' } }] } },
    { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tc1', name: 'TaskCreate', input: { subject: 'task one' } }] } }
  ]);
  // existing fields populated as before
  assertEquals(r.tools.length, 1, 'tools has Bash');
  assertEquals(r.agents.length, 1, 'agents has Task');
  assertEquals(r.todos.length, 1, 'todos has TaskCreate');
  // no PHASE_COMPLETE / TeamCreate / SendMessage / Write present → those arrays empty
  assertEquals(r.phaseCompletes.length, 0, 'phaseCompletes empty');
  assertEquals(r.teamCreates.length, 0, 'teamCreates empty');
  assertEquals(r.sendMessages.length, 0, 'sendMessages empty');
  assertEquals(r.writes.length, 0, 'writes empty');
  // _signalIndex must NOT leak
  assertTrue(!Object.prototype.hasOwnProperty.call(r, '_signalIndex'), 'no _signalIndex key leaked');
});

// F14 — empty / non-existent / null path → new arrays present as [], no throw, no _signalIndex
asyncTest('F14: non-existent path → new arrays [], no throw, no _signalIndex', async () => {
  const r = await parseTranscript('/tmp/does-not-exist-rh-' + Date.now() + '.jsonl');
  assertTrue(Array.isArray(r.phaseCompletes) && r.phaseCompletes.length === 0, 'phaseCompletes []');
  assertTrue(Array.isArray(r.agentSpawns) && r.agentSpawns.length === 0, 'agentSpawns []');
  assertTrue(Array.isArray(r.teamCreates) && r.teamCreates.length === 0, 'teamCreates []');
  assertTrue(Array.isArray(r.taskCreates) && r.taskCreates.length === 0, 'taskCreates []');
  assertTrue(Array.isArray(r.sendMessages) && r.sendMessages.length === 0, 'sendMessages []');
  assertTrue(Array.isArray(r.writes) && r.writes.length === 0, 'writes []');
  assertTrue(!Object.prototype.hasOwnProperty.call(r, '_signalIndex'), 'no _signalIndex on early-return');

  const rNull = await parseTranscript(null);
  assertTrue(Array.isArray(rNull.writes) && rNull.writes.length === 0, 'null path → writes []');
  assertTrue(!Object.prototype.hasOwnProperty.call(rNull, '_signalIndex'), 'null path → no _signalIndex');
});

// F15 — (PVL C-1) direct processEntry call with bare result={sessionStart:null}
asyncTest('F15: direct processEntry call (bare result) → no throw; clean numeric index', async () => {
  const toolMap = new Map();
  const agentMap = new Map();
  const latestTodos = [];
  const result = { sessionStart: null }; // NO pre-init — exactly like statusline.test.cjs

  // Task block AND a PHASE_COMPLETE text block in one entry.
  processEntry({
    timestamp: '2026-06-09T12:00:00Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'PHASE_COMPLETE: EXECUTE' },
        { type: 'tool_use', id: 'd1', name: 'Task', input: { subagent_type: 'vc-execute-agent' } }
      ]
    }
  }, toolMap, agentMap, latestTodos, result);

  // Lazy-init must have created the arrays and stamped clean numeric indices.
  assertTrue(Array.isArray(result.phaseCompletes), 'phaseCompletes lazy-init array');
  assertEquals(result.phaseCompletes.length, 1, 'one phaseComplete via direct call');
  assertEquals(result.phaseCompletes[0].index, 0, 'index is clean 0, not NaN');
  assertTrue(!Number.isNaN(result.phaseCompletes[0].index), 'index not NaN');
  assertEquals(result.agentSpawns.length, 1, 'one agentSpawn via direct call');
  // index monotonic across both signals (text scanned before tool_use in loop order)
  // phaseComplete 0, its chatMessage 1 (shared _signalIndex), then the agentSpawn
  assertEquals(result.agentSpawns[0].index, 2, 'agentSpawn index 2 (after phaseComplete 0 + chatMessage 1)');
});

// F16 — Bash tool_use → bashCommands[0] {command,id,index}; tools[] still populated;
//        shared monotonic index across Bash + other signals.
asyncTest('F16: Bash tool_use → bashCommands[0] {command,id,index} AND tools[] populated', async () => {
  const r = await parse([
    { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'bsh1', name: 'Bash', input: { command: 'node .claude/skills/vc-audit-vc/scripts/validate-skills.mjs' } }] } },
    { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tsk1', name: 'Task', input: { subagent_type: 'vc-tester' } }] } }
  ]);
  assertEquals(r.bashCommands.length, 1, 'one bashCommand');
  assertDeepEquals(r.bashCommands[0], {
    command: 'node .claude/skills/vc-audit-vc/scripts/validate-skills.mjs', id: 'bsh1', index: 0,
    agentId: null
  }, 'F16 bashCommands element');
  // legacy tools[] map view still captures Bash
  assertEquals(r.tools.length, 1, 'legacy tools[] populated with Bash');
  // monotonic index continues across signal types (Task spawn after Bash)
  assertEquals(r.agentSpawns[0].index, 1, 'agentSpawn index 1 (after bash 0)');
});

// F17 — Bash with missing command field → command null, no throw
asyncTest('F17: Bash tool_use missing command → command null', async () => {
  const r = await parse([
    { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'bsh2', name: 'Bash', input: {} }] } }
  ]);
  assertEquals(r.bashCommands.length, 1, 'one bashCommand');
  assertEquals(r.bashCommands[0].command, null, 'command null when absent');
});

// F18 — controlTokens: SUPPLEMENT_APPLIED (assistant text), qualifier null when lowercase tail
asyncTest('F18: SUPPLEMENT_APPLIED → controlTokens[0] {token,qualifier:null,source,index}', async () => {
  const r = await parse([assistantText('SUPPLEMENT_APPLIED: plan.md — 2 gaps addressed')]);
  assertEquals(r.controlTokens.length, 1, 'one controlToken');
  assertEquals(r.controlTokens[0].token, 'SUPPLEMENT_APPLIED', 'token');
  assertEquals(r.controlTokens[0].qualifier, null, 'lowercase tail → qualifier null');
  assertEquals(r.controlTokens[0].source, 'assistant', 'source');
  assertEquals(r.controlTokens[0].index, 0, 'shared index 0');
});

// F19 — controlTokens: PHASE_SKIPPED: BLOCKED captures uppercase qualifier
asyncTest('F19: "PHASE_SKIPPED: BLOCKED" → token PHASE_SKIPPED, qualifier BLOCKED', async () => {
  const r = await parse([assistantText('PHASE_SKIPPED: BLOCKED — phase 3 backlog note written')]);
  assertEquals(r.controlTokens.length, 1, 'one controlToken');
  assertEquals(r.controlTokens[0].token, 'PHASE_SKIPPED', 'token');
  assertEquals(r.controlTokens[0].qualifier, 'BLOCKED', 'qualifier BLOCKED');
  assertEquals(r.controlTokens[0].raw, 'PHASE_SKIPPED: BLOCKED', 'raw spans qualifier');
});

// F20 — controlTokens: hyphenated VC-PREDICT tokens match whole
asyncTest('F20: VC-PREDICT-DEEP-NEEDED + VC-PREDICT-RESEARCH-COMPLETE both captured', async () => {
  const r = await parse([
    assistantText('VC-PREDICT-DEEP-NEEDED: auth surface — pausing'),
    assistantText('VC-PREDICT-RESEARCH-COMPLETE: auth surface — findings ready')
  ]);
  assertEquals(r.controlTokens.length, 2, 'two controlTokens');
  assertEquals(r.controlTokens[0].token, 'VC-PREDICT-DEEP-NEEDED', 'first hyphen token');
  assertEquals(r.controlTokens[1].token, 'VC-PREDICT-RESEARCH-COMPLETE', 'second hyphen token');
});

// F21 — controlTokens from tool_result source, shared monotonic index with phaseCompletes
asyncTest('F21: control token + phaseComplete share one monotonic index sequence', async () => {
  const r = await parse([
    assistantText('CASCADE_BLOCKED — two consecutive phases blocked'),
    assistantText('PHASE_COMPLETE: PLAN')
  ]);
  assertEquals(r.controlTokens.length, 1, 'one controlToken');
  assertEquals(r.phaseCompletes.length, 1, 'one phaseComplete');
  assertEquals(r.controlTokens[0].index, 0, 'control token first → index 0');
  // control token 0, its chatMessage 1 (shared _signalIndex), then the phaseComplete
  assertEquals(r.phaseCompletes[0].index, 2, 'phaseComplete after → index 2');
});

// F22 — PHASE_COMPLETE is NOT double-captured as a control token (allowlist excludes it)
asyncTest('F22: PHASE_COMPLETE does not leak into controlTokens', async () => {
  const r = await parse([assistantText('PHASE_COMPLETE: UPDATE PROCESS')]);
  assertEquals(r.phaseCompletes.length, 1, 'phaseComplete captured');
  assertEquals(r.controlTokens.length, 0, 'controlTokens empty — no PHASE_COMPLETE leak');
});

// F23 — ordinary prose with no control tokens → controlTokens []; tool_result source tag
asyncTest('F23: MID_PROGRAM_PLAN_CREATED via tool_result → source tool_result; prose clean', async () => {
  const clean = await parse([assistantText('We blocked the cascade of changes and skipped lunch.')]);
  assertEquals(clean.controlTokens.length, 0, 'prose (lowercase) → no false positives');
  const r = await parse([{
    message: { role: 'user', content: [{
      type: 'tool_result',
      content: 'MID_PROGRAM_PLAN_CREATED: phase-4b.md — inner PVL required'
    }] }
  }]);
  assertEquals(r.controlTokens.length, 1, 'one controlToken from tool_result');
  assertEquals(r.controlTokens[0].token, 'MID_PROGRAM_PLAN_CREATED', 'token');
  assertEquals(r.controlTokens[0].source, 'tool_result', 'source tool_result');
});

// F24 — qualifier over-capture guard: uppercase-INITIAL prose message must NOT be
// mistaken for a qualifier (Loop-9 P-1 defect: "SPEC_INTENT_BLOCKED: Missing" → "M").
asyncTest('F24: "SPEC_INTENT_BLOCKED: Missing input…" → qualifier null (no prose over-capture)', async () => {
  const r = await parse([assistantText('SPEC_INTENT_BLOCKED: Missing input — no research findings to document.')]);
  assertEquals(r.controlTokens.length, 1, 'one controlToken');
  assertEquals(r.controlTokens[0].token, 'SPEC_INTENT_BLOCKED', 'token');
  assertEquals(r.controlTokens[0].qualifier, null, 'uppercase-initial prose → qualifier null, not "M"');
});

// F25 — trailing-dash guard (Loop-9 P-2): "PHASE_SKIPPED: BLOCKED-skipped" must yield
// the clean tag "BLOCKED", never "BLOCKED-".
asyncTest('F25: "PHASE_SKIPPED: BLOCKED-skipped continue" → qualifier "BLOCKED" (no terminal dash)', async () => {
  const r = await parse([assistantText('PHASE_SKIPPED: BLOCKED-skipped continue to next phase')]);
  assertEquals(r.controlTokens.length, 1, 'one controlToken');
  assertEquals(r.controlTokens[0].qualifier, 'BLOCKED', 'clean tag, no trailing dash');
});

// F26 — the spec emission form "PHASE_SKIPPED: BLOCKED — [phase N] backlog note" still
// captures the BLOCKED qualifier intact (regression guard for SCN-53 after the P-1 fix).
asyncTest('F26: "PHASE_SKIPPED: BLOCKED — phase 3 …" → qualifier "BLOCKED" preserved', async () => {
  const r = await parse([assistantText('PHASE_SKIPPED: BLOCKED — phase 3 backlog note written; advancing to Phase 4')]);
  assertEquals(r.controlTokens[0].token, 'PHASE_SKIPPED', 'token');
  assertEquals(r.controlTokens[0].qualifier, 'BLOCKED', 'qualifier still BLOCKED after P-1 fix');
});

// F27 — uppercase-initial prose after the other tokens also yields null (broad P-1 coverage).
asyncTest('F27: CASCADE_BLOCKED / MID_PROGRAM_PLAN_CREATED uppercase-initial prose → qualifier null', async () => {
  const a = await parse([assistantText('CASCADE_BLOCKED: Phases 4 and 5 are both BLOCKED-skipped — program hard stop.')]);
  assertEquals(a.controlTokens[0].qualifier, null, 'CASCADE_BLOCKED prose → null');
  const b = await parse([assistantText('MID_PROGRAM_PLAN_CREATED: Process plan inserted — inner PVL required')]);
  assertEquals(b.controlTokens[0].qualifier, null, 'MID_PROGRAM_PLAN_CREATED prose → null');
});

// F-B3-1 — AskUserQuestion tool_use → phaseCompletes entry with phase 'INTENT-CLARIFY';
//           controlTokens must be empty (negative proof: NOT pushed to controlTokens).
asyncTest('F-B3-1: AskUserQuestion tool_use → phaseCompletes entry; controlTokens empty', async () => {
  const r = await parse([{
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_ask',
        name: 'AskUserQuestion',
        input: { question: 'What kind of feature do you want?' }
      }]
    }
  }]);
  assertEquals(r.phaseCompletes.length, 1, 'one phaseComplete from AskUserQuestion');
  assertEquals(r.phaseCompletes[0].phase, 'INTENT-CLARIFY', 'phase is INTENT-CLARIFY');
  assertEquals(r.phaseCompletes[0].raw, 'AskUserQuestion', 'raw is block.name');
  assertEquals(r.controlTokens.length, 0, 'controlTokens empty (not pushed to wrong array)');
});

// F-B3-2 — Assistant text containing "INTENT-CLARIFY TIER-0" → two phaseCompletes entries;
//           controlTokens empty (negative proof: text-path also goes to phaseCompletes).
asyncTest('F-B3-2: text "INTENT-CLARIFY TIER-0" → two phaseCompletes; controlTokens empty', async () => {
  const r = await parse([assistantText('Applying INTENT-CLARIFY and TIER-0 now.')]);
  assertEquals(r.phaseCompletes.length, 2, 'two phaseCompletes from text scan');
  assertTrue(
    r.phaseCompletes.some(p => /INTENT[-_]?CLARIFY/.test(p.phase)),
    'one entry matches INTENT-CLARIFY'
  );
  assertTrue(
    r.phaseCompletes.some(p => /TIER[-_]?0/.test(p.phase)),
    'one entry matches TIER-0'
  );
  assertEquals(r.controlTokens.length, 0, 'controlTokens empty (not pushed to wrong array)');
});

// ----------------------------------------------------------------------------
// Sequential async runner.
// ----------------------------------------------------------------------------
(async () => {
  console.log('\n=== transcript-parser signal extraction tests (F1–F27 + F-B3) ===\n');
  for (const t of asyncTests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`✗ ${t.name}`);
      console.log(`  Error: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();

// RFC-167 PR-1 — dynamic_workflow as the THIRD workgroup mode. Locks:
//  1. WORKGROUP_MODES lists the three modes; the schema accepts dynamic_workflow.
//  2. validateGroupShape rejects HUMAN members in dynamic_workflow mode (the
//     members are the agent-only orchestratable pool) — but an empty/agent-only
//     pool SAVES fine.
//  3. workgroupLaunchReadiness: dynamic needs ≥1 agent member (no-agent-member)
//     and NEVER requires a leader (leader-missing is leader_worker-only).
//  4. resolveWorkgroupSwitches leaves dynamic switches as stored (N/A, ignored).
// PR-2③ additions:
//  5. DwStateSchema / parseDwState / initialDwState — the durable `dw` slot of
//     workgroup_config_json ((phase, generateAttempts, generatedDef) is the
//     idempotent recovery checkpoint, design §8).
//  6. deriveWorkgroupDispatch — the SINGLE engine-dispatch oracle (design §3):
//     only an explicit 'executing' unlocks runScope; everything else in
//     dynamic mode stays on the generate engine (fail-closed).

import { describe, expect, test } from 'bun:test'
import {
  CreateWorkgroupSchema,
  DW_PHASES,
  deriveWorkgroupDispatch,
  initialDwState,
  isTurnEngineWorkgroupTask,
  parseDwState,
  WORKGROUP_MODES,
  workgroupModeOf,
  resolveWorkgroupSwitches,
  workgroupLaunchReadiness,
} from '../src'

describe('WORKGROUP_MODES — RFC-167 third mode', () => {
  test('lists leader_worker / free_collab / dynamic_workflow', () => {
    expect(WORKGROUP_MODES).toEqual(['leader_worker', 'free_collab', 'dynamic_workflow'])
  })

  test('CreateWorkgroupSchema accepts dynamic_workflow with agent members', () => {
    const parsed = CreateWorkgroupSchema.safeParse({
      name: 'squad',
      mode: 'dynamic_workflow',
      members: [{ memberType: 'agent', agentName: 'coder', displayName: 'coder' }],
    })
    expect(parsed.success).toBe(true)
  })

  test('empty pool saves fine (quick create)', () => {
    expect(
      CreateWorkgroupSchema.safeParse({ name: 'empty', mode: 'dynamic_workflow', members: [] })
        .success,
    ).toBe(true)
  })
})

describe('validateGroupShape — dynamic_workflow rejects human members', () => {
  test('a human member in dynamic mode fails to parse', () => {
    const parsed = CreateWorkgroupSchema.safeParse({
      name: 'squad',
      mode: 'dynamic_workflow',
      members: [
        { memberType: 'agent', agentName: 'coder', displayName: 'coder' },
        { memberType: 'human', userId: 'u1', displayName: 'pm' },
      ],
    })
    expect(parsed.success).toBe(false)
  })

  test('the SAME human member is fine in leader_worker mode', () => {
    const parsed = CreateWorkgroupSchema.safeParse({
      name: 'squad',
      mode: 'leader_worker',
      members: [
        { memberType: 'agent', agentName: 'coder', displayName: 'coder' },
        { memberType: 'human', userId: 'u1', displayName: 'pm' },
      ],
    })
    expect(parsed.success).toBe(true)
  })
})

describe('workgroupLaunchReadiness — dynamic_workflow', () => {
  test('agent members present → ready (no leader needed)', () => {
    const r = workgroupLaunchReadiness({
      mode: 'dynamic_workflow',
      leaderMemberId: null,
      members: [{ id: 'm1', memberType: 'agent' }],
    })
    expect(r.ready).toBe(true)
    expect(r.reasons).toEqual([])
  })

  test('empty pool → no-agent-member', () => {
    const r = workgroupLaunchReadiness({
      mode: 'dynamic_workflow',
      leaderMemberId: null,
      members: [],
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toEqual(['no-agent-member'])
  })

  test('dynamic never reports leader-missing', () => {
    const r = workgroupLaunchReadiness({
      mode: 'dynamic_workflow',
      leaderMemberId: null,
      members: [{ id: 'm1', memberType: 'agent' }],
    })
    expect(r.reasons).not.toContain('leader-missing')
  })
})

describe('resolveWorkgroupSwitches — dynamic leaves stored switches (N/A)', () => {
  test('dynamic mode returns stored switches unchanged (ignored by the engine)', () => {
    const stored = { shareOutputs: false, directMessages: false, blackboard: false }
    expect(resolveWorkgroupSwitches('dynamic_workflow', stored)).toEqual(stored)
  })
})

describe('DwState — the durable dw slot (PR-2③)', () => {
  test('initialDwState is a generating checkpoint with zeroed counters', () => {
    expect(initialDwState()).toEqual({ phase: 'generating', generateAttempts: 0, rejectRounds: 0 })
  })

  test('parseDwState round-trips a full state incl. generatedDef', () => {
    const def = { $schema_version: 4, inputs: [], nodes: [], edges: [] }
    const dw = parseDwState({
      phase: 'awaiting_confirm',
      generateAttempts: 2,
      rejectRounds: 1,
      rejectionComment: '拆细一点',
      generatedDef: def,
    })
    expect(dw).not.toBeNull()
    expect(dw?.phase).toBe('awaiting_confirm')
    expect(dw?.generateAttempts).toBe(2)
    expect(dw?.rejectRounds).toBe(1)
    expect(dw?.rejectionComment).toBe('拆细一点')
    expect(dw?.generatedDef).toEqual(def)
  })

  test('parseDwState defaults the counters and rejects garbage', () => {
    expect(parseDwState({ phase: 'generating' })).toEqual({
      phase: 'generating',
      generateAttempts: 0,
      rejectRounds: 0,
    })
    expect(parseDwState(undefined)).toBeNull()
    expect(parseDwState({ phase: 'nope' })).toBeNull()
    expect(parseDwState('generating')).toBeNull()
  })
})

describe('deriveWorkgroupDispatch — single dispatch oracle (design §3)', () => {
  test('non-dynamic modes ALWAYS run the turn engine, whatever dw says', () => {
    expect(deriveWorkgroupDispatch('leader_worker', null)).toBe('turn-engine')
    expect(deriveWorkgroupDispatch('free_collab', 'executing')).toBe('turn-engine')
  })

  test("only an explicit 'executing' unlocks runScope; every other phase (or a missing one) stays on the generate engine", () => {
    for (const phase of DW_PHASES) {
      expect(deriveWorkgroupDispatch('dynamic_workflow', phase)).toBe(
        phase === 'executing' ? 'dw-execute' : 'dw-generate',
      )
    }
    expect(deriveWorkgroupDispatch('dynamic_workflow', null)).toBe('dw-generate')
    expect(deriveWorkgroupDispatch('dynamic_workflow', undefined)).toBe('dw-generate')
  })

  test('workgroupModeOf reads the mode off raw config JSON; garbage → null', () => {
    expect(workgroupModeOf(JSON.stringify({ mode: 'dynamic_workflow' }))).toBe('dynamic_workflow')
    expect(workgroupModeOf(JSON.stringify({ mode: 'leader_worker', extra: 1 }))).toBe(
      'leader_worker',
    )
    expect(workgroupModeOf(JSON.stringify({ mode: 'nope' }))).toBeNull()
    expect(workgroupModeOf('not json')).toBeNull()
    expect(workgroupModeOf(null)).toBeNull()
    expect(workgroupModeOf(undefined)).toBeNull()
  })

  test('deriveWorkgroupDispatch — mode × phase dispatch matrix (RFC-217: phase now rides workgroup_task_state)', () => {
    expect(deriveWorkgroupDispatch('dynamic_workflow', 'executing')).toBe('dw-execute')
    expect(deriveWorkgroupDispatch('dynamic_workflow', 'generating')).toBe('dw-generate')
    expect(deriveWorkgroupDispatch('dynamic_workflow', 'awaiting_confirm')).toBe('dw-generate')
    expect(deriveWorkgroupDispatch('dynamic_workflow', 'rejected')).toBe('dw-generate')
    // missing phase → generate (fail-closed toward the engine that cannot
    // corrupt a worktree)
    expect(deriveWorkgroupDispatch('dynamic_workflow', null)).toBe('dw-generate')
    expect(deriveWorkgroupDispatch('leader_worker', null)).toBe('turn-engine')
    expect(deriveWorkgroupDispatch('free_collab', 'executing')).toBe('turn-engine')
  })

  test('isTurnEngineWorkgroupTask — the generic-recovery guard discriminator (Codex P1)', () => {
    const dyn = JSON.stringify({ mode: 'dynamic_workflow' })
    const lw = JSON.stringify({ mode: 'leader_worker' })
    // not a workgroup task at all → never blocked by the workgroup guards
    expect(isTurnEngineWorkgroupTask({ workgroupId: null, workgroupConfigJson: lw })).toBe(false)
    // turn-engine modes → blocked (RFC-164 engine re-entry territory)
    expect(isTurnEngineWorkgroupTask({ workgroupId: 'wg', workgroupConfigJson: lw })).toBe(true)
    expect(
      isTurnEngineWorkgroupTask({
        workgroupId: 'wg',
        workgroupConfigJson: JSON.stringify({ mode: 'free_collab' }),
      }),
    ).toBe(true)
    // dynamic_workflow → generically recoverable
    expect(isTurnEngineWorkgroupTask({ workgroupId: 'wg', workgroupConfigJson: dyn })).toBe(false)
    // corrupt / missing config on a workgroup task → fail-closed (blocked)
    expect(isTurnEngineWorkgroupTask({ workgroupId: 'wg', workgroupConfigJson: null })).toBe(true)
    expect(isTurnEngineWorkgroupTask({ workgroupId: 'wg', workgroupConfigJson: '{{' })).toBe(true)
  })
})

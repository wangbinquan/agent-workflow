// RFC-304 T7 — hooks, fired by the real runner at real stage boundaries.
//
// `hookRunner.ts` and its unit tests shipped with PR-1a and nothing in `src`
// called them. That gap was not cosmetic: every stage file in this module
// argues that it exists as a SEPARATE stage because the engine fires hooks at
// its boundary, and that collapsing the sequence would silently remove a team's
// injection and blocking points. With no caller, the sequence had thirteen
// boundaries and zero hooks — the argument was false, and nothing anywhere went
// red, because a mechanism that is absent never errors.
//
// So these tests go through `createCodeCapabilityRunner` with real scripts on
// disk. What they pin is the behaviour a team is promised (design §4.3 F6/F8):
//
//   a pre-hook can stop the round        — a gate that says "not this one"
//   a pre-hook can hand data to a stage  — but only keys on that stage's allowlist
//   a failing OPTIONAL hook is recorded  — and the round still finishes
//   a hook for another contract version  — is reported, and never run
//
// The blocking/non-blocking split is the one worth protecting: a team's
// optional lint hook going red must not strand somebody's MR, and a team's
// mandatory gate going red must not be shrugged off.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createCodeCapabilityRunner,
  type CapabilityHookWiring,
} from '../src/modules/code-capability/composition/codeCapabilityRunner'
import { readRoundStages } from '../src/modules/code-capability/application/stageEngine'
import type { CapabilityHook } from '../src/modules/code-capability/application/hookRunner'
import type { StageContract } from '../src/modules/code-capability/domain/stageContract'
import type {
  StageRunContext,
  StageResult,
} from '../src/modules/code-capability/application/stageEngine'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NONCE = 'hooknonce'
const CONTRACT_VER = 4

/**
 * A two-stage stand-in for `mr-review`.
 *
 * Deliberately not the real contract: what is under test is the ENGINE firing
 * hooks, and driving the real thirteen-stage sequence would need a code host
 * and a model for a question neither one participates in.
 */
const CONTRACT: StageContract = {
  capability: 'mr-review',
  version: CONTRACT_VER,
  stages: [
    { kind: 'program', name: 'resolve-target', requires: [], produces: ['target'] },
    {
      kind: 'program',
      name: 'gate',
      requires: ['target'],
      produces: ['gated'],
      injectable: ['extraContext'],
    },
  ],
}

/** Records what each stage saw, so an injection can be observed downstream. */
function recordingStages() {
  const seen: Array<{ stage: string; extraContext: unknown }> = []
  const impl = async (ctx: StageRunContext): Promise<StageResult> => {
    seen.push({ stage: ctx.stage.name, extraContext: ctx.artifacts.extraContext })
    return { status: 'done', produced: { [ctx.stage.produces[0] ?? 'x']: true } }
  }
  return { seen, stages: { 'resolve-target': impl, gate: impl } }
}

const shellHook = (
  over: Partial<CapabilityHook> & Pick<CapabilityHook, 'stage'>,
): CapabilityHook => ({
  phase: 'pre',
  language: 'bash',
  script: 'exit 0',
  stageContractVer: CONTRACT_VER,
  ...over,
})

interface RunOpts {
  hooks: readonly CapabilityHook[]
  home: string
}

async function runWithHooks(db: DbClient, opts: RunOpts) {
  const problems: Array<{ stage: string; phase: string; reason: string }> = []
  const recorded = recordingStages()
  const wiring: CapabilityHookWiring = {
    hooks: opts.hooks,
    currentStageContractVer: CONTRACT_VER,
    runDir: join(opts.home, 'run'),
    interpreterPath: '/bin/bash',
    workItem: { anchorKind: 'mr', anchorId: '412', baselineSha: 'abc123' },
    onHookProblem: (p) => problems.push(p),
  }
  const runner = createCodeCapabilityRunner({
    db,
    programStages: recorded.stages,
    lookupContract: () => CONTRACT,
    hooks: wiring,
  })
  const roundId = ulid()
  const outcome = await runner.runRound({
    roundId,
    capability: 'mr-review',
    roundSeq: 1,
    worktreePath: opts.home,
    repos: [{ name: 'main', path: opts.home }],
    envelopeNonce: NONCE,
    resumeFromStage: null,
  })
  return { outcome, roundId, problems, seen: recorded.seen }
}

describe('RFC-304 — a hook actually runs', () => {
  let db: DbClient
  let home: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-hooks-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('a passing hook leaves the round alone', async () => {
    const { outcome } = await runWithHooks(db, {
      home,
      hooks: [shellHook({ stage: 'gate', script: 'exit 0' })],
    })
    expect(outcome.outcome).toBe('done')
  })

  test('a BLOCKING hook that exits non-zero stops the round at that stage', async () => {
    // The power a team is actually promised: its own gate saying "not this one".
    // Without the wiring this test would pass trivially — nothing would run and
    // the round would finish — which is why the stage assertion below matters.
    const { outcome, seen } = await runWithHooks(db, {
      home,
      hooks: [shellHook({ stage: 'gate', blocking: true, script: 'exit 3' })],
    })
    expect(outcome.outcome).toBe('blocked')
    expect(outcome.outcome === 'blocked' && outcome.blockedStage).toBe('gate')
    // And the stage genuinely did not run.
    expect(seen.map((s) => s.stage)).toEqual(['resolve-target'])
  })

  test('a NON-blocking hook that fails is recorded and the round finishes', async () => {
    // Design §4.3 F8. An optional lint hook going red must not strand an MR.
    const { outcome, problems, seen } = await runWithHooks(db, {
      home,
      hooks: [shellHook({ stage: 'gate', script: 'exit 1' })],
    })
    expect(outcome.outcome).toBe('done')
    expect(seen.map((s) => s.stage)).toEqual(['resolve-target', 'gate'])
    expect(problems).toHaveLength(1)
    expect(problems[0]?.stage).toBe('gate')
  })

  test('a hook mounted on another stage does not fire here', async () => {
    // Hooks mount on a stage NAME; a hook that fired everywhere would make one
    // team's gate block stages it never asked about.
    const { outcome } = await runWithHooks(db, {
      home,
      hooks: [shellHook({ stage: 'nonexistent-stage', blocking: true, script: 'exit 9' })],
    })
    expect(outcome.outcome).toBe('done')
  })

  test('the blocked stage is recorded, so the round explains itself', async () => {
    const { roundId } = await runWithHooks(db, {
      home,
      hooks: [shellHook({ stage: 'gate', blocking: true, script: 'exit 3' })],
    })
    const rows = await readRoundStages(db, roundId)
    const gate = rows.find((r) => r.stageName === 'gate')
    expect(gate?.status).toBe('skipped')
  })
})

describe('RFC-304 — a hook hands data to the stage it guards', () => {
  let db: DbClient
  let home: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-hooks-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  const emit = (port: string, value: string) =>
    `echo '<workflow-output nonce="${NONCE}"><port name="${port}">${value}</port></workflow-output>'`

  test('an allowlisted key reaches the stage', async () => {
    const { seen } = await runWithHooks(db, {
      home,
      hooks: [shellHook({ stage: 'gate', script: emit('extraContext', 'team notes') })],
    })
    const gate = seen.find((s) => s.stage === 'gate')
    expect(gate?.extraContext).toBe('team notes')
  })

  test('a key NOT on the allowlist is dropped, and the drop is reported', async () => {
    // Without the allowlist a hook could redefine any artifact the sequence
    // depends on, and "program stages are deterministic" would hold only until
    // somebody wrote a creative hook. Silent dropping would be nearly as bad —
    // the author would be debugging an injection that never arrives.
    const { seen, problems } = await runWithHooks(db, {
      home,
      hooks: [shellHook({ stage: 'gate', script: emit('target', 'a forged target') })],
    })
    const gate = seen.find((s) => s.stage === 'gate')
    expect(gate?.extraContext).toBeUndefined()
    expect(problems.some((p) => p.reason.includes('allowlist'))).toBe(true)
  })

  test('injection does NOT leak past the stage it was meant for', async () => {
    // `pre` feeds the stage about to run. Leaking it downstream would let one
    // team's hook silently redefine an artifact for every later stage.
    const { seen } = await runWithHooks(db, {
      home,
      hooks: [
        shellHook({ stage: 'resolve-target', script: emit('extraContext', 'only for the first') }),
      ],
    })
    expect(seen.find((s) => s.stage === 'gate')?.extraContext).toBeUndefined()
  })
})

describe('RFC-304 — a hook written for another contract version', () => {
  let db: DbClient
  let home: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-hooks-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('is not run, even when it would have blocked', async () => {
    // Running it feeds it a shape it does not understand. This is the T8 case,
    // and it is why the version is stored per hook rather than assumed.
    const { outcome } = await runWithHooks(db, {
      home,
      hooks: [shellHook({ stage: 'gate', blocking: true, script: 'exit 3', stageContractVer: 1 })],
    })
    expect(outcome.outcome).toBe('done')
  })

  test('is reported as needing migration rather than silently skipped', async () => {
    // Silently skipping means a team's gate quietly stops gating — the reviews
    // keep coming back clean and nobody learns why.
    const { problems } = await runWithHooks(db, {
      home,
      hooks: [shellHook({ stage: 'gate', script: 'exit 0', stageContractVer: 1 })],
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.reason).toContain('migrate')
  })
})

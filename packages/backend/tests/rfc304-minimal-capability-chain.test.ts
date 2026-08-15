// RFC-304 T12 — the minimal capability chain, end to end at the port level.
//
// What this backs: the engine, the stage rows and the hook boundaries work
// together before any real capability depends on them. What it explicitly does
// NOT back: a real `code-round` task or the AI two-level retry — those are
// PR-1b, and claiming them here would be claiming coverage this file does not
// have.
//
// The registry self-check is the other half. It is written as a sweep over
// EVERY registered contract rather than a check of the one that exists today,
// so the capability added in a later PR is validated the day it is added
// instead of the day someone remembers to extend this file.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  checkBuiltinContracts,
  lookupStageContract,
  MINIMAL_CONTRACT,
  registeredCapabilities,
} from '../src/modules/code-capability/domain/capabilityRegistry'
import {
  readRoundStages,
  runStageSequence,
  type StageRunners,
} from '../src/modules/code-capability/application/stageEngine'
import {
  runCapabilityHook,
  type HookRunEnvironment,
} from '../src/modules/code-capability/application/hookRunner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

describe('RFC-304 — the built-in contract registry checks itself', () => {
  test('every registered contract is self-consistent', () => {
    // The assertion that replaces "remember the stage order". A `requires` with
    // no upstream `produces` shows up here, at author time, instead of as an
    // empty artifact three stages later on someone's MR.
    expect(checkBuiltinContracts()).toEqual([])
  })

  test('the registry is non-empty and every entry resolves by its own capability', () => {
    // Guards the vacuous pass: an empty registry would satisfy the check above.
    const capabilities = registeredCapabilities()
    expect(capabilities.length).toBeGreaterThan(0)
    for (const capability of capabilities) {
      expect(lookupStageContract(capability)?.capability).toBe(capability)
    }
  })

  test('the minimal contract is all-program — PR-1a has no determinism guard yet', () => {
    // A contract with an `ai` stage would imply a guard exists. It does not
    // until PR-1b, and a stage that ran a model unguarded is exactly what the
    // constitution forbids.
    expect(MINIMAL_CONTRACT.stages.every((s) => s.kind === 'program')).toBe(true)
  })
})

describe('RFC-304 T12 — minimal chain: prepare-worktree → work → ledger', () => {
  let db: DbClient
  let home: string
  let roundId: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-chain-'))
    roundId = ulid()
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  /** Runners that thread a real artifact chain, mirroring the contract's names. */
  const chainRunners = (log: string[]): StageRunners => {
    const run = async (ctx: Parameters<StageRunners['program']>[0]) => {
      log.push(ctx.stage.name)
      switch (ctx.stage.name) {
        case 'prepare-worktree':
          return { status: 'done' as const, produced: { worktree: home } }
        case 'collect-context': {
          // Consume whatever a pre hook injected — the reason `injectable`
          // exists. Absent injection is the ordinary case.
          const extra = ctx.artifacts.extraContext
          return {
            status: 'done' as const,
            produced: { context: typeof extra === 'string' ? `base+${extra}` : 'base' },
          }
        }
        default:
          return {
            status: 'done' as const,
            produced: { ledgerEntry: String(ctx.artifacts.context) },
            counts: { entries: 1 },
          }
      }
    }
    return { program: run, script: run, ai: run, invoke: run }
  }

  test('the chain runs in order and every stage lands a row', async () => {
    const log: string[] = []
    const out = await runStageSequence({
      db,
      roundId,
      contract: MINIMAL_CONTRACT,
      runners: chainRunners(log),
    })

    expect(out.outcome).toBe('done')
    expect(log).toEqual(['prepare-worktree', 'collect-context', 'ledger'])
    expect(out.outcome === 'done' && out.artifacts.ledgerEntry).toBe('base')

    const rows = await readRoundStages(db, roundId)
    expect(rows.map((r) => [r.stageName, r.status])).toEqual([
      ['prepare-worktree', 'done'],
      ['collect-context', 'done'],
      ['ledger', 'done'],
    ])
  })

  test('a real pre hook injects into the chain and the value reaches the ledger', async () => {
    // The full loop: subprocess → envelope → allowlist → engine artifacts →
    // downstream stage. Each link is where an injection could silently vanish.
    const stageDef = MINIMAL_CONTRACT.stages[1]!
    const env: HookRunEnvironment = {
      worktreePath: home,
      runDir: join(home, 'run'),
      repos: [{ name: 'main', path: home }],
      interpreterPath: PYTHON,
      workItem: {
        capability: 'mr-review',
        anchorKind: 'mr',
        anchorId: '412',
        roundId,
        roundSeq: 1,
        baselineSha: 'abc',
      },
      envelopeNonce: 'chainnonce',
      timeoutMs: 30_000,
    }

    const log: string[] = []
    const out = await runStageSequence({
      db,
      roundId,
      contract: MINIMAL_CONTRACT,
      runners: chainRunners(log),
      hooks: {
        pre: async (ctx) => {
          if (ctx.stage.name !== 'collect-context') return
          const result = await runCapabilityHook({
            hook: {
              stage: 'collect-context',
              phase: 'pre',
              language: 'python',
              stageContractVer: 1,
              script: [
                'import os',
                'n = os.environ["AW_ENVELOPE_NONCE"]',
                'print(f"<workflow-output nonce=\\"{n}\\"><port name=\\"extraContext\\">team-rules</port></workflow-output>")',
              ].join('\n'),
            },
            stage: stageDef,
            env,
            currentStageContractVer: 1,
          })
          if (result.status === 'blocked') return { block: result.reason }
          // Explicit return, not a mutation of ctx.artifacts: the engine owns
          // the merge and scopes it to this stage.
          if (result.status === 'ok') return { inject: result.injected }
          return
        },
      },
    })

    expect(out.outcome).toBe('done')
    expect(out.outcome === 'done' && out.artifacts.ledgerEntry).toBe('base+team-rules')
  })

  test('a blocking hook stops the chain before its stage runs', async () => {
    const stageDef = MINIMAL_CONTRACT.stages[1]!
    const log: string[] = []
    const out = await runStageSequence({
      db,
      roundId,
      contract: MINIMAL_CONTRACT,
      runners: chainRunners(log),
      hooks: {
        pre: async (ctx) => {
          if (ctx.stage.name !== 'collect-context') return
          const result = await runCapabilityHook({
            hook: {
              stage: 'collect-context',
              phase: 'pre',
              language: 'python',
              stageContractVer: 1,
              blocking: true,
              script: 'import sys\nprint("not on this branch", file=sys.stderr)\nsys.exit(2)\n',
            },
            stage: stageDef,
            env: {
              worktreePath: home,
              runDir: join(home, 'run2'),
              repos: [],
              interpreterPath: PYTHON,
              workItem: {
                capability: 'mr-review',
                anchorKind: 'mr',
                anchorId: '412',
                roundId,
                roundSeq: 1,
                baselineSha: null,
              },
              envelopeNonce: 'chainnonce',
              timeoutMs: 30_000,
            },
            currentStageContractVer: 1,
          })
          return result.status === 'blocked' ? { block: result.reason } : undefined
        },
      },
    })

    expect(out.outcome).toBe('blocked')
    expect(out.outcome === 'blocked' && out.reason).toContain('not on this branch')
    // Only the first stage ran; the ledger was never written.
    expect(log).toEqual(['prepare-worktree'])
  })

  test('a hook writing the worktree is visible to the stage that follows', async () => {
    // The other power: side effects need no channel at all, because the
    // worktree is the shared medium.
    const marker = join(home, 'from-hook.txt')
    const stageDef = MINIMAL_CONTRACT.stages[1]!
    const seen: string[] = []
    await runStageSequence({
      db,
      roundId,
      contract: MINIMAL_CONTRACT,
      runners: {
        program: async (ctx) => {
          if (ctx.stage.name === 'collect-context') seen.push(readFileSync(marker, 'utf8'))
          return { status: 'done' }
        },
        script: async () => ({ status: 'done' }),
        ai: async () => ({ status: 'done' }),
        invoke: async () => ({ status: 'done' }),
      },
      hooks: {
        pre: async (ctx) => {
          if (ctx.stage.name !== 'collect-context') return
          await runCapabilityHook({
            hook: {
              stage: 'collect-context',
              phase: 'pre',
              language: 'python',
              stageContractVer: 1,
              script:
                'import os\nopen(os.path.join(os.environ["AW_WORKTREE"], "from-hook.txt"), "w").write("side-effect")\n',
            },
            stage: stageDef,
            env: {
              worktreePath: home,
              runDir: join(home, 'run3'),
              repos: [],
              interpreterPath: PYTHON,
              workItem: {
                capability: 'mr-review',
                anchorKind: 'mr',
                anchorId: '412',
                roundId,
                roundSeq: 1,
                baselineSha: null,
              },
              envelopeNonce: 'chainnonce',
              timeoutMs: 30_000,
            },
            currentStageContractVer: 1,
          })
          return
        },
      },
    })
    expect(seen).toEqual(['side-effect'])
  })
})

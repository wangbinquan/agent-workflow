// RFC-304 — every shipped capability is reachable from the scheduler.
//
// This file exists because of what the completeness audit found: the scheduler
// referenced `buildMrReviewWiring` and nothing else, so `mr-comment-fix`,
// `requirement` and `ci-fix` had complete, unit-tested stage compositions that
// production could never reach. A round for any of them got a runner with no
// stages and died at stage one with "has no runner registered yet".
//
// Nothing was red, for the reason this RFC keeps rediscovering: each half is
// green on its own and an absent join raises no error. PR-9 then made it LOUDER
// rather than better — opening the `WorkPackage` union arms let the monitor
// genuinely dispatch `ci-fix`, so a round would start, take the merge-request
// lease, and fail every stage.
//
// So the load-bearing assertion here is coverage, enumerated from the shipped
// capability list rather than spot-checked: a sixth capability added later must
// make this file red rather than quietly shipping unreachable.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { webhookEndpoints } from '../src/db/schema'
import { buildCapabilityWiring } from '../src/modules/code-capability/composition/capabilityWiring'
import { CODE_CAPABILITIES } from '../src/modules/code-capability/domain/stageContract'
import { lookupStageContract } from '../src/modules/code-capability/domain/capabilityRegistry'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const webhook = (over: Partial<WebhookTriggerFields> = {}): WebhookTriggerFields =>
  ({
    event_type: 'merge_request',
    provider: 'gitlab',
    project_id: '41823',
    mr_iid: '412',
    repo_path: 'group/project',
    branch: 'feature/x',
    commit_sha: 'a'.repeat(40),
    ...over,
  }) as WebhookTriggerFields

/** The three the scheduler could not reach before this wiring existed. */
const WIRED_HERE = ['mr-comment-fix', 'requirement', 'ci-fix'] as const

describe('RFC-304 — the scheduler can reach every capability', () => {
  let db: DbClient

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await db.insert(webhookEndpoints).values({
      id: 'ep-1',
      provider: 'gitlab',
      name: 'ep',
      secretEnc: '',
      urlToken: 'tok',
      enabled: true,
      preferredCloneProtocol: 'http',
      lastDeliveryAt: null,
      createdAt: 1,
      updatedAt: 1,
    })
  })
  afterEach(() => {
    db.$client.close()
  })

  const build = async (capability: (typeof WIRED_HERE)[number], over = {}) =>
    await buildCapabilityWiring({
      db,
      capability,
      webhook: webhook(),
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/wt',
      protocolBlock: '',
      nonce: 'n',
      roundId: 'round-1',
      roundSeq: 1,
      workItemId: 'item-1',
      ...over,
    })

  test('every capability the platform ships is either wired here or is mr-review/mr-monitor', () => {
    // Enumerated from the shipped list. A sixth capability added later either
    // joins `WIRED_HERE` or is named in this exemption, and either way somebody
    // has to think about whether the scheduler can reach it.
    const accountedFor = new Set<string>([...WIRED_HERE, 'mr-review', 'mr-monitor'])
    for (const capability of CODE_CAPABILITIES) {
      expect(accountedFor.has(capability), `${capability} has no scheduler wiring`).toBe(true)
    }
  })

  for (const capability of WIRED_HERE) {
    test(`${capability}: every contract stage has an implementation`, async () => {
      // The assertion that would have caught the gap. Derived from the CONTRACT
      // rather than from a hand-written list, so a stage added to the contract
      // without an implementation fails here instead of at round time.
      const wiring = await build(capability)
      const contract = lookupStageContract(capability)
      expect(contract).toBeDefined()

      const missing: string[] = []
      for (const stage of contract?.stages ?? []) {
        if (stage.kind === 'program' && wiring.programStages[stage.name] === undefined) {
          missing.push(`program:${stage.name}`)
        }
        if (stage.kind === 'ai' && wiring.aiStages[stage.name] === undefined) {
          missing.push(`ai:${stage.name}`)
        }
      }
      expect(missing).toEqual([])
    })

    test(`${capability}: without a bound agent the AI stages REFUSE by name`, async () => {
      // Not "unregistered". An unregistered stage fails with "no runner
      // registered", which tells an operator nothing about what to configure;
      // a refusal names the slot and the repository.
      const wiring = await build(capability)
      const contract = lookupStageContract(capability)
      const aiStage = contract?.stages.find((s) => s.kind === 'ai')
      expect(aiStage).toBeDefined()

      const result = await wiring.aiStages[aiStage!.name]!({
        roundId: 'round-1',
        stage: aiStage!,
        artifacts: {},
      })
      expect(result.status).toBe('failed')
      expect(result.status === 'failed' && result.error).toContain('bind one')
    })

    test(`${capability}: the PROGRAM stages are real, not refusals`, async () => {
      // The distinction that makes an unbound agent survivable: worktree, diff,
      // gate and push still run for real, so a round gets as far as it honestly
      // can and stops at the one thing that is missing.
      const wiring = await build(capability)
      const refusalCount = Object.values(wiring.programStages).filter((fn) =>
        fn.toString().includes('no agent is bound'),
      ).length
      expect(refusalCount).toBe(0)
    })

    test(`${capability}: an unknown provider refuses EVERY stage with one message`, async () => {
      // Composition must not throw: a stack trace out of assembly is a log
      // nobody reads, while a refusing round says what is wrong on the round.
      const wiring = await build(capability, {
        webhook: webhook({ provider: 'bitbucket' as never }),
      })
      const contract = lookupStageContract(capability)
      const first = contract?.stages.find((s) => s.kind === 'program')

      const result = await wiring.programStages[first!.name]!({
        roundId: 'round-1',
        stage: first!,
        artifacts: {},
      })
      expect(result.status).toBe('failed')
      expect(result.status === 'failed' && result.error).toContain('does not drive')
    })
  }

  test('ci-fix comes back with an implementation for every SCRIPT stage', async () => {
    // The join for the script-stage runner, and it needs its own assertion for
    // an uncomfortable reason: `ci-fix` cannot start in production yet (its
    // cell is permanently `misconfigured` — `hasWakeSource` is hardcoded false,
    // plan §2ter.4), so a broken join here would stay invisible until whenever
    // that second gate opens. That is precisely how every other gap in this RFC
    // survived: nothing exercised the path, so nothing was red.
    //
    // Derived from the CONTRACT rather than a hand-written list of four, so a
    // script stage added later must appear here too.
    const wiring = await build('ci-fix')
    const contract = lookupStageContract('ci-fix')
    const scriptNames = (contract?.stages ?? [])
      .filter((stage) => stage.kind === 'script')
      .map((stage) => stage.name)

    expect(scriptNames.length).toBeGreaterThan(0)
    expect(Object.keys(wiring.scriptStages ?? {}).sort()).toEqual([...scriptNames].sort())
  })

  test('with no resolvable framework the script stages REFUSE rather than vanish', async () => {
    // Absent is the dangerous answer: an unregistered stage fails with "no
    // runner registered", which reads as a platform defect and tells an
    // operator nothing. A refusal names what could not be resolved.
    //
    // `build()` passes no `repoId`, so the framework's scripts cannot be
    // resolved — the ordinary state for a round whose repository has no cell.
    const wiring = await build('ci-fix')
    const first = Object.values(wiring.scriptStages ?? {})[0]
    expect(first).toBeDefined()

    const result = await first!({
      roundId: 'round-1',
      stage: { kind: 'script', name: 'collect', scriptSlot: 'collect', requires: [], produces: [] },
      artifacts: {},
    } as never)
    expect(result.status).toBe('failed')
    expect(result.status === 'failed' && result.error).toContain('could not be resolved')
  })

  test('the four other capabilities declare no script stage, so none is wired', () => {
    // The other half of the same fact. `ci-fix` is the ONLY contract using the
    // script kind; if that ever changes, whoever changes it has to come here
    // and think about whether that capability's wiring supplies them.
    for (const capability of CODE_CAPABILITIES) {
      if (capability === 'ci-fix') continue
      const contract = lookupStageContract(capability)
      const scripts = (contract?.stages ?? []).filter((stage) => stage.kind === 'script')
      expect(scripts.map((stage) => stage.name)).toEqual([])
    }
  })

  test('an unresolvable code host refuses rather than throwing', async () => {
    // Same shape as the provider case, and it is the commoner one: a deployment
    // that has configured a capability but not the code-host connection.
    const empty = createInMemoryDb(MIGRATIONS)
    try {
      const wiring = await buildCapabilityWiring({
        db: empty,
        capability: 'ci-fix',
        webhook: webhook(),
        repoPath: '/tmp/repo',
        worktreePath: '/tmp/wt',
        protocolBlock: '',
        nonce: 'n',
        roundId: 'r',
        roundSeq: 1,
        workItemId: 'i',
      })
      expect(wiring.codeHostEndpointId).toBeNull()
      const result = await wiring.programStages['prepare-worktree']!({
        roundId: 'r',
        stage: { kind: 'program', name: 'prepare-worktree', requires: [], produces: [] },
        artifacts: {},
      })
      expect(result.status).toBe('failed')
    } finally {
      empty.$client.close()
    }
  })
})

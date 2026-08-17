// RFC-309 T24 (AC-10) — a platform-launched round actually runs, and its
// questions come back to the platform.
//
// ## The gap this closes, which the launch command alone did not
//
// `POST /api/code/rounds` opened a work item and a round. That looked complete
// and was not: the scheduler's capability wiring required a frozen TRIGGER
// CONTEXT, and a platform launch has none — no webhook was delivered. So the
// round would start, take its lease, and every stage would refuse. Exactly the
// shape RFC-304's own audit found for three capabilities ("each half green on
// its own, an absent join raises no error"), reproduced by the entrance built
// to fix a different instance of it.
//
// Two joins are asserted here:
//
//   the requirement TEXT reaches `resolve-input`. Before, `requirementInput`
//   was hardcoded `null`, so a requirement somebody typed into the platform
//   was refused with "submitted as a reference, and no entry script is
//   configured to fetch it" — about content that was sitting in the round.
//
//   the clarify ORIGIN is `platform`. Before, it was hardcoded to the issue
//   shape with both write-back flags false, which makes `routeClarify` REFUSE
//   with a message telling the person to "submit the requirement from the
//   platform instead" — which is what they did.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { webhookEndpoints } from '../src/db/schema'
import { buildCapabilityWiring } from '../src/modules/code-capability/composition/capabilityWiring'
import { routeClarify } from '../src/modules/code-capability/domain/clarifyRouting'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-309 T24 — the platform entrance reaches the stages', () => {
  let db: DbClient

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await db.insert(webhookEndpoints).values({
      id: 'ep-1',
      provider: 'gitlab',
      name: 'ep',
      secretEnc: '',
      urlToken: 'aw-fixture-platform-launch',
      enabled: true,
      preferredCloneProtocol: 'http',
      createdAt: 1,
      updatedAt: 1,
    })
  })
  afterEach(() => {
    db.$client.close()
  })

  const buildRequirement = async (over: Record<string, unknown> = {}) =>
    await buildCapabilityWiring({
      db,
      capability: 'requirement',
      // No `event_type`: a platform launch fills the same field bag without
      // claiming a code-host delivery that never happened. That this compiles
      // is half the point — the type used to require an event.
      webhook: { provider: 'gitlab', project_id: '41823', default_branch: 'main' },
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/wt',
      nonce: 'n',
      roundId: 'round-1',
      roundSeq: 1,
      workItemId: 'item-1',
      ...over,
    })

  test('the requirement TEXT reaches `resolve-input` instead of being refused', async () => {
    const wiring = await buildRequirement({
      requirementInput: { title: 'Add a retry', body: 'when the fetch 502s', documents: [] },
      clarifyOrigin: { kind: 'platform' },
    })

    const result = await wiring.programStages['resolve-input']!({
      roundId: 'round-1',
      stage: { name: 'resolve-input', kind: 'program', requires: [], produces: ['requirement'] },
      artifacts: {},
    } as never)

    expect(result.status).toBe('done')
    expect(result).toMatchObject({ produced: { requirement: { title: 'Add a retry' } } })
  })

  test('without one it still refuses — the reference path is unchanged', async () => {
    // The issue-labelled entry has a reference, not content, and refusing is
    // the designed answer (fetching "issue 88" needs to know which system and
    // whose credentials). Widening the seam must not weaken that.
    const wiring = await buildRequirement()
    const result = await wiring.programStages['resolve-input']!({
      roundId: 'round-1',
      stage: { name: 'resolve-input', kind: 'program', requires: [], produces: ['requirement'] },
      artifacts: {},
    } as never)

    expect(result.status).toBe('failed')
    expect(String((result as { error?: unknown }).error)).toContain('reference')
  })

  test('a platform launch routes its questions to the platform, posting nothing', async () => {
    // AC-10. `issue-comment` would call the code host to write onto an issue
    // that does not exist; `refuse` would fail the round outright with a
    // message telling the person to do what they already did.
    expect(routeClarify({ kind: 'platform' })).toEqual({ route: 'platform' })
  })

  test('and the DEFAULT is still the refusing issue shape, not the platform one', async () => {
    // The dangerous direction of this change: if the default had flipped to
    // `platform`, an issue-labelled requirement whose write-back channel is
    // unconfigured would ask its question on a surface the person is not
    // watching, and wait forever. The default has to keep refusing.
    expect(
      routeClarify({
        kind: 'issue',
        hasWritebackHandle: false,
        frameworkSupportsWriteback: false,
      }).route,
    ).toBe('refuse')
  })
})

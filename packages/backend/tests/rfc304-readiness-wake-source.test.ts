// RFC-304 AC-14d — what counts as something that can START `ci-fix`.
//
// `hasWakeSource` was hardcoded `false` in the facts layer. `ci-fix` is the one
// capability that requires one, so its cell was permanently `misconfigured` and
// no round could ever begin — a whole capability switched off by a placeholder.
//
// The placeholder outlived its reason. It was written while the wake entry
// point (T35c) was believed mandatory; proposal §6ter-H1 then settled the open
// fact — the pipelines are GitLab-triggered and GitLab already produces a
// pipeline object, so the chain holds with no change to anyone's CI, and T35c
// was demoted to optional with "PR-9 范围不变". plan.md §T35c says the same:
// not a prerequisite for shipping CI fix.
//
// So the fix belongs in the FACTS, not the rule: `deriveReadiness` was correct
// all along and is tested in both directions in `rfc304-template-layers`. What
// follows locks the derivation — and it has to keep both directions honest,
// because the rule exists to stop a cell reading `ready` when nothing on earth
// could start it, and a lazy `hasWakeSource: true` would recreate exactly that.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { webhookEndpoints, webhookTriggers } from '../src/db/schema'
import { gatherReadinessFacts } from '../src/modules/code-capability/application/readinessFacts'
import { deriveReadiness } from '../src/modules/code-capability/domain/templateLayers'
import { ulid } from 'ulid'
import { CAPABILITY_LAUNCH_KIND } from '../src/services/codeCapabilityTrigger'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ENDPOINT = 'ep-1'
const REPO = 'repo-1'

describe('RFC-304 — a ci-fix cell’s wake source is its pipeline event', () => {
  let db: DbClient

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await db.insert(webhookEndpoints).values({
      id: ENDPOINT,
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

  /** A capability trigger for this repo, firing on the given events. */
  const seedTrigger = async (events: readonly string[], capability = 'ci-fix'): Promise<void> => {
    await db.insert(webhookTriggers).values({
      id: ulid(),
      endpointId: ENDPOINT,
      name: `${capability} trigger`,
      enabled: true,
      eventTypes: JSON.stringify(events),
      repoScope: JSON.stringify({ paths: [REPO] }),
      launchKind: CAPABILITY_LAUNCH_KIND,
      launchRefId: capability,
      launchPayload: '{}',
      ignoreUsernames: '[]',
      ownerUserId: 'user-1',
      createdAt: 1,
      updatedAt: 1,
    })
  }

  const factsFor = async (capability: string) =>
    await gatherReadinessFacts({
      db,
      repoId: REPO,
      capability,
      endpointId: ENDPOINT,
      bindingId: 'binding-1',
      enabled: true,
      provider: 'gitlab',
    })

  test('a pipeline event IS a wake source', async () => {
    // The regression. Before this, the answer was `false` no matter what the
    // repository had configured, so `ci-fix` could not be made ready by any
    // action a user could take.
    await seedTrigger(['pipeline_failed'])
    const facts = await factsFor('ci-fix')

    expect(facts.hasWakeSource).toBe(true)
    expect(deriveReadiness(facts).issues.map((i) => i.code)).not.toContain('no-wake-source')
  })

  test('a trigger with NO pipeline event is not a wake source', async () => {
    // The direction the rule exists for (AC-14d), and the reason this is
    // derived rather than set to a constant `true`: somebody who narrowed the
    // cell's events to merge-request ones has left `ci-fix` unable to start,
    // and the matrix must say so instead of showing a confident `ready`.
    await seedTrigger(['mr_updated', 'note'])
    const facts = await factsFor('ci-fix')

    expect(facts.hasWakeSource).toBe(false)
    expect(deriveReadiness(facts).issues.map((i) => i.code)).toContain('no-wake-source')
  })

  test('a succeeded pipeline counts too — the monitor is woken by both', async () => {
    // Not only `pipeline_failed`: the monitor subscribes to both, and a green
    // pipeline is what ends a fix campaign. Matching on the family rather than
    // one literal keeps this from going stale the next time an event is added.
    await seedTrigger(['pipeline_succeeded'])
    expect((await factsFor('ci-fix')).hasWakeSource).toBe(true)
  })

  test('no trigger at all reports the missing TRIGGER, and no wake source', async () => {
    // Both are true and both are reported; the repair for the first is the one
    // a person acts on, and it necessarily fixes the second.
    const facts = await factsFor('ci-fix')
    expect({ hasTrigger: facts.hasTrigger, hasWakeSource: facts.hasWakeSource }).toEqual({
      hasTrigger: false,
      hasWakeSource: false,
    })
    expect(deriveReadiness(facts).issues.map((i) => i.code)).toContain('no-trigger')
  })

  test('mr-review is unaffected — it needs no wake source', async () => {
    // The reverse guard: requiring one unconditionally would make every
    // review-only repository permanently misconfigured.
    await seedTrigger(['mr_updated'], 'mr-review')
    const facts = await factsFor('mr-review')

    expect(facts.requiresWakeSource).toBe(false)
    expect(deriveReadiness(facts).issues.map((i) => i.code)).not.toContain('no-wake-source')
  })

  test('an unreadable event list reads as EMPTY, not as a missing trigger', async () => {
    // A corrupt row must not masquerade as "no trigger": that answer sends an
    // operator to create a second trigger, which will not help and leaves two
    // rows behind. Empty events say the truthful thing — the trigger is there
    // and nothing it carries can start this capability.
    await db.insert(webhookTriggers).values({
      id: ulid(),
      endpointId: ENDPOINT,
      name: 'corrupt',
      enabled: true,
      eventTypes: '{not json',
      repoScope: JSON.stringify({ paths: [REPO] }),
      launchKind: CAPABILITY_LAUNCH_KIND,
      launchRefId: 'ci-fix',
      launchPayload: '{}',
      ignoreUsernames: '[]',
      ownerUserId: 'user-1',
      createdAt: 1,
      updatedAt: 1,
    })

    const facts = await factsFor('ci-fix')
    expect({ hasTrigger: facts.hasTrigger, hasWakeSource: facts.hasWakeSource }).toEqual({
      hasTrigger: true,
      hasWakeSource: false,
    })
  })
})

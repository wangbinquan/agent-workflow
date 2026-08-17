// RFC-309 T22 — starting a round from a template, inside the platform.
//
// Why this file matters more than its size suggests: before it, the platform
// had NO WAY to start a capability round. `openRound` had three callers and all
// three traced back to `webhookDispatch`, so "I want to run this template" had
// no answer that did not involve going to GitLab and labelling an issue.
// RFC-304's own plan recorded the debt (T46b) and it stayed open.
//
// The cases below are chosen around the two things a launch entrance gets wrong:
//
//   · it accepts a request it cannot finish — a template with an empty agent
//     slot fails HALFWAY, after the round has taken the merge-request lease,
//     so the check has to happen before anything is written;
//   · it is stricter than it needs to be — requiring the matrix cell to be
//     enabled would mean "try this template once" needs a webhook trigger
//     configured first, which is the friction the entrance exists to remove.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { agents, capabilityTemplates, codeWorkItems, webhookEndpoints } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import type { Permission } from '@agent-workflow/shared'
import { createLaunchRoundCommand } from '../src/modules/code-capability/application/launchRoundCommand'
import { anchorFor, isPlatformOrigin } from '../src/modules/code-capability/domain/launchInput'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

const ACTOR = {
  user: { id: 'u1', name: 'u1', role: 'admin' },
  permissions: new Set<Permission>(['code-rounds:launch', 'resource-acl:bypass']),
  source: 'session',
} as unknown as Actor

async function seed(db: DbClient, over: { agentBySlot?: Record<string, string> } = {}) {
  await db.insert(webhookEndpoints).values({
    id: 'ep-1',
    name: 'gl',
    provider: 'gitlab',
    urlToken: 'aw_whk_launch_fixture_00000000',
    secretEnc: 'sealed',
    enabled: true,
  })
  await db.insert(agents).values({
    id: 'agent-1',
    name: 'reviewer',
    bodyMd: 'x',
    visibility: 'public',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await db.insert(capabilityTemplates).values({
    id: 'tpl-1',
    name: 'review template',
    capability: 'mr-review',
    agentBySlotJson: JSON.stringify(over.agentBySlot ?? { reviewer: 'agent-1' }),
    visibility: 'public',
    createdAt: NOW,
    updatedAt: NOW,
  })
}

const REVIEW = { capability: 'mr-review', mrIid: '42' } as const

describe('RFC-309 — the anchor a launch attaches to', () => {
  test('a platform requirement gets a MINTED anchor, not a fake issue number', () => {
    // Reusing `issue` with a synthetic id would make every query on the anchor
    // index treat it as a real issue on the code host.
    const anchor = anchorFor(
      { capability: 'requirement', title: 't', body: '', documents: [] },
      () => 'minted-1',
    )
    expect(anchor).toEqual({ anchorKind: 'platform', anchorId: 'minted-1' })
  })

  test('two launches of the same requirement are two pieces of work', () => {
    let n = 0
    const mint = () => `id-${String(++n)}`
    const input = { capability: 'requirement' as const, title: 'same', body: '', documents: [] }
    expect(anchorFor(input, mint).anchorId).not.toBe(anchorFor(input, mint).anchorId)
  })

  test('the code-host capabilities anchor on the thing they act on', () => {
    expect(anchorFor(REVIEW)).toEqual({ anchorKind: 'mr', anchorId: '42' })
    expect(anchorFor({ capability: 'ci-fix', pipelineId: '99' })).toEqual({
      anchorKind: 'pipeline',
      anchorId: '99',
    })
    // A comment fix anchors on the MR, not the discussion: a second comment on
    // the same merge request must find the SAME work item rather than opening a
    // rival one holding the same lease.
    expect(anchorFor({ capability: 'mr-comment-fix', mrIid: '42', discussionId: 'd-7' })).toEqual({
      anchorKind: 'mr',
      anchorId: '42',
    })
  })

  test('only the platform-started capability routes clarifications to the platform', () => {
    // `clarifyRouting`'s ruling is "ask where it was asked from". Getting this
    // backwards would post a question onto a merge request for someone who is
    // watching the platform, or vice versa.
    expect(
      isPlatformOrigin({ capability: 'requirement', title: 't', body: '', documents: [] }),
    ).toBe(true)
    expect(isPlatformOrigin(REVIEW)).toBe(false)
  })
})

describe('RFC-309 — launching', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  const launch = (over: Record<string, unknown> = {}) =>
    createLaunchRoundCommand(
      db,
      () => NOW,
      () => 'minted',
    ).run({
      repoId: 'group/project',
      templateId: 'tpl-1',
      input: REVIEW,
      actor: ACTOR,
      ...over,
    } as never)

  test('a round opens WITHOUT the matrix cell being enabled — D4', async () => {
    // The positive half of AC-8, and the reason the entrance is usable: no
    // capability was switched on for this repository and no trigger exists.
    await seed(db)
    const result = await launch()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.roundSeq).toBe(1)

    const [item] = await db.select().from(codeWorkItems)
    expect(item?.anchorKind).toBe('mr')
    expect(item?.anchorId).toBe('42')
    // Who pressed start, kept for the audit trail — and never handed to a model.
    expect(item?.initiatorUserId).toBe('u1')
  })

  test('a repository with no code host is refused, by name', async () => {
    await seed(db)
    await db.delete(webhookEndpoints)
    const result = await launch()
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('repo-unresolvable')
  })

  test('a template that drives another capability is refused', async () => {
    await seed(db)
    const result = await launch({ input: { capability: 'ci-fix', pipelineId: '7' } })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('template-capability-mismatch')
  })

  test('a template with an unfilled slot is refused BEFORE anything is written', async () => {
    // The failure this check exists for: without it the round opens, takes the
    // merge-request lease, and dies at its first AI stage — leaving a lease on
    // somebody's MR for a round that never had a chance.
    await seed(db, { agentBySlot: {} })
    const result = await launch()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('template-incomplete')
    // Names the slot. "Incomplete" alone moves the question rather than
    // answering it.
    expect(result.message).toContain('reviewer')
    expect(await db.select().from(codeWorkItems)).toEqual([])
  })

  test('a template naming an agent that is gone is refused', async () => {
    await seed(db)
    await db.delete(agents)
    const result = await launch()
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('agent-not-visible')
  })

  test('an invisible template answers exactly like a missing one', async () => {
    // RFC-099 existence isolation: a distinguishable 403 turns the status code
    // into an oracle for "does this id exist".
    await seed(db)
    const result = await launch({ templateId: 'no-such-template' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('template-not-visible')
  })

  test('a platform requirement records that its questions go to the platform', async () => {
    // AC-10. The origin is written at LAUNCH because it is a fact about the
    // entrance, and the entrance is not knowable afterwards.
    await seed(db)
    await db.update(capabilityTemplates).set({
      capability: 'requirement',
      agentBySlotJson: JSON.stringify({ analyst: 'agent-1', implementer: 'agent-1' }),
    })
    const result = await createLaunchRoundCommand(
      db,
      () => NOW,
      () => 'minted',
    ).run({
      repoId: 'group/project',
      templateId: 'tpl-1',
      input: { capability: 'requirement', title: 'add retries', body: '', documents: [] },
      actor: ACTOR,
    })
    expect(result.ok).toBe(true)
    const [item] = await db.select().from(codeWorkItems)
    expect(item?.anchorKind).toBe('platform')
    expect(item?.anchorId).toBe('minted')
  })
})

describe('RFC-309 — the launch route names every code it can throw', () => {
  // The repo's error-code ratchet: a code no test names is one nobody has seen
  // fire, and the first person to hit it in production gets a string with no
  // documented meaning.
  const TOKEN = 'a'.repeat(64)
  let db: DbClient
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    app = createApp({ token: TOKEN, configPath: '', opencodeVersion: '1.15.0', dbVersion: 1, db })
  })
  afterEach(() => db.$client.close())

  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

  const post = async (body: unknown) =>
    await app.request('/api/code/rounds', { method: 'POST', headers, body: JSON.stringify(body) })

  test('a malformed body', async () => {
    const res = await post({ repoId: '' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('code-launch-invalid')
  })

  test('an input that does not match its capability is refused at the schema', async () => {
    // The discriminated union earning its keep: `mr-review` with a requirement's
    // fields never reaches the command.
    const res = await post({
      repoId: 'group/project',
      templateId: 'tpl-1',
      input: { capability: 'mr-review', title: 'wrong shape' },
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('code-launch-invalid')
  })

  test('an unresolvable repository', async () => {
    const res = await post({ repoId: 'nobody/here', templateId: 'tpl-1', input: REVIEW })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('code-launch-repo-unresolvable')
  })

  test('an unknown template', async () => {
    await seed(db)
    const res = await post({ repoId: 'group/project', templateId: 'gone', input: REVIEW })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('code-launch-template-not-found')
  })

  test('a template driving another capability', async () => {
    await seed(db)
    const res = await post({
      repoId: 'group/project',
      templateId: 'tpl-1',
      input: { capability: 'ci-fix', pipelineId: '7' },
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('code-launch-capability-mismatch')
  })

  test('a template with an unfilled slot', async () => {
    await seed(db, { agentBySlot: {} })
    const res = await post({ repoId: 'group/project', templateId: 'tpl-1', input: REVIEW })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('code-launch-template-incomplete')
  })

  test('a template naming an agent that is gone', async () => {
    await seed(db)
    await db.delete(agents)
    const res = await post({ repoId: 'group/project', templateId: 'tpl-1', input: REVIEW })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('code-launch-agent-not-visible')
  })

  test('a successful launch returns the receipt — AC-9', async () => {
    await seed(db)
    const res = await post({ repoId: 'group/project', templateId: 'tpl-1', input: REVIEW })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { roundId: string; workItemId: string; roundSeq: number }
    expect(body.roundId).toBeTruthy()
    expect(body.workItemId).toBeTruthy()
    expect(body.roundSeq).toBe(1)
  })

  test('without a bearer token it is refused', async () => {
    expect((await app.request('/api/code/rounds', { method: 'POST' })).status).toBe(401)
  })
})

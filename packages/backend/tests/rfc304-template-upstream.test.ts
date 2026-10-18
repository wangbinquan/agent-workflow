import { composeCapabilityTemplateOperations } from '../src/modules/code-capability/composition/capabilityTemplateOperations'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
// RFC-304 §11.6 (T64) — the four states, and the base that makes them knowable.
//
// Copying is how teams start, so within a quarter there are dozens of templates
// descended from a handful of originals. Then the original gets a fix and
// nobody downstream hears about it. The failure is quiet in both directions:
//
//   no link            — an upstream fix never reaches the copies, and five
//                        teams debug the same bug separately;
//   link, no base      — "update from upstream" silently discards the local
//                        changes that were the whole reason for copying.
//
// The BASE is what separates those. Without it, "upstream says A, local says B"
// cannot distinguish "upstream changed it" from "local changed it", so a
// two-way merge guesses — and is wrong half the time on exactly the fields
// somebody cared enough to edit.

import { describe, expect, test } from 'bun:test'

import type { Actor } from '../src/auth/actor'
import { createCapabilityTemplatePersistence } from '../src/modules/code-capability/infrastructure/capabilityTemplatePersistence'
import { readUpstreamReport } from '../src/modules/code-capability/application/templateUpstreamStatus'
import { createTemplateUpstreamPersistence } from '../src/modules/code-capability/infrastructure/templateUpstreamPersistence'
import { updateResourceAcl } from '../src/services/resourceAcl'
import {
  judgeUpstream,
  mergeUnoverridden,
  packagedUpstreamState,
  resolveThreeWay,
  type UpstreamLink,
} from '../src/modules/code-capability/domain/templateUpstream'

const link: UpstreamLink = { upstreamId: 'fw-1', upstreamVersion: 100, baseDigest: 'd0' }

describe('RFC-304 T64 — the four states', () => {
  test('upstream unchanged is current', () => {
    const s = judgeUpstream({
      link,
      upstreamVersionNow: 100,
      localDigest: 'd0',
      localOverrides: [],
    })
    expect(s.state).toBe('current')
  })

  test('local edits ALONE are not a state — a customised copy is doing its job', () => {
    // Flagging this would put a permanent badge on every template anyone
    // customised, which is all of them, which means the badge stops meaning
    // anything.
    const s = judgeUpstream({
      link,
      upstreamVersionNow: 100,
      localDigest: 'd9',
      localOverrides: ['paramDefaults'],
    })
    expect(s.state).toBe('current')
    expect(s.message).toContain('local changes are intact')
  })

  test('upstream moved with no local edits can fast-forward', () => {
    const s = judgeUpstream({
      link,
      upstreamVersionNow: 101,
      localDigest: 'd0',
      localOverrides: [],
    })
    expect(s.state).toBe('update-available')
    expect(s.message).toContain('cleanly')
  })

  test('upstream moved AND edited locally is a decision, not an auto-merge', () => {
    const s = judgeUpstream({
      link,
      upstreamVersionNow: 101,
      localDigest: 'd9',
      localOverrides: ['scripts', 'paramDefaults'],
    })
    expect(s.state).toBe('conflicted')
    expect(s.message).toContain('2 field(s)')
  })

  test('a deleted upstream is ORPHANED, checked before anything else', () => {
    // Reporting `current` here would be the most misleading of the four: it
    // says "nothing to do" about a link that can never be followed again.
    const s = judgeUpstream({
      link,
      upstreamVersionNow: null,
      localDigest: 'd0',
      localOverrides: [],
    })
    expect(s.state).toBe('orphaned')
    expect(s.message).toContain('no longer exists')
  })

  test('orphaned wins even when there are local edits', () => {
    const s = judgeUpstream({
      link,
      upstreamVersionNow: null,
      localDigest: 'd9',
      localOverrides: ['scripts'],
    })
    expect(s.state).toBe('orphaned')
  })
})

describe('RFC-304 T64 — the three-way diff', () => {
  test('only upstream changed: take it', () => {
    const [r] = resolveThreeWay([{ field: 'a', base: 1, upstream: 2, local: 1 }])
    expect(r).toEqual({ field: 'a', action: 'take-upstream', value: 2 })
  })

  test('only local changed: keep it', () => {
    const [r] = resolveThreeWay([{ field: 'a', base: 1, upstream: 1, local: 9 }])
    expect(r).toEqual({ field: 'a', action: 'keep-local', value: 9 })
  })

  test('both changed differently: a person decides', () => {
    const [r] = resolveThreeWay([{ field: 'a', base: 1, upstream: 2, local: 9 }])
    expect(r?.action).toBe('conflict')
  })

  test('both changed to the SAME value is not a conflict', () => {
    // A team that independently made the same fix should not be asked to
    // adjudicate between two identical answers.
    const [r] = resolveThreeWay([{ field: 'a', base: 1, upstream: 7, local: 7 }])
    expect(r?.action).toBe('unchanged')
  })

  test('key ORDER is not a change', () => {
    // Otherwise a round trip through JSON manufactures a conflict on a field
    // nobody touched — and every template that has been exported and imported
    // would arrive permanently "conflicted".
    const [r] = resolveThreeWay([
      {
        field: 'params',
        base: { a: 1, b: 2 },
        upstream: { b: 2, a: 1 },
        local: { a: 1, b: 2 },
      },
    ])
    expect(r?.action).toBe('unchanged')
  })

  test('nested objects compare by content, not identity', () => {
    const [r] = resolveThreeWay([
      {
        field: 'scripts',
        base: { collect: { language: 'node', script: 'x' } },
        upstream: { collect: { script: 'x', language: 'node' } },
        local: { collect: { language: 'node', script: 'x' } },
      },
    ])
    expect(r?.action).toBe('unchanged')
  })
})

describe('RFC-304 T64 — “merge only what I have not overridden”', () => {
  test('it takes upstream, keeps local, and leaves conflicts alone', () => {
    // Silently choosing upstream on a conflict discards the local change that
    // was the reason for copying; choosing local makes "update from upstream"
    // do nothing on precisely the fields the fix was about. So it does neither.
    const merged = mergeUnoverridden(
      resolveThreeWay([
        { field: 'a', base: 1, upstream: 2, local: 1 },
        { field: 'b', base: 1, upstream: 1, local: 9 },
        { field: 'c', base: 1, upstream: 2, local: 9 },
        { field: 'd', base: 1, upstream: 1, local: 1 },
      ]),
    )
    expect(merged.applied).toEqual(['a'])
    expect(merged.keptLocal).toEqual(['b'])
    expect(merged.stillConflicted).toEqual(['c'])
  })
})

describe('RFC-304 T64 — what a package says about origin', () => {
  test('an instance that cannot resolve the upstream reports DETACHED', () => {
    // The honest answer. Reporting `linked` would claim a relationship the
    // destination cannot check, and the first "update from upstream" there
    // would fail on a link the page said was fine.
    expect(packagedUpstreamState({ link, upstreamResolvableHere: false })).toBe('detached')
  })

  test('an instance that has the upstream reports linked', () => {
    expect(packagedUpstreamState({ link, upstreamResolvableHere: true })).toBe('linked')
  })

  test('a template nobody copied has no origin at all', () => {
    expect(packagedUpstreamState({ link: null, upstreamResolvableHere: false })).toBe('none')
  })
})

// The join: the link is written at COPY time. A rule with no writer would leave
// every copy `orphaned`-looking forever, and the three facts it needs cannot be
// reconstructed later — after the copy, the source moves on and its `updatedAt`
// no longer describes what was taken.
function templateCopyInputs() {
  const AUTHOR = {
    user: { id: 'u-1', name: 'u-1', role: 'user' },
    permissions: new Set(['capability-templates:create', 'scripts:author']),
    source: 'session',
  } as unknown as Actor
  const FRAMEWORK = {
    name: 'gitlab standard',
    description: null,
    capability: 'mr-review',
    scripts: { collect: { language: 'node' as const, script: 'console.log(1)' } },
    hooks: [],
    paramSchema: [],
    paramDefaults: {},
    agentBySlot: {},
    promptBySlot: {},
    params: {},
    stageContractVer: 1,
  }
  return { AUTHOR, FRAMEWORK }
}

const { AUTHOR, FRAMEWORK } = templateCopyInputs()

describeEachProvider('RFC-304 T64 — copying records the origin', (harness) => {
  test('a fresh template has NO origin — that is a state, not missing data', async () => {
    const db = harness.db
    const row = await createTemplate(db, FRAMEWORK, AUTHOR, 1000)
    expect(row.upstreamId).toBeNull()
    expect(row.baseDigest).toBeNull()
  })

  test('a copy records source, version and base digest together', async () => {
    const db = harness.db
    const source = await createTemplate(db, FRAMEWORK, AUTHOR, 1000)
    const copy = await copyTemplate(db, source, AUTHOR, 'mine', 2000)

    expect(copy.upstreamId).toBe(source.id)
    expect(copy.upstreamVersion).toBe(source.updatedAt)
    expect(copy.baseDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  test('the base digest matches the source at copy time, so a fresh copy is CURRENT', async () => {
    // The copied body must reproduce the source's digest despite its new identity.
    // Copying it again exposes that digest without exporting a private helper.
    const db = harness.db
    const source = await createTemplate(db, FRAMEWORK, AUTHOR, 1000)
    const copy = await copyTemplate(db, source, AUTHOR, 'mine', 2000)
    const copyOfCopy = await copyTemplate(db, copy, AUTHOR, 'same body', 3000)
    expect(copy.baseDigest).not.toBeNull()
    expect(copyOfCopy.baseDigest).toBe(copy.baseDigest)

    const report = await readUpstreamReport(createTemplateUpstreamPersistence(db), copy.id)
    expect(report).toMatchObject({
      link: { upstreamId: source.id, upstreamVersion: source.updatedAt },
      baseRecorded: true,
      status: { state: 'current', localOverrides: [] },
    })
    expect(report?.fields.every((field) => field.action === 'unchanged')).toBe(true)
  })

  test('the digest ignores the ACL, so a visibility change is not a body change', async () => {
    // Otherwise grant edits would look like body edits and healthy copies would
    // stop being comparable. Compare the live copy receipts on both sides.
    const db = harness.db
    const owner = {
      ...AUTHOR,
      permissions: new Set(AUTHOR.permissions).add('resource-acl:private'),
    }
    const source = await createTemplate(db, FRAMEWORK, owner, 1000)
    const copy = await copyTemplate(db, source, owner, 'mine', 2000)
    await updateResourceAcl(
      db,
      owner,
      'capability_template',
      source,
      {
        expectedResourceId: source.id,
        expectedAclRevision: source.aclRevision,
        visibility: 'public',
      },
      { updatedAt: 3000 },
    )
    const upstream = await storedTemplate(db, source.id)
    expect(upstream.visibility).toBe('public')
    expect(upstream.aclRevision).toBe(source.aclRevision + 1)
    const afterAclChange = await copyTemplate(db, upstream, owner, 'after ACL change', 4000)
    expect(afterAclChange.baseDigest).toBe(copy.baseDigest)

    const report = await readUpstreamReport(createTemplateUpstreamPersistence(db), copy.id)
    expect(report?.fields.every((field) => field.action === 'unchanged')).toBe(true)
    // The live ACL writer also advances updatedAt. Status follows that version,
    // not the body digest, so it advertises an update with no changed fields.
    expect(upstream.updatedAt).toBe(3000)
    expect(report?.status).toMatchObject({ state: 'update-available', localOverrides: [] })
  })

  test('the digest DOES change when a script body changes', async () => {
    // A real upstream fix must reach copies as an available update; ignoring
    // scripts in the digest would make two different bodies share a base.
    const db = harness.db
    const source = await createTemplate(db, FRAMEWORK, AUTHOR, 1000)
    const copy = await copyTemplate(db, source, AUTHOR, 'mine', 2000)
    const scripts = { collect: { language: 'node' as const, script: 'console.log(2)' } }
    const upstream = await templateOperations(db, 3000).update(AUTHOR, source.id, {
      ...FRAMEWORK,
      scripts,
    })
    const afterScriptChange = await copyTemplate(db, upstream, AUTHOR, 'after script change', 4000)
    expect(afterScriptChange.baseDigest).not.toBe(copy.baseDigest)

    const report = await readUpstreamReport(createTemplateUpstreamPersistence(db), copy.id)
    expect(report?.status).toMatchObject({ state: 'update-available', localOverrides: [] })
    expect(report?.fields).toContainEqual({
      field: 'scripts',
      action: 'take-upstream',
      value: scripts,
    })
  })
})

// RFC-375: writes use the live operation API; persistence reads inspect stored receipts.
function templateOperations(db: ProviderNeutralDatabase, now?: number) {
  return composeCapabilityTemplateOperations({
    db,
    ...(now === undefined ? {} : { now: () => now }),
    access: {
      filterVisible: async (_actor, rows) => [...rows],
      canView: async () => true,
      requireEdit: async () => 'own' as const,
      requireGovern: async () => {},
      assertNameUnchangedForEditor: () => {},
    },
  })
}
async function storedTemplate(db: ProviderNeutralDatabase, id: string) {
  const row = await createCapabilityTemplatePersistence(db).load(id)
  if (row === null) throw new Error(`missing template ${id}`)
  return row
}
async function createTemplate(
  db: ProviderNeutralDatabase,
  raw: unknown,
  actor: Actor,
  now?: number,
) {
  const result = await templateOperations(db, now).create(actor, raw)
  return storedTemplate(db, result.id)
}
async function copyTemplate(
  db: ProviderNeutralDatabase,
  source: { readonly id: string },
  actor: Actor,
  name?: string,
  now?: number,
) {
  const result = await templateOperations(db, now).copy(
    actor,
    source.id,
    name === undefined ? {} : { name },
  )
  return storedTemplate(db, result.id)
}

// RFC-370 v3 V6 — the one platform-neutral hosted object publication journal
// (system-operations `hosted_object_publications`). Locks: owner references
// commit in the ready transaction; abandoned uploads are resolved without
// bytes; owner release is unpinned only behind the backup release horizon;
// links pin without copying; settled rows are purged; nothing here blocks a
// backup. Replaces the six per-owner journals deleted by §9.3.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  developmentObjectArtifacts,
  hostedDatabaseBackups,
  hostedObjectPublications,
} from '@/db/schema'
import { createHostedBackupReleaseHorizon } from '@/modules/system-operations/infrastructure/crewstation/backupReleaseHorizon'
import {
  createHostedObjectPublications,
  hostedPublicationId,
  hostedPublicationPin,
  HOSTED_PUBLICATION_ABANDON_MS,
  HOSTED_PUBLICATION_RETENTION_MS,
} from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import type {
  HostedObjectContent,
  HostedObjectOwnerSweep,
} from '@/modules/system-operations/public/participants'
import { describeEachProvider } from './helpers/eachProvider'
import { objectFixture } from './helpers/rfc370Objects'

const content = (text: string): HostedObjectContent => ({
  sha256: createHash('sha256').update(text).digest('hex'),
  size: Buffer.byteLength(text),
  open: () => new Response(text).body!,
})
const unopenable = (text: string): HostedObjectContent => ({
  ...content(text),
  open: () => {
    throw new Error('must not reopen published bytes')
  },
})

describeEachProvider('RFC-370 hosted object publication journal', (harness) => {
  function fixture(options: { sealer?: boolean } = {}) {
    const objects = objectFixture()
    let epoch = 1,
      held = true,
      timestamp = 1_000_000
    const fence = {
      current: () => ({ epoch, leaseId: `lease-${epoch}`, instanceId: `slot-${epoch}` }),
      async assertHeld(_tx: unknown, expected: { epoch: number }) {
        if (!held || expected.epoch !== epoch) throw new Error('object-publication-fence-lost')
      },
    }
    const journal = createHostedObjectPublications({
      db: harness.db,
      fence,
      objects: objects.objects,
      now: () => timestamp,
      ...(options.sealer
        ? {
            sealer: {
              seal: (plain: string) => `sealed:${plain}`,
              unseal: (packed: string) => packed.slice('sealed:'.length),
            },
          }
        : {}),
    })
    const horizon = createHostedBackupReleaseHorizon({ db: harness.db })
    return {
      ...objects,
      journal,
      publications: journal.publications,
      maintenance: (sweeps: readonly HostedObjectOwnerSweep[] = []) =>
        journal.maintenance({ horizon, sweeps }),
      row: async (owner: string, key: string) =>
        (
          await harness.db
            .select()
            .from(hostedObjectPublications)
            .where(eq(hostedObjectPublications.id, hostedPublicationId(owner, key)))
        )[0],
      advance: (ms: number) => {
        timestamp += ms
      },
      now: () => timestamp,
      rotate: () => {
        epoch++
        held = true
      },
      lose: () => {
        held = false
      },
    }
  }

  test('publish uploads once, pins one lifetime and commits the owner row in the ready transaction', async () => {
    const f = fixture()
    const bytes = content('evidence 正文')
    const [object] = await f.publications.publish(
      [{ owner: 'development-evidence', key: `blob:${bytes.sha256}`, content: bytes }],
      {
        commit: async (tx, [receipt]) => {
          await tx.insert(developmentObjectArtifacts).values({
            reference: `blob:${bytes.sha256}`,
            objectId: receipt!.id,
            digest: receipt!.sha256,
            size: receipt!.size,
            createdAt: 1,
          })
        },
      },
    )
    const row = await f.row('development-evidence', `blob:${bytes.sha256}`)
    expect(row).toMatchObject({ state: 'ready', objectId: object!.id, sourceSealed: null })
    expect(f.pins).toEqual([hostedPublicationPin(row!)])
    expect(await harness.db.select().from(developmentObjectArtifacts)).toHaveLength(1)
    // A repeated publication reuses the receipt without reopening the source.
    const [again] = await f.publications.publish([
      {
        owner: 'development-evidence',
        key: `blob:${bytes.sha256}`,
        content: unopenable('evidence 正文'),
      },
    ])
    expect(again).toEqual(object!)
    expect(await f.publications.find('development-evidence', `blob:${bytes.sha256}`)).toEqual(
      object!,
    )
    await expect(
      f.publications.publish([
        { owner: 'development-evidence', key: `blob:${bytes.sha256}`, content: content('changed') },
      ]),
    ).rejects.toThrow('hosted-object-publication-content-changed')
    expect(f.releases).toEqual([])
  })

  test('concurrent publishers of one key share one lifetime and one object', async () => {
    const f = fixture()
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        f.publications.publish([
          { owner: 'employee-content', key: 'employee-input/x', content: content('same') },
        ]),
      ),
    )
    expect(new Set(results.map(([object]) => object!.id)).size).toBe(1)
    expect(new Set(f.pins).size).toBe(1)
  })

  test('a failed owner commit leaves an orphan pending row that maintenance releases', async () => {
    const f = fixture()
    await expect(
      f.publications.publish(
        [{ owner: 'task-artifact', key: 'runs/t1/ports/a', scope: 't1', content: content('a') }],
        {
          commit: async () => {
            throw new Error('owner-commit-refused')
          },
        },
      ),
    ).rejects.toThrow('owner-commit-refused')
    const pending = await f.row('task-artifact', 'runs/t1/ports/a')
    expect(pending).toMatchObject({ state: 'pending', objectId: null })
    // Same epoch and recent: a live writer may still finish, so it is untouched.
    expect(await f.maintenance().run()).toMatchObject({ resolved: 0, released: 0 })
    f.advance(HOSTED_PUBLICATION_ABANDON_MS + 1)
    expect(await f.maintenance().run()).toMatchObject({ resolved: 1, released: 1 })
    expect(await f.row('task-artifact', 'runs/t1/ports/a')).toMatchObject({ state: 'released' })
    expect(f.releases).toEqual([hostedPublicationPin(pending!)])
  })

  test('an abandoned upload whose bytes never arrived settles without a platform release', async () => {
    const f = fixture()
    const bytes = content('never uploaded')
    await harness.db.insert(hostedObjectPublications).values({
      id: hostedPublicationId('task-artifact', 'runs/t2/inputs/manifest.json'),
      owner: 'task-artifact',
      logicalKey: 'runs/t2/inputs/manifest.json',
      scope: 't2',
      attempt: 'attempt-1',
      state: 'pending',
      sha256: bytes.sha256,
      size: bytes.size,
      epoch: 1,
      createdAt: f.now(),
      updatedAt: f.now(),
    })
    f.rotate()
    expect(await f.maintenance().run()).toMatchObject({ resolved: 1 })
    expect(await f.row('task-artifact', 'runs/t2/inputs/manifest.json')).toMatchObject({
      state: 'released',
      objectId: null,
    })
    expect(f.releases).toEqual([])
  })

  test('a link pins an existing object without copying and releases independently', async () => {
    const f = fixture()
    const [object] = await f.publications.publish([
      {
        owner: 'task-artifact',
        key: 'runs/t3/ports/p',
        scope: 't3',
        content: content('port bytes'),
      },
    ])
    const [linked] = await f.publications.publish([
      { owner: 'task-archive', key: 'part:1', object: object! },
    ])
    expect(linked).toEqual(object!)
    expect(f.stored.size).toBe(1)
    expect(f.activeReferences(object!.id)).toBe(2)
    expect(await f.publications.release({ owner: 'task-archive', keys: ['part:1'] })).toBe(1)
    expect(await f.maintenance().run()).toMatchObject({ released: 1 })
    expect(f.activeReferences(object!.id)).toBe(1)
    expect(await f.row('task-artifact', 'runs/t3/ports/p')).toMatchObject({ state: 'ready' })
  })

  test('release selects by keys, scope and key prefix within one owner, inside the owner transaction', async () => {
    const f = fixture()
    await f.publications.publish([
      { owner: 'agent-material', key: 'e1/a', scope: 'task-a', bytes: Buffer.from('a') },
      { owner: 'agent-material', key: 'e1/b', scope: 'task-a', bytes: Buffer.from('b') },
      { owner: 'agent-material', key: 'e2/c', scope: 'task-b', bytes: Buffer.from('c') },
      { owner: 'task-artifact', key: 'e1/x', scope: 'task-a', bytes: Buffer.from('x') },
    ])
    await expect(
      harness.session.transaction(async (tx) => {
        await f.publications.release({ owner: 'agent-material', scope: 'task-a' }, tx)
        throw new Error('owner-rolled-back')
      }),
    ).rejects.toThrow('owner-rolled-back')
    expect(await f.row('agent-material', 'e1/a')).toMatchObject({ state: 'ready' })
    expect(await f.publications.release({ owner: 'agent-material', keyPrefix: 'e1/' })).toBe(2)
    expect(await f.publications.release({ owner: 'agent-material', scope: 'task-b' })).toBe(1)
    expect(await f.row('task-artifact', 'e1/x')).toMatchObject({ state: 'ready' })
    expect(await f.publications.release({ owner: 'agent-material', keys: ['e1/a'] })).toBe(0)
    await expect(f.publications.release({ owner: 'agent-material' })).rejects.toThrow(
      'hosted-object-publication-selection-empty',
    )
  })

  test('the release horizon keeps objects any retained backup may reference', async () => {
    const f = fixture()
    const backup = async (
      id: string,
      state: 'building' | 'ready' | 'failed',
      createdAt: number,
      snapshotAt: number | null,
    ) =>
      harness.db.insert(hostedDatabaseBackups).values({
        id,
        epoch: 1,
        kind: 'manual',
        state,
        activeSlot: state === 'building' ? 'global' : null,
        ...(state === 'ready'
          ? {
              objectId: '01a13e6d-3e00-7000-9e3c-0000000000ff',
              sha256: 'a'.repeat(64),
              sizeBytes: 1,
              schemaDigest: `sha256:${'b'.repeat(64)}`,
              sourceGenerationId: 'dbg_hosted_test',
              contentsJson: '{"workflows":0,"skills":0}',
              snapshotAt,
            }
          : {}),
        createdAt,
        updatedAt: createdAt,
      })
    const start = f.now()
    await f.publications.publish([
      { owner: 'task-artifact', key: 'k1', scope: 't', bytes: Buffer.from('one') },
    ])
    // A failed backup protects nothing; a ready backup taken while the
    // reference existed protects it.
    await backup('01a13e6d-3e00-7000-9e3c-0000000000a1', 'failed', start + 10, null)
    await backup('01a13e6d-3e00-7000-9e3c-0000000000a2', 'ready', start + 20, start + 30)
    f.advance(60 * 60_000)
    await f.publications.release({ owner: 'task-artifact', keys: ['k1'] })
    expect(await f.maintenance().run()).toMatchObject({ protected: 1, released: 0 })
    expect(f.releases).toEqual([])
    // Once that backup is released, the object is unpinned on a later pass.
    await harness.db
      .update(hostedDatabaseBackups)
      .set({ state: 'released' })
      .where(eq(hostedDatabaseBackups.id, '01a13e6d-3e00-7000-9e3c-0000000000a2'))
    f.advance(2 * 60 * 60_000)
    expect(await f.maintenance().run()).toMatchObject({ released: 1 })
    // An object created after a snapshot and released before a later backup
    // started overlaps no window and is released at once.
    await f.publications.publish([
      { owner: 'task-artifact', key: 'k2', scope: 't', bytes: Buffer.from('two') },
    ])
    await f.publications.release({ owner: 'task-artifact', keys: ['k2'] })
    await backup('01a13e6d-3e00-7000-9e3c-0000000000a3', 'building', f.now() + 60 * 60_000, null)
    expect(await f.maintenance().run()).toMatchObject({ released: 1, protected: 0 })
  })

  test('a building backup protects every object released after it started', async () => {
    const f = fixture()
    await f.publications.publish([
      { owner: 'task-artifact', key: 'k', scope: 't', bytes: Buffer.from('x') },
    ])
    await harness.db.insert(hostedDatabaseBackups).values({
      id: '01a13e6d-3e00-7000-9e3c-0000000000b1',
      epoch: 1,
      kind: 'manual',
      state: 'building',
      activeSlot: 'global',
      createdAt: f.now(),
      updatedAt: f.now(),
    })
    f.advance(1_000)
    await f.publications.release({ owner: 'task-artifact', keys: ['k'] })
    expect(await f.maintenance().run()).toMatchObject({ protected: 1 })
  })

  test('recoverable bytes are sealed until ready, so maintenance finishes an interrupted upload', async () => {
    const f = fixture({ sealer: true })
    f.losePinReply()
    await expect(
      f.publications.publish([
        {
          owner: 'node-event-archive',
          key: 'chunk',
          scope: 't',
          bytes: Buffer.from('events'),
          recoverable: true,
        },
      ]),
    ).rejects.toThrow('pin reply lost')
    expect((await f.row('node-event-archive', 'chunk'))?.sourceSealed).not.toBeNull()
    f.rotate()
    expect(await f.maintenance().run()).toMatchObject({ completed: 1 })
    expect(await f.row('node-event-archive', 'chunk')).toMatchObject({
      state: 'ready',
      sourceSealed: null,
    })
    await expect(
      fixture().publications.publish([
        { owner: 'node-event-archive', key: 'other', bytes: Buffer.from('x'), recoverable: true },
      ]),
    ).rejects.toThrow('hosted-object-publication-sealer-unavailable')
  })

  test('settled rows are purged after the retention period and a released key revives with a new pin', async () => {
    const f = fixture()
    await f.publications.publish([
      { owner: 'task-artifact', key: 'k', scope: 't', bytes: Buffer.from('v1') },
    ])
    const first = await f.row('task-artifact', 'k')
    await f.publications.release({ owner: 'task-artifact', keys: ['k'] })
    await f.maintenance().run()
    expect(await f.row('task-artifact', 'k')).toMatchObject({ state: 'released' })
    await f.publications.publish([
      { owner: 'task-artifact', key: 'k', scope: 't', bytes: Buffer.from('v2') },
    ])
    const second = await f.row('task-artifact', 'k')
    expect(second!.attempt).not.toBe(first!.attempt)
    expect(hostedPublicationPin(second!)).not.toBe(hostedPublicationPin(first!))
    await f.publications.release({ owner: 'task-artifact', keys: ['k'] })
    await f.maintenance().run()
    f.advance(HOSTED_PUBLICATION_RETENTION_MS + 1)
    expect(await f.maintenance().run()).toMatchObject({ purged: 1 })
    expect(await f.row('task-artifact', 'k')).toBeUndefined()
  })

  test('scopes() lists live scopes past the grace period, paged by scope', async () => {
    const f = fixture()
    await f.publications.publish([
      { owner: 'task-artifact', key: 'a', scope: 'scope-a', bytes: Buffer.from('a') },
      { owner: 'task-artifact', key: 'b', scope: 'scope-b', bytes: Buffer.from('b') },
    ])
    f.advance(10_000)
    await f.publications.publish([
      { owner: 'task-artifact', key: 'c', scope: 'scope-c', bytes: Buffer.from('c') },
    ])
    const before = f.now() - 1
    expect(await f.publications.scopes('task-artifact', { before, limit: 10 })).toEqual([
      'scope-a',
      'scope-b',
    ])
    expect(
      await f.publications.scopes('task-artifact', { before, limit: 1, after: 'scope-a' }),
    ).toEqual(['scope-b'])
    await f.publications.release({ owner: 'task-artifact', scope: 'scope-a' })
    expect(await f.publications.scopes('task-artifact', { before, limit: 10 })).toEqual(['scope-b'])
  })

  test('every journal write requires the current execution fence', async () => {
    const f = fixture()
    f.lose()
    await expect(
      f.publications.publish([{ owner: 'task-artifact', key: 'k', bytes: Buffer.from('x') }]),
    ).rejects.toThrow('object-publication-fence-lost')
    expect(f.pins).toEqual([])
    expect(await f.row('task-artifact', 'k')).toBeUndefined()
  })

  test('owner sweeps run first and one failing sweep does not stop settlement', async () => {
    const f = fixture()
    const calls: string[] = []
    const counters = await f
      .maintenance([
        {
          name: 'broken',
          sweep: async () => {
            calls.push('broken')
            throw new Error('sweep failed')
          },
        },
        {
          name: 'ok',
          sweep: async () => {
            calls.push('ok')
            return 2
          },
        },
      ])
      .run()
    expect(calls).toEqual(['broken', 'ok'])
    expect(counters).toMatchObject({ swept: 2, sweepFailures: 1 })
  })
})

describe('RFC-370 object publication identities', () => {
  test('pins are per lifetime and never collide across owners', () => {
    const row = { owner: 'task-artifact', logicalKey: 'k', attempt: 'a1' }
    expect(hostedPublicationPin(row)).toMatch(/^aw-publication:[a-f0-9]{64}$/)
    expect(hostedPublicationPin({ ...row, attempt: 'a2' })).not.toBe(hostedPublicationPin(row))
    expect(hostedPublicationPin({ ...row, owner: 'task-archive' })).not.toBe(
      hostedPublicationPin(row),
    )
    expect(hostedPublicationId('a', 'b\0c')).not.toBe(hostedPublicationId('a\0b', 'c'))
  })
})

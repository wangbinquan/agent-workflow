// RFC-395 X: one target ledger preserves retries, stale fences, retention and owner cascades.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  createContentStore,
  createObjectContentTransport,
} from '@/platform/content/infrastructure/contentStore'
import { contentRefColumns } from '@/platform/content/contentStore'
import {
  createHostedObjectPublications,
  HOSTED_PUBLICATION_ABANDON_MS,
} from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'
import { objectFixture } from './helpers/rfc370Objects'

describeEachProvider('RFC-395 publication target recovery', (harness) => {
  test('an in-flight ContentStore object upload uses the current hosted epoch', async () => {
    const objects = objectFixture(),
      bytes = Buffer.from('upload still running')
    let resume!: () => void, started!: () => void
    const uploading = new Promise<void>((resolve) => {
      started = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      resume = resolve
    })
    const transport = createObjectContentTransport(objects.objects)
    const store = createContentStore({
      db: harness.db,
      policy: { inlineMaxBytes: 0, externalKind: 'object' },
      objectPublicationEpoch: () => 7,
      transports: {
        object: {
          ...transport,
          put: async (input) => {
            expect(input.publication.epoch).toBe(7)
            started()
            await barrier
            return transport.put(input)
          },
        },
      },
    })
    const put = store.put(
      {
        publication: {
          owner: 'review-body',
          logicalKey: 'pending',
          scope: 'task',
          attempt: 'pending',
          epoch: 1,
          sha256: sha256Hex(bytes),
          size: bytes.length,
        },
        source: { kind: 'bytes', bytes },
        references: 'shared',
        contentVersion: 1,
        mediaType: null,
      },
      async () => {},
    )
    try {
      await uploading
      const maintenance = createHostedObjectPublications({
        db: harness.db,
        objects: objects.objects,
        fence: {
          current: () => ({ epoch: 7, leaseId: 'lease', instanceId: 'instance' }),
          assertHeld: async () => {},
        },
      }).maintenance({ horizon: { protects: async () => false } })
      expect(await maintenance.run()).toMatchObject({ resolved: 0, released: 0 })
      expect(
        (await store.publications.find({ owner: 'review-body', logicalKey: 'pending' }))?.state,
      ).toBe('pending')
    } finally {
      resume()
    }
    expect((await put).kind).toBe('object')
  })

  test('every transition checks attempt and epoch; retry keeps one lifetime and release waits for maintenance', async () => {
    const store = createContentStore({
      db: harness.db,
      policy: { inlineMaxBytes: 0, externalKind: 'database-bytes' },
    })
    const bytes = new Uint8Array([1])
    const facts = {
      owner: 'ledger-test',
      logicalKey: 'A%_中文',
      scope: 'scope',
      attempt: 'attempt-1',
      epoch: 2,
      sha256: sha256Hex(bytes),
      size: 1,
    }
    await harness.session.transaction((tx) =>
      store.publications.begin(tx, { ...facts, sourceSealed: null, now: 1 }),
    )
    for (const stale of [
      { ...facts, attempt: 'stale' },
      { ...facts, epoch: 1 },
    ]) {
      await expect(
        harness.session.transaction((tx) =>
          store.publications.begin(tx, { ...stale, sourceSealed: null, now: 2 }),
        ),
      ).rejects.toThrow('content-publication-stale-attempt')
      await expect(
        harness.session.transaction((tx) =>
          store.publications.retry(tx, { ...stale, nextAttemptAt: 50, now: 2 }),
        ),
      ).rejects.toThrow('content-publication-stale-attempt')
    }
    await harness.session.transaction((tx) =>
      store.publications.retry(tx, { ...facts, nextAttemptAt: 50, now: 2 }),
    )
    expect(await store.publications.pending({ now: 49, limit: 10 })).toEqual([])
    expect(await store.publications.pending({ now: 50, limit: 10 })).toMatchObject([
      { attempts: 1 },
    ])
    const ref = await store.put(
      {
        publication: facts,
        source: { kind: 'bytes', bytes },
        contentVersion: 1,
        mediaType: null,
        references: 'shared',
      },
      async () => {},
    )
    await expect(
      harness.session.transaction((tx) =>
        store.release(tx, { publication: { ...facts, epoch: 3 }, ref }),
      ),
    ).rejects.toThrow('content-publication-stale-attempt')
    expect(
      await harness.session.transaction((tx) =>
        store.publications.release(tx, { owner: facts.owner, keyPrefix: 'a%' }, 3),
      ),
    ).toBe(0)
    expect(
      await harness.session.transaction((tx) =>
        store.publications.release(tx, { owner: facts.owner, keyPrefix: 'A%_' }, 3),
      ),
    ).toBe(1)
    expect(await store.read(ref)).toEqual(bytes)
    await harness.session.transaction((tx) => store.publications.released(tx, facts, 4))
    await expect(
      harness.session.transaction((tx) =>
        store.publications.begin(tx, { ...facts, sourceSealed: null, now: 5 }),
      ),
    ).rejects.toThrow('content-publication-retired')
    expect(
      await harness.session.transaction((tx) =>
        store.publications.begin(tx, {
          ...facts,
          attempt: 'attempt-2',
          sourceSealed: null,
          now: 5,
        }),
      ),
    ).toMatchObject({ state: 'pending', attempt: 'attempt-2' })
  })

  function hosted() {
    const objects = objectFixture()
    let at = 1_000
    const fence = {
      current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
      async assertHeld() {},
    }
    const journal = createHostedObjectPublications({
      db: harness.db,
      fence,
      objects: objects.objects,
      now: () => at,
      sealer: { seal: (value) => `sealed:${value}`, unseal: (value) => value.slice(7) },
    })
    return {
      ...objects,
      ...journal,
      advance: () => {
        at += HOSTED_PUBLICATION_ABANDON_MS + 1
      },
    }
  }

  test('an owner commit crash retries the same upload and writes only content_publications', async () => {
    const f = hosted()
    const request = {
      owner: 'hosted-test',
      key: 'crash',
      bytes: new Uint8Array([255, 0, 2]),
      attempt: 'attempt',
    }
    await expect(
      f.publications.publish([request], {
        commit: async () => {
          throw new Error('commit-crash')
        },
      }),
    ).rejects.toThrow('commit-crash')
    const { contentPublications, contentObjects } = tablesOf(harness.db)
    expect(await harness.db.select().from(contentPublications)).toMatchObject([
      { state: 'pending', contentId: null },
    ])
    const [receipt] = await f.publications.publish([request])
    expect(f.stored.size).toBe(1)
    expect(await f.publications.find(request.owner, request.key)).toEqual(receipt!)
    const row = (await harness.db.select().from(contentPublications))[0]!
    const catalog = (
      await harness.db
        .select()
        .from(contentObjects)
        .where(eq(contentObjects.contentId, row.contentId!))
    )[0]!
    expect(JSON.parse(catalog.locationJson)).toEqual({
      codec: 'hosted-object-id',
      value: receipt!.id,
    })
    expect(catalog.sha256).toBe(sha256Hex(request.bytes))
    expect(row.sourceSealed).toBeNull()
  })

  test('recoverable pending bytes finish after a crash; owner cascade release preserves another pin and backup retention', async () => {
    const f = hosted()
    const request = {
      owner: 'hosted-test',
      key: 'recovery',
      scope: 'deleted-owner',
      bytes: new Uint8Array([239, 187, 191, 255]),
      recoverable: true,
    }
    await expect(
      f.publications.publish([request], {
        commit: async () => {
          throw new Error('crash')
        },
      }),
    ).rejects.toThrow('crash')
    f.advance()
    expect(await f.maintenance({ horizon: { protects: async () => false } }).run()).toMatchObject({
      completed: 1,
    })
    const receipt = (await f.publications.find(request.owner, request.key))!
    await f.publications.publish([
      { owner: request.owner, key: 'other-holder', scope: 'survivor', object: receipt },
    ])
    const maintenance = (protectedByBackup: boolean) =>
      f.maintenance({
        horizon: { protects: async () => protectedByBackup },
        sweeps: [
          {
            name: 'test-owner-cascade',
            sweep: async () =>
              f.publications.release({ owner: request.owner, scope: request.scope }),
          },
        ],
      })
    expect(await maintenance(true).run()).toMatchObject({ swept: 1, protected: 1 })
    expect(f.releases).toEqual([])
    f.advance()
    expect(await maintenance(false).run()).toMatchObject({ released: 1 })
    expect(f.activeReferences(receipt.id)).toBe(1)
    expect(await f.objects.read(receipt.id)).toEqual(request.bytes)
  })

  test('hosted maintenance does not interpret released database skill bytes as object ids', async () => {
    const store = createContentStore({
      db: harness.db,
      policy: { inlineMaxBytes: 0, externalKind: 'database-bytes' },
    })
    const bytes = new Uint8Array([1])
    const publication = {
      owner: 'skill-content',
      logicalKey: 'database',
      scope: 'skill',
      attempt: 'attempt',
      epoch: 0,
      sha256: sha256Hex(bytes),
      size: 1,
    }
    const ref = await store.put(
      {
        publication,
        source: { kind: 'bytes', bytes },
        contentVersion: 1,
        mediaType: null,
        references: 'single',
      },
      async (tx, content) => {
        const { skills } = tablesOf(tx)
        const encoded = contentRefColumns.encode(content)
        await tx.insert(skills).values({
          id: 'skill',
          name: 'skill',
          description: '',
          contentRefJson: encoded.json,
          contentInlineBytes:
            encoded.inlineBytes === null ? null : Buffer.from(encoded.inlineBytes),
          createdAt: 1,
          updatedAt: 1,
        })
      },
    )
    await harness.session.transaction(async (tx) => {
      const { skills } = tablesOf(tx)
      await tx.delete(skills).where(eq(skills.id, 'skill'))
      await store.release(tx, { publication, ref })
    })
    expect(
      await hosted()
        .maintenance({ horizon: { protects: async () => false } })
        .run(),
    ).toMatchObject({ released: 0, failures: 0 })
    expect(await store.read(ref)).toEqual(bytes)
  })
})

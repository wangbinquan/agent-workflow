import { rowToDocVersion } from '@/modules/collaboration/infrastructure/review'
import { readOnlyProbes } from '@/platform/content/migration/probes'
import { collectReadOnlyProbes } from '@/platform/persistence/migration/run/probes'
import { DatabaseCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { createFileReviewArtifactContent } from '@/modules/collaboration/infrastructure/local/fileReviewArtifactContent'
import {
  createContentMaintenance,
  contentRowColumns,
  createContentStore,
  createLocalFileContentTransport,
  createObjectContentTransport,
} from '@/platform/content/infrastructure/contentStore'
import { nodeRunFixture, taskFixture, workflowFixture } from './helpers/model'
// RFC-395 X: byte identity and the owner reference commit on both native providers.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  databaseSessionFor,
  databaseTransactionIsActive,
} from '@/platform/persistence/databaseTransaction'
import { contentRefColumns, type ContentPutRequest } from '@/platform/content/contentStore'

import { sha256Hex } from '@/util/hash'
import { legacyContentRef } from '@/platform/content/contentRef'
import { describeEachProvider } from './helpers/eachProvider'
import { objectFixture } from './helpers/rfc370Objects'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const request = (bytes: Uint8Array, key: string): ContentPutRequest => ({
  publication: {
    owner: 'content-test',
    logicalKey: key,
    scope: 'scope',
    attempt: key,
    epoch: 1,
    sha256: sha256Hex(bytes),
    size: bytes.byteLength,
  },
  source: { kind: 'bytes', bytes },
  contentVersion: 1,
  mediaType: 'application/octet-stream',
  references: 'single',
})

describeEachProvider('RFC-395 content target runtime', (harness) => {
  for (const kind of ['inline', 'database-bytes', 'local-file', 'object'] as const) {
    test(`${kind} preserves empty bytes, BOM and invalid UTF-8 without a text round trip`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'aw-content-target-'))
      roots.push(root)
      const objects = objectFixture()
      const local = createLocalFileContentTransport(root)
      const remote = createObjectContentTransport(objects.objects)
      const store = createContentStore({
        objectPublicationEpoch: () => 1,
        db: harness.db,
        policy: {
          inlineMaxBytes: kind === 'inline' ? 1024 : 0,
          externalKind: kind === 'inline' ? 'database-bytes' : kind,
        },
        transports: {
          'local-file': local,
          object: {
            ...remote,
            async put(input) {
              expect(databaseTransactionIsActive(harness.db)).toBe(false)
              return remote.put(input)
            },
          },
        },
      })
      const cases = [
        new Uint8Array(),
        new Uint8Array([239, 187, 191, 65]),
        new Uint8Array([255, 0, 192, 128]),
      ]
      for (const [index, bytes] of cases.entries()) {
        const put = {
          ...request(bytes, `${kind}-${index}`),
          references: kind === 'inline' ? ('single' as const) : ('shared' as const),
        }
        const ref = await store.put(put, async (tx, content) => {
          const encoded = contentRefColumns.encode(content)
          const { skills } = tablesOf(tx)
          await tx.insert(skills).values({
            id: put.publication.logicalKey,
            name: put.publication.logicalKey,
            description: '',
            contentRefJson: encoded.json,
            contentInlineBytes:
              encoded.inlineBytes === null ? null : Buffer.from(encoded.inlineBytes),
            createdAt: 1,
            updatedAt: 1,
          })
        })
        expect(ref.kind).toBe(kind)
        expect(await store.read(ref)).toEqual(bytes)
        expect(ref.sha256).toBe(sha256Hex(bytes))
        expect(ref.size).toBe(bytes.byteLength)
        const { skills } = tablesOf(harness.db)
        const row = (
          await harness.db.select().from(skills).where(eq(skills.id, put.publication.logicalKey))
        )[0]!
        expect(
          await store.read(contentRefColumns.decode(row.contentRefJson, row.contentInlineBytes)!),
        ).toEqual(bytes)
      }
      const { contentObjects, contentPublications, contentBytes } = tablesOf(harness.db)
      expect(await harness.db.select().from(contentObjects)).toHaveLength(kind === 'inline' ? 0 : 3)
      expect(await harness.db.select().from(contentPublications)).toHaveLength(
        kind === 'inline' ? 0 : 3,
      )
      expect(await harness.db.select().from(contentBytes)).toHaveLength(
        kind === 'database-bytes' ? 3 : 0,
      )
    })
  }

  test('the inline boundary is inclusive and shared references use the catalog even for empty bytes', async () => {
    const store = createContentStore({
      objectPublicationEpoch: () => 1,
      db: harness.db,
      policy: { inlineMaxBytes: 4, externalKind: 'database-bytes' },
    })
    const keep = async () => {}
    expect((await store.put(request(new Uint8Array(4), 'four'), keep)).kind).toBe('inline')
    expect((await store.put(request(new Uint8Array(5), 'five'), keep)).kind).toBe('database-bytes')
    expect(
      (
        await store.put(
          { ...request(new Uint8Array(), 'shared-empty'), references: 'shared' },
          keep,
        )
      ).kind,
    ).toBe('database-bytes')
  })

  test('size/digest failures and a failed owner transaction expose no database ref or catalog row', async () => {
    const store = createContentStore({
      objectPublicationEpoch: () => 1,
      db: harness.db,
      policy: { inlineMaxBytes: 0, externalKind: 'database-bytes' },
    })
    const input = request(new Uint8Array([1, 2, 3]), 'bad')
    await expect(
      store.put({ ...input, publication: { ...input.publication, size: 4 } }, async () => {}),
    ).rejects.toThrow('content-ref-size-mismatch')
    await expect(
      store.put(
        { ...input, publication: { ...input.publication, sha256: 'f'.repeat(64) } },
        async () => {},
      ),
    ).rejects.toThrow('content-ref-digest-mismatch')
    await expect(
      store.put(input, async () => {
        throw new Error('owner-failed')
      }),
    ).rejects.toThrow('owner-failed')
    const { contentObjects, contentPublications, contentBytes } = tablesOf(harness.db)
    expect(await harness.db.select().from(contentObjects)).toEqual([])
    expect(await harness.db.select().from(contentBytes)).toEqual([])
    expect(await harness.db.select().from(contentPublications)).toEqual([])
  })

  test('a shared database object remains readable after one holder releases it; history bytes are exact', async () => {
    const store = createContentStore({
      objectPublicationEpoch: () => 1,
      db: harness.db,
      policy: { inlineMaxBytes: 0, externalKind: 'database-bytes' },
    })
    const bytes = new Uint8Array([239, 187, 191, 255, 0])
    const first = request(bytes, 'history')
    const ref = await store.put(first, async () => {})
    if (ref.kind === 'inline') throw new Error('expected catalog object')
    const second = { ...request(bytes, 'live'), source: { kind: 'existing' as const, ref } }
    expect(await store.put(second, async () => {})).toEqual(ref)
    await databaseSessionFor(harness.db).transaction((tx) =>
      store.release(tx, { publication: first.publication, ref }),
    )
    expect((await store.publications.find(first.publication))?.state).toBe('releasing')
    expect((await store.publications.find(second.publication))?.state).toBe('ready')
    expect(await store.read(ref)).toEqual(bytes)
    const { contentObjects } = tablesOf(harness.db)
    expect(await harness.db.select().from(contentObjects)).toHaveLength(1)
  })

  test('stream retries do not reopen durable bytes and stream facts must match the publication', async () => {
    const store = createContentStore({
      objectPublicationEpoch: () => 1,
      db: harness.db,
      policy: { inlineMaxBytes: 0, externalKind: 'database-bytes' },
    })
    const bytes = new Uint8Array([1, 2, 3])
    const input = request(bytes, 'stream')
    let opens = 0
    const stream: ContentPutRequest = {
      ...input,
      source: {
        kind: 'stream',
        sha256: sha256Hex(bytes),
        size: bytes.length,
        open() {
          opens++
          return new Blob([bytes]).stream()
        },
      },
    }
    const ref = await store.put(stream, async () => {})
    expect(await store.put(stream, async () => {})).toEqual(ref)
    expect(opens).toBe(1)
    await expect(
      store.put({ ...stream, publication: { ...input.publication, size: 4 } }, async () => {}),
    ).rejects.toThrow('content-publication-facts-changed')
  })

  for (const kind of ['local-file', 'object'] as const) {
    test(`${kind}: streamed bytes are verified before the owner commit and can retry after invalid input`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'aw-content-stream-'))
      roots.push(root)
      const objects = objectFixture()
      const store = createContentStore({
        objectPublicationEpoch: () => 1,
        db: harness.db,
        policy: { inlineMaxBytes: 0, externalKind: kind },
        transports: {
          'local-file': createLocalFileContentTransport(root),
          object: createObjectContentTransport(objects.objects),
        },
      })
      const bytes = new Uint8Array([239, 187, 191, 255])
      let supplied = bytes.subarray(0, 3)
      let opens = 0
      let commits = 0
      const input: ContentPutRequest = {
        ...request(bytes, `${kind}-stream`),
        source: {
          kind: 'stream',
          sha256: sha256Hex(bytes),
          size: bytes.length,
          open() {
            expect(databaseTransactionIsActive(harness.db)).toBe(false)
            opens++
            let offset = 0
            return new ReadableStream<Uint8Array>({
              pull(controller) {
                if (offset === supplied.length) controller.close()
                else controller.enqueue(supplied.slice(offset, ++offset))
              },
            })
          },
        },
      }
      const commit = async () => {
        commits++
      }
      await expect(store.put(input, commit)).rejects.toThrow('content-ref-size-mismatch')
      supplied = new Uint8Array([239, 187, 191, 0])
      await expect(store.put(input, commit)).rejects.toThrow('content-ref-digest-mismatch')
      expect(commits).toBe(0)
      expect(await harness.db.select().from(tablesOf(harness.db).contentObjects)).toEqual([])
      expect((await store.publications.find(input.publication))?.state).toBe('pending')
      if (kind === 'local-file') expect(readdirSync(root)).toEqual([])
      supplied = bytes
      const ref = await store.put(input, commit)
      expect(await store.read(ref)).toEqual(bytes)
      expect(await store.put(input, commit)).toEqual(ref)
      expect(opens).toBe(3)
      expect(commits).toBe(2)
    })
  }

  test('migrated object references keep their original spelling and per-reference media type', async () => {
    const objects = objectFixture()
    const store = createContentStore({
      objectPublicationEpoch: () => 1,
      db: harness.db,
      policy: { inlineMaxBytes: 0, externalKind: 'object' },
      transports: { object: createObjectContentTransport(objects.objects) },
    })
    const bytes = new Uint8Array([239, 187, 191, 255])
    const ref = await store.put(request(bytes, 'catalog'), async () => {})
    if (ref.kind !== 'object') throw new Error('expected object')
    const migrated = {
      ...ref,
      location: {
        codec: 'review-object',
        value: { reference: 'runs/history/review.md', objectId: ref.location.value },
      },
      mediaType: 'text/markdown',
    }
    expect(await store.read(migrated)).toEqual(bytes)
    const put: ContentPutRequest = {
      ...request(bytes, 'historical-holder'),
      source: { kind: 'existing', ref: migrated },
      mediaType: 'text/markdown',
    }
    expect(await store.put(put, async () => {})).toEqual(migrated)
    expect(await store.put(put, async () => {})).toEqual(migrated)
  })

  test('historical local content reads the original file and can acquire an independent publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-history-content-'))
    roots.push(root)
    const bytes = new Uint8Array([239, 187, 191, 255, 0])
    writeFileSync(join(root, 'history.bin'), bytes)
    const store = createContentStore({
      objectPublicationEpoch: () => 1,
      db: harness.db,
      policy: { inlineMaxBytes: 0, externalKind: 'local-file' },
      transports: { 'local-file': createLocalFileContentTransport(join(root, 'objects'), root) },
    })
    const ref = legacyContentRef('review-body-path', 'local-file', 'history.bin')
    expect(await store.read(ref)).toEqual(bytes)
    const adopted = await store.put(
      {
        ...request(bytes, 'history-file'),
        source: { kind: 'existing', ref: { ...ref, kind: 'local-file' } },
      },
      async () => {},
    )
    expect(adopted.kind).toBe('local-file')
    expect(adopted.location).toEqual(ref.location)
    expect(await store.read(adopted)).toEqual(bytes)
  })
})

test('content probes collect under their owner and return matching result ids', async () => {
  const probes = collectReadOnlyProbes([{ owner: 'platform/content', probes: readOnlyProbes }])
  expect(probes).toHaveLength(2)
  for (const probe of probes) {
    expect(probe.id.startsWith('platform/content:')).toBe(true)
    const result = await probe.run({ provider: 'sqlite', query: async () => [] })
    expect(result).toMatchObject({ id: probe.id, passed: true })
  }
})

describeEachProvider('RFC-395 profile review bytes and content reclamation', (h) => {
  test.each(['database-bytes', 'local-file'] as const)(
    '%s review bodies use the injected profile store',
    async (kind) => {
      const appHome = mkdtempSync(join(tmpdir(), 'review-app-')),
        contentRoot = mkdtempSync(join(tmpdir(), 'review-content-'))
      roots.push(appHome, contentRoot)
      const store = createContentStore({
        db: h.db,
        policy: { inlineMaxBytes: 0, externalKind: kind },
        transports: { 'local-file': createLocalFileContentTransport(contentRoot) },
      })
      const taskId = `profile-${kind}`,
        runId = `${taskId}-run`,
        docId = `${taskId}-doc`
      await workflowFixture(h.db, {
        id: taskId,
        name: taskId,
        description: '',
        version: 1,
        definition: { $schema_version: 2, nodes: [], edges: [], inputs: [] },
      })
      await taskFixture(h.db, {
        id: taskId,
        name: taskId,
        workflowId: taskId,
        workflowSnapshot: { nodes: [], edges: [] },
        repoPath: '',
        worktreePath: '',
        baseBranch: 'main',
        branch: 'main',
        status: 'running',
        inputs: {},
        startedAt: 1,
      })
      await nodeRunFixture(h.db, { id: runId, taskId, nodeId: 'review', status: 'awaiting_review' })
      const body = Buffer.from('profile body\r\n')
      const ref = await store.put(
        { ...request(body, docId), references: 'shared' },
        async (tx, ref) => {
          const { docVersions } = tablesOf(tx)
          await tx.insert(docVersions).values({
            id: docId,
            taskId,
            reviewNodeId: 'review',
            reviewNodeRunId: runId,
            reviewIteration: 0,
            sourceNodeId: 'writer',
            sourcePortName: 'doc',
            versionIndex: 1,
            ...contentRowColumns(ref),
          })
        },
      )
      const legacyReads: string[] = []
      const legacy = createFileReviewArtifactContent(appHome)
      const reader = new DatabaseCommittedReviewArtifactReader(
        h.db,
        {
          ...legacy,
          read: async (path) => {
            legacyReads.push(path)
            return legacy.read(path)
          },
        },
        store,
      )
      expect(await reader.read(`doc-content:${docId}`)).toBe(body.toString())
      const { docVersions } = tablesOf(h.db)
      const [stored] = await h.db.select().from(docVersions).where(eq(docVersions.id, docId))
      expect(rowToDocVersion(stored!).bodyPath).toBe(`doc-content:${docId}`)
      expect(legacyReads).toEqual([])
      if (kind === 'local-file') {
        expect(ref.location.codec).toBe('content-file')
        expect(existsSync(join(contentRoot, String(ref.location.value)))).toBe(true)
        expect(existsSync(join(appHome, String(ref.location.value)))).toBe(false)
      }
    },
  )

  test.each(['database-bytes', 'local-file'] as const)(
    '%s release waits for live/history/backup holders and then removes bytes',
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), 'content-gc-'))
      roots.push(root)
      const local = createLocalFileContentTransport(root)
      const store = createContentStore({
        db: h.db,
        policy: { inlineMaxBytes: 0, externalKind: kind },
        transports: { 'local-file': local },
      })
      const bytes = Buffer.alloc(70_000, 7),
        first = request(bytes, 'first-holder'),
        second = request(bytes, 'second-holder')
      const ref = await store.put(first, async () => {})
      expect(ref.kind).not.toBe('inline')
      if (ref.kind === 'inline') throw new Error('fixture')
      await store.put({ ...second, source: { kind: 'existing', ref } }, async () => {})
      let historical = false,
        backup = false
      const maintenance = createContentMaintenance({
        db: h.db,
        localFiles: local,
        hasHolders: async () => historical,
        horizon: { protects: async () => backup },
        exclusive: (run) => run(),
      })
      const release = (publication: typeof first.publication) =>
        h.session.transaction((tx) => store.release(tx, { publication, ref }))
      await release(first.publication)
      expect((await maintenance.run()).purged).toBe(0)
      expect(await store.read(ref)).toEqual(bytes)
      await release(second.publication)
      historical = true
      expect((await maintenance.run()).protected).toBe(1)
      historical = false
      backup = true
      expect((await maintenance.run()).protected).toBe(1)
      backup = false
      expect(await maintenance.run()).toMatchObject({ released: 2, purged: 1 })
      const { contentObjects, contentBytes, contentPublications } = tablesOf(h.db)
      expect(await h.db.select().from(contentObjects)).toEqual([])
      expect(await h.db.select().from(contentBytes)).toEqual([])
      expect(
        (await h.db.select().from(contentPublications)).every(
          (row) => row.state === 'released' && row.contentId === null,
        ),
      ).toBe(true)
      if (kind === 'local-file')
        expect(existsSync(join(root, String(ref.location.value)))).toBe(false)
      expect(await maintenance.run()).toMatchObject({ released: 0, purged: 0 })
    },
  )
  test('converted bytes retain their first release horizon across maintenance retries', async () => {
    const { contentObjects, contentBytes, contentPublications } = tablesOf(h.db)
    const bytes = Buffer.from('converted bytes')
    await h.session.transaction(async (tx) => {
      await tx.insert(contentObjects).values({
        contentId: 'converted',
        contentVersion: 1,
        sha256: sha256Hex(bytes),
        size: bytes.length,
        mediaType: null,
        kind: 'database-bytes',
        locationJson: JSON.stringify({ codec: 'content-bytes', value: 'converted' }),
        createdAt: 1,
      })
      await tx.insert(contentBytes).values({ contentId: 'converted', bytes })
    })
    let clock = 10,
      backup = true
    const lifetimes: { createdAt: number; releasedAt: number }[] = []
    const maintenance = createContentMaintenance({
      db: h.db,
      hasHolders: async () => false,
      exclusive: (run) => run(),
      now: () => clock,
      horizon: {
        protects: async (lifetime) => {
          lifetimes.push(lifetime)
          return backup
        },
      },
    })
    expect(await maintenance.run()).toMatchObject({ protected: 1, purged: 0 })
    expect((await h.db.select().from(contentPublications))[0]).toMatchObject({
      state: 'releasing',
      releasedAt: 10,
      contentId: 'converted',
    })
    clock = 100
    backup = false
    expect(await maintenance.run()).toMatchObject({ released: 1, purged: 1 })
    expect(lifetimes).toEqual([
      { createdAt: 1, releasedAt: 10 },
      { createdAt: 1, releasedAt: 10 },
    ])
    expect(await h.db.select().from(contentBytes)).toEqual([])
  })

  test('a released local upload whose owner commit failed is removed by its selected owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'content-uncommitted-'))
    roots.push(root)
    const local = createLocalFileContentTransport(root)
    const store = createContentStore({
      db: h.db,
      policy: { inlineMaxBytes: 0, externalKind: 'local-file' },
      transports: { 'local-file': local },
    })
    const put = request(Buffer.from('uncommitted'), 'failed-owner')
    await expect(
      store.put(put, async () => {
        throw new Error('owner-commit-failed')
      }),
    ).rejects.toThrow('owner-commit-failed')
    expect(readdirSync(root)).toHaveLength(1)
    await h.session.transaction((tx) =>
      store.publications.release(
        tx,
        { owner: put.publication.owner, keys: [put.publication.logicalKey] },
        10,
      ),
    )
    const maintenance = createContentMaintenance({
      db: h.db,
      localFiles: local,
      localOwners: [put.publication.owner],
      hasHolders: async () => false,
      horizon: { protects: async () => false },
      exclusive: (run) => run(),
    })
    expect(await maintenance.run()).toMatchObject({ released: 1, purged: 0 })
    expect(readdirSync(root)).toEqual([])
    expect((await store.publications.find(put.publication))?.state).toBe('released')
  })
})

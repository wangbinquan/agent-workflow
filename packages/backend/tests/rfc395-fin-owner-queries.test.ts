// RFC-395 T18 FIN R01: owner queries retain release selection, archive rows and caller transactions.
import { expect, test } from 'bun:test'
import { createTaskArchiveCollaborationSectionReader } from '@/modules/collaboration/infrastructure/taskCollaborationReads'
import {
  copyTree,
  deleteTree,
  readTree,
  readTreeRows,
  writeTree,
} from '@/modules/resource-catalog/infrastructure/databaseSkillTrees'
import { createTaskClarifyDirectivePersistence } from '@/modules/task-execution/public/participants'
import { contentRefColumns, type ContentPutRequest } from '@/platform/content/contentStore'
import {
  createContentPublicationLedger,
  createContentStore,
  databaseContentPolicy,
} from '@/platform/content/infrastructure/contentStore'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture } from './helpers/model'

describeEachProvider('RFC-395 FIN exact owner queries', (harness) => {
  test('publication keys retain owner, scope and content identity in the supplied transaction', async () => {
    const ledger = createContentPublicationLedger(harness.db)
    const rollback = new Error('rollback publication selection')
    let contentId = ''
    await expect(
      harness.session.transaction(async (tx) => {
        const store = createContentStore({
          db: tx,
          policy: databaseContentPolicy,
          transaction: (body) => body(tx),
        })
        const bytes = new Uint8Array([255, 0, 65])
        const request: ContentPutRequest = {
          publication: {
            owner: 'skill-content',
            scope: 'skill',
            logicalKey: 'z-first',
            attempt: 'attempt',
            epoch: 0,
            sha256: sha256Hex(bytes),
            size: bytes.length,
          },
          source: { kind: 'bytes', bytes },
          references: 'shared',
          contentVersion: 1,
          mediaType: null,
        }
        const ref = await store.put(request, async () => {})
        if (ref.kind === 'inline' || ref.contentId === null) throw new Error('external expected')
        contentId = ref.contentId
        for (const [owner, scope, logicalKey] of [
          ['skill-content', 'skill', 'a-second'],
          ['another-owner', 'skill', 'wrong-owner'],
          ['skill-content', 'another-skill', 'wrong-scope'],
        ]) {
          await store.put(
            {
              ...request,
              publication: {
                ...request.publication,
                owner: owner!,
                scope: scope!,
                logicalKey: logicalKey!,
              },
              source: { kind: 'existing', ref },
            },
            async () => {},
          )
        }
        await ledger.release(tx, { owner: 'skill-content', keys: ['z-first'] }, 10)
        const selection = { owner: 'skill-content', scope: 'skill', contentIds: [contentId] }
        const recording = harness.recordStatements()
        try {
          const keys = await ledger.keysForContent(tx, selection)
          expect(keys).toHaveLength(2)
          expect(keys).toEqual(expect.arrayContaining(['z-first', 'a-second']))
          const selects = recording.selects()
          expect(selects).toHaveLength(1)
          expect(selects[0]!.sql).not.toMatch(/\border\s+by\b/i)
          expect(selects[0]!.values).toEqual(['skill-content', 'skill', contentId])
        } finally {
          recording.stop()
        }
        expect(await ledger.keysForContent(tx, { ...selection, contentIds: [] })).toEqual([])
        expect(await ledger.keysForContent(tx, { ...selection, contentIds: ['missing'] })).toEqual(
          [],
        )
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect(
      await ledger.keysForContent(harness.db, {
        owner: 'skill-content',
        scope: 'skill',
        contentIds: [contentId],
      }),
    ).toEqual([])
  })

  test('deleting skill trees releases only the final holder and rolls back with the tree deletion', async () => {
    const skillId = 'fin-skill'
    const files = [
      { path: 'large.bin', bytes: new Uint8Array(70_000).fill(255) },
      { path: 'empty', bytes: new Uint8Array() },
    ]
    await harness.session.transaction(async (tx) => {
      await writeTree(tx, skillId, 'live', files, 1)
      await copyTree(tx, skillId, 'live', 'version:1', 2)
    })
    const entry = (await readTreeRows(harness.db, skillId, 'live')).find(
      (row) => row.path === 'large.bin',
    )!
    const ref = contentRefColumns.decode(entry.contentRefJson, entry.contentInlineBytes)!
    expect(ref.contentId).not.toBeNull()
    const ledger = createContentPublicationLedger(harness.db)
    const selection = { owner: 'skill-content', scope: skillId, contentIds: [ref.contentId!] }
    const keys = await ledger.keysForContent(harness.db, selection)
    expect(keys).toHaveLength(1)
    const identity = { owner: 'skill-content', logicalKey: keys[0]! }
    await harness.session.transaction((tx) => deleteTree(tx, skillId, 'live'))
    expect(await readTree(harness.db, skillId, 'live')).toEqual([])
    expect((await ledger.find(identity))?.state).toBe('ready')
    expect(await readTree(harness.db, skillId, 'version:1')).toEqual(expect.arrayContaining(files))
    const rollback = new Error('rollback final holder')
    await expect(
      harness.session.transaction(async (tx) => {
        await deleteTree(tx, skillId, 'version:1')
        expect((await createContentPublicationLedger(tx).find(identity))?.state).toBe('releasing')
        expect(await readTree(tx, skillId, 'version:1')).toEqual([])
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect((await ledger.find(identity))?.state).toBe('ready')
    expect(await readTree(harness.db, skillId, 'version:1')).toHaveLength(2)
    await harness.session.transaction((tx) => deleteTree(tx, skillId, 'version:1'))
    expect((await ledger.find(identity))?.state).toBe('releasing')
    expect(await ledger.keysForContent(harness.db, selection)).toEqual(keys)
  })

  test('archive directives keep every field, shard, chunk order and uncommitted caller row', async () => {
    const taskIds = ['fin-task-a', 'fin-task-b', 'fin-task-excluded'] as const
    for (const id of taskIds)
      await taskFixture(harness.db, {
        id,
        workflowId: 'fin-workflow',
        workflowSnapshot: { $schema_version: 2, inputs: [], nodes: [], edges: [] },
        repoPath: '/tmp/fin',
        worktreePath: '',
        baseBranch: 'main',
        branch: 'fin',
        status: 'done',
        inputs: {},
        startedAt: 1,
      })
    const reader = createTaskArchiveCollaborationSectionReader()
    const rollback = new Error('rollback archive snapshot')
    await expect(
      harness.session.transaction(async (tx) => {
        const directives = createTaskClarifyDirectivePersistence(tx)
        await directives.setInTx(taskIds[0]!, 'node', 'continue', null, null, 11)
        await directives.setInTx(taskIds[0]!, 'node', 'stop', 'actor', 'shard', 12)
        await directives.setInTx(taskIds[1]!, 'other', 'stop', null, null, 13)
        await directives.setInTx(taskIds[2]!, 'excluded', 'stop', null, null, 14)
        const rowsA = await directives.archiveRows([taskIds[0]])
        expect(rowsA).toHaveLength(2)
        expect(rowsA).toEqual(
          expect.arrayContaining([
            {
              taskId: taskIds[0],
              nodeId: 'node',
              shardKey: '',
              directive: 'continue',
              setBy: null,
              updatedAt: 11,
            },
            {
              taskId: taskIds[0],
              nodeId: 'node',
              shardKey: 'shard',
              directive: 'stop',
              setBy: 'actor',
              updatedAt: 12,
            },
          ]),
        )
        const rowsB = await directives.archiveRows([taskIds[1]])
        expect(rowsB).toEqual([
          {
            taskId: taskIds[1],
            nodeId: 'other',
            shardKey: '',
            directive: 'stop',
            setBy: null,
            updatedAt: 13,
          },
        ])
        const selection = [
          taskIds[1]!,
          ...Array.from({ length: 499 }, (_, i) => `missing-${i}`),
          taskIds[0]!,
        ]
        const archive = await reader.load(tx, selection)
        expect(archive.rows.task_node_clarify_directives).toEqual([...rowsB, ...rowsA])
        expect(await directives.archiveRows([])).toEqual([])
        expect((await reader.load(tx, [])).rows.task_node_clarify_directives).toEqual([])
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect(await createTaskClarifyDirectivePersistence(harness.db).archiveRows(taskIds)).toEqual([])
  })
})

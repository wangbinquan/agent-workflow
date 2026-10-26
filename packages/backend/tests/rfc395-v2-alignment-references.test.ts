import { expect, test } from 'bun:test'
import { describeV2Providers, fixtureLookup } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  coreBFixture,
  writeFrozenFixture,
  writeTaskFixture,
  ensureIdentitySeeds,
} from './rfc395-v2-generic-fixtures.test'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import {
  memoryIds,
  missionIds,
  repoGroupIds,
  userIds,
} from '@/platform/persistence/migration/conversion/generic/references'

describeV2Providers('RFC-395 V2 alignment references', (h) => {
  test('dangling creator, collaborator attribution and reopened mission block with original evidence', async () => {
    await h.install()
    await writeTaskFixture(h)
    await writeFrozenFixture(h, 'users', { id: 'creator', username: 'creator' })
    await writeFrozenFixture(h, 'users', {
      id: 'created-user',
      username: 'created-user',
      created_by: 'creator',
    })
    await writeFrozenFixture(h, 'task_collaborators', {
      task_id: 'fixture-task',
      user_id: 'created-user',
      added_by: 'creator',
    })
    await writeFrozenFixture(h, 'development_missions', { id: 'prior-mission' })
    await writeFrozenFixture(h, 'development_missions', {
      id: 'reopened-mission',
      reopened_from_mission_id: 'prior-mission',
    })
    const contribution = coreBFixture(
      ['users', 'task_collaborators', 'development_missions'],
      [
        fixtureLookup(userIds.key, [
          ['__system__', true],
          ['created-user', true],
        ]),
        fixtureLookup(missionIds.key, [['reopened-mission', true]]),
      ],
    )
    const input = await h.input([contribution])
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion(input, sink)
      expect(summary.status).toBe('blocked')
      for (const [table, column, value] of [
        ['users', 'created_by', 'creator'],
        ['task_collaborators', 'added_by', 'creator'],
        ['development_missions', 'reopened_from_mission_id', 'prior-mission'],
      ])
        expect(summary.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'v2-dangling-reference',
              sourceTable: table,
              missingFields: [column],
              detail: expect.objectContaining({
                column,
                value: { type: 'text', value },
                source: expect.any(Object),
              }),
            }),
          ]),
        )
      expect(sink.rows('users').some((row) => row.id === 'created-user')).toBe(false)
      expect(sink.rows('task_collaborators')).toEqual([])
      expect(sink.rows('development_missions').some((row) => row.id === 'reopened-mission')).toBe(
        false,
      )
      expect(summary.historyOnly).toEqual([])
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('memory supersession clears only dangling pointers, in either provider, with one decision per changed row', async () => {
    await h.install()
    for (const id of ['missing-a', 'missing-b', 'kept', 'one', 'both'])
      await writeFrozenFixture(h, 'memories', {
        id,
        scope_type: 'global',
        scope_id: null,
        supersedes_id: ['one', 'both'].includes(id) ? 'missing-a' : null,
        superseded_by_id: id === 'one' ? 'kept' : id === 'both' ? 'missing-b' : null,
      })
    const input = await h.input(
      [
        coreBFixture(
          ['memories'],
          [
            fixtureLookup(memoryIds.key, [
              ['kept', true],
              ['one', true],
              ['both', true],
            ]),
          ],
        ),
      ],
      { chunkLimit: 1 },
    )
    try {
      const originals = (await input.source.readChunk('memories', null, 10000)).decodedRows
      const sink = new V2MemorySink()
      const summary = await runConversion(input, sink)
      expect(summary.status).toBe('converted')
      for (const original of originals)
        expect(sink.rows('memories').find((row) => row.id === original.id)).toEqual({
          ...original,
          supersedes_id: ['one', 'both'].includes(String(original.id))
            ? null
            : original.supersedes_id!,
          superseded_by_id: original.id === 'both' ? null : original.superseded_by_id!,
        })
      const decisions = [...sink.units.values()].flatMap((unit) => unit.dispositions)
      expect(decisions).toHaveLength(2)
      expect(
        decisions.every(
          (decision) =>
            decision.kind === 'conflict-resolved' &&
            decision.decision?.code === 'v2-memory-supersession-detached',
        ),
      ).toBe(true)
      expect(decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            decision: {
              code: 'v2-memory-supersession-detached',
              detail: { pointers: { supersedes_id: 'missing-a', superseded_by_id: 'missing-b' } },
            },
          }),
        ]),
      )
      expect(summary.tableReceipts[0]!.counts).toEqual({
        preserved: 3,
        converted: 2,
        archived: 0,
        blocked: 0,
      })
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('dangling repo-group child applies exactly the six-field application detach and preserves the path', async () => {
    await h.install()
    await writeFrozenFixture(h, 'repo_groups', { id: 'root-group', name: 'Root' })
    await writeFrozenFixture(h, 'repo_groups', { id: 'child-group', name: 'Child' })
    await writeFrozenFixture(h, 'repo_group_nodes', {
      group_id: 'root-group',
      path: 'nested/path',
      attachment_kind: 'group',
      child_group_id: 'child-group',
      cached_repo_id: null,
      ref: '',
      subdir: '',
      readonly: true,
    })
    await writeFrozenFixture(h, 'repo_group_nodes', {
      group_id: 'root-group',
      path: 'kept',
      attachment_kind: 'group',
      child_group_id: 'root-group',
      cached_repo_id: null,
      ref: '',
      subdir: '',
      readonly: true,
    })
    const input = await h.input([
      coreBFixture(['repo_group_nodes'], [fixtureLookup(repoGroupIds.key, [['root-group', true]])]),
    ])
    try {
      const reader = input.source
      const source = {
        ...reader,
        async readChunk(
          table: string,
          after: Parameters<typeof reader.readChunk>[1],
          limit: number,
        ) {
          const chunk = await reader.readChunk(table, after, limit)
          return table === 'repo_group_nodes'
            ? {
                ...chunk,
                decodedRows: chunk.decodedRows.map((row) =>
                  row.path === 'nested/path'
                    ? { ...row, cached_repo_id: 'old-cache', ref: 'branch-ref', subdir: 'subdir' }
                    : row,
                ),
              }
            : chunk
        },
      }
      const sink = new V2MemorySink()
      const summary = await runConversion({ ...input, source }, sink)
      expect(summary.status).toBe('converted')
      expect(sink.rows('repo_group_nodes').find((row) => row.path === 'nested/path')).toEqual({
        group_id: 'root-group',
        path: 'nested/path',
        attachment_kind: null,
        cached_repo_id: null,
        child_group_id: null,
        ref: '',
        subdir: '',
        readonly: false,
      })
      expect(sink.rows('repo_group_nodes').find((row) => row.path === 'kept')).toMatchObject({
        child_group_id: 'root-group',
        attachment_kind: 'group',
        ref: '',
        readonly: true,
      })
      const decisions = [...sink.units.values()].flatMap((unit) => unit.dispositions)
      expect(decisions).toHaveLength(1)
      expect(decisions[0]!.decision).toMatchObject({
        code: 'v2-repo-group-detached',
        detail: {
          previous: {
            child_group_id: { type: 'text', value: 'child-group' },
            cached_repo_id: { type: 'text', value: 'old-cache' },
            ref: { type: 'text', value: 'branch-ref' },
            subdir: { type: 'text', value: 'subdir' },
            readonly: { type: 'boolean', value: true },
          },
        },
      })
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('existing and NULL creator/reopen references are copied without dispositions', async () => {
    await h.install()
    await ensureIdentitySeeds(h)
    await writeFrozenFixture(h, 'users', { id: 'creator', username: 'creator' })
    await writeFrozenFixture(h, 'users', {
      id: 'child-user',
      username: 'child-user',
      created_by: 'creator',
    })
    await writeFrozenFixture(h, 'development_missions', { id: 'parent-mission' })
    await writeFrozenFixture(h, 'development_missions', {
      id: 'child-mission',
      reopened_from_mission_id: 'parent-mission',
    })
    const input = await h.input([
      coreBFixture(
        ['users', 'development_missions'],
        [
          fixtureLookup(userIds.key, [
            ['__system__', true],
            ['creator', true],
            ['child-user', true],
          ]),
        ],
      ),
    ])
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).status).toBe('converted')
      expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toEqual([])
      expect(sink.rows('users').find((row) => row.id === 'child-user')!.created_by).toBe('creator')
      expect(
        sink.rows('development_missions').find((row) => row.id === 'child-mission')!
          .reopened_from_mission_id,
      ).toBe('parent-mission')
    } finally {
      await input.source.close()
    }
  }, 180_000)
})

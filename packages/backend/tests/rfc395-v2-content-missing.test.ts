import { setDefaultTimeout, expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  contentFixture,
  contentLookups,
  contentTask,
  seedContentParents,
  FakeContentInventory,
  contentDigest,
} from './helpers/rfc395V2/contentFixtures'
import { conversion } from '@/platform/content/migration'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'

// Slowest case took 3.15 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

const location = { codec: 'review-body', value: 'runs/task/review/doc.md' }
describeV2Providers('RFC-395 V2-X missing content', (h) => {
  for (const status of ['pending', 'running', 'awaiting_review', 'awaiting_human', 'interrupted']) {
    test(`D4 ${status}: originally missing required content blocks using TASK_FACTS`, async () => {
      await h.install()
      await seedContentParents(h)
      const inventory = new FakeContentInventory().set(location, {
        state: 'absent',
        cause: 'originally-absent',
        evidence: 'source backup already lacked this file',
      })
      const input = await h.input(
        [conversion, contentLookups([contentTask('executable', status)])],
        { content: inventory },
      )
      try {
        const sink = new V2MemorySink()
        const summary = await runConversion(input, sink)
        expect(summary.blocks).toContainEqual(
          expect.objectContaining({
            code: 'v2-content-required-missing',
            taskId: 'task',
            sourceTable: 'doc_versions',
          }),
        )
        expect(sink.rows('doc_versions')).toEqual([])
        expect([...sink.units.values()].flatMap((unit) => unit.artifacts)).toContainEqual(
          expect.objectContaining({
            sourceTable: 'doc_versions',
            missing: {
              state: 'originally-absent',
              evidence: 'source backup already lacked this file',
            },
          }),
        )
      } finally {
        await input.source.close()
      }
    })
  }
  for (const [status, execution] of [
    ['failed', 'retryable-history'],
    ['canceled', 'retryable-history'],
    ['done', 'terminal-history'],
  ] as const) {
    test(`D4 ${status}: keep reference, missing evidence and a history-only restriction`, async () => {
      await h.install()
      await seedContentParents(h)
      const input = await h.input([conversion, contentLookups([contentTask(execution, status)])], {
        content: new FakeContentInventory().set(location, {
          state: 'absent',
          cause: 'originally-absent',
          evidence: 'document absent before freeze',
        }),
      })
      try {
        const sink = new V2MemorySink()
        expect((await runConversion(input, sink)).blocks).toEqual([])
        const dispositions = [...sink.units.values()].flatMap((unit) => unit.dispositions)
        expect(dispositions).toContainEqual(
          expect.objectContaining({
            sourceTable: 'doc_versions',
            kind: 'history-only',
            history: { taskId: 'task', runId: null, execution, missingFields: ['body_path'] },
          }),
        )
        expect(
          JSON.parse(sink.rows('doc_versions')[0]!.content_ref_json as string).location,
        ).toEqual(location)
      } finally {
        await input.source.close()
      }
    })
  }
  test('new loss at freeze is distinct and blocks even terminal content', async () => {
    await h.install()
    await seedContentParents(h)
    const input = await h.input([conversion, contentLookups()], {
      content: new FakeContentInventory().set(location, {
        state: 'absent',
        cause: 'missing-at-freeze',
        evidence: 'present in preparation inventory, lost at watermark',
      }),
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toContainEqual(
        expect.objectContaining({ code: 'v2-content-lost-at-freeze' }),
      )
      expect(
        [...sink.units.values()]
          .flatMap((unit) => unit.artifacts)
          .find((receipt) => receipt.sourceTable === 'doc_versions')!.missing!.state,
      ).toBe('missing-at-freeze')
    } finally {
      await input.source.close()
    }
  })
  test('missing TASK_FACTS blocks instead of treating a known task as terminal', async () => {
    await h.install()
    await seedContentParents(h)
    const input = await h.input([conversion, contentLookups([])], {
      content: new FakeContentInventory().set(location, {
        state: 'absent',
        cause: 'originally-absent',
        evidence: 'missing file',
      }),
    })
    try {
      expect((await runConversion(input, new V2MemorySink())).blocks).toContainEqual(
        expect.objectContaining({ code: 'v2-content-task-unprovable', taskId: 'task' }),
      )
    } finally {
      await input.source.close()
    }
  })
  test('inventory digests are checked against the bytes actually read', async () => {
    await h.install()
    await seedContentParents(h)
    const content = {
      async stat() {
        return { state: 'present' as const, sha256: contentDigest, size: 3 }
      },
      async read() {
        return new Uint8Array([1, 2, 3])
      },
    }
    const input = await h.input([conversion, contentLookups()], { content })
    try {
      expect((await runConversion(input, new V2MemorySink())).blocks).toContainEqual(
        expect.objectContaining({ code: 'v2-content-bytes-unprovable' }),
      )
    } finally {
      await input.source.close()
    }
  })
  test('active output archive files are inventoried without rewriting the self-contained JSON', async () => {
    await h.install()
    await seedContentParents(h)
    const file = 'runs/task/ports/run/missing.txt'
    const archive = ` { "v": 1, "items": [{"path":"input.txt","file":"${file}","size":999,"truncated":true}] } `
    await h.write('node_run_outputs', [
      contentFixture('node_run_outputs', { archive_json: archive }),
    ])
    const input = await h.input(
      [conversion, contentLookups([contentTask('executable', 'running')])],
      {
        content: new FakeContentInventory().set(
          { codec: 'port-archive-file', value: file },
          { state: 'absent', cause: 'originally-absent', evidence: 'missing port bytes' },
        ),
      },
    )
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion(input, sink)
      expect(summary.blocks).toContainEqual(
        expect.objectContaining({
          code: 'v2-content-required-missing',
          taskId: 'task',
          runId: 'run',
          missingFields: ['archive_json.items[0].file'],
        }),
      )
      expect([...sink.units.values()].flatMap((unit) => unit.artifacts)).toContainEqual(
        expect.objectContaining({
          sourceColumn: 'archive_json.items[0].file',
          originalReference: file,
        }),
      )
      expect(sink.rows('node_run_outputs')).toEqual([])
    } finally {
      await input.source.close()
    }
  })
})

import { expect, test } from 'bun:test'
import { conversion } from '@/modules/task-execution/infrastructure/migration/run'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { decodeContentRefColumns } from '@/platform/content/contentRefCodec'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { runValues, taskFacts, taskMounts, writeTask } from './helpers/rfc395V2/runFixtures'

describeV2Providers('RFC-395 V2-N split tables and immutable bytes', (h) => {
  test('D15 only non-NULL source fields create config/state/result rows, including zero and false', async () => {
    await h.install()
    const task = taskFacts()
    await writeTask(h, task)
    await h.write('node_runs', [
      runValues('empty', { seq: 1 }),
      runValues('config', { seq: 2, runtime: 'frozen-runtime' }),
      runValues('state', { seq: 3, pid: 0 }),
      runValues('result', { seq: 4, rolled_back: false, tok_total: 0 }),
    ])
    const input = await h.input([conversion], {
      fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      expect(sink.rows('node_run_configs').map((row) => row.node_run_id)).toEqual(['config'])
      expect(sink.rows('node_run_runtime_states').map((row) => row.node_run_id)).toEqual(['state'])
      expect(sink.rows('node_run_results').map((row) => row.node_run_id)).toEqual(['result'])
      expect(sink.rows('node_run_results')[0]).toMatchObject({ tok_total: 0, rolled_back: false })
      expect(sink.rows('node_run_runtime_states')[0]).toMatchObject({ pid: 0, session_id: null })
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('migration 4.6 preserves continuation, lineage, node id, operation generation, spawn and JSON bytes by value', async () => {
    await h.install()
    const task = taskFacts()
    await writeTask(h, task)
    const json = '{ "unchanged": [1, 2], "中": true }\n'
    await h.write('node_runs', [
      runValues('r', {
        runtime: 'runtime',
        runtime_binary: '/bin/frozen',
        runtime_params_json: json,
        inventory_snapshot_json: json,
        runtime_inventory_json: json,
        injected_memories_json: json,
        agent_override_name: 'name',
        agent_override_id: 'agent',
        spawn_binary_path: '/spawn/path',
        spawn_launch_nonce: 'spawn-nonce',
        startup_verification_json: json,
        opencode_session_id: 'session',
        iso_worktree_path: 'iso-path',
        commit_push_json: json,
        port_validation_failures_json: json,
        continuation_slot_key: 'continue:original',
        lineage_slot_path_json: '[ "original", 1 ]',
        operation_generation: 77,
        rerun_cause: 'historical-cause',
        parent_node_run_id: null,
        superseded_by_review: 'review',
        rolled_back: true,
      }),
    ])
    const input = await h.input([conversion], {
      fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      expect(sink.rows('node_runs')[0]).toMatchObject({
        node_id: 'ordinary',
        continuation_slot_key: 'continue:original',
        lineage_slot_path_json: '[ "original", 1 ]',
        operation_generation: 77,
        generation_seq: 0,
        rerun_cause: 'historical-cause',
        historical_parent_id: null,
      })
      expect(sink.rows('node_run_configs')[0]).toMatchObject({
        runtime_params_json: json,
        inventory_snapshot_json: json,
        runtime_inventory_json: json,
        injected_memories_json: json,
        agent_override_name: 'name',
        agent_override_id: 'agent',
      })
      expect(sink.rows('node_run_runtime_states')[0]).toMatchObject({
        session_id: 'session',
        isolation_root_ref: 'iso-path',
        spawn_binary_path: '/spawn/path',
        spawn_launch_nonce: 'spawn-nonce',
        startup_verification_json: json,
      })
      expect(sink.rows('node_run_results')[0]).toMatchObject({
        commit_push_json: json,
        port_validation_failures_json: json,
        superseded_by_review: 'review',
        rolled_back: true,
      })
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('inline prompts preserve UTF-8 bytes; file prompts retain location and inventory receipts without reads or publication', async () => {
    await h.install()
    const task = taskFacts()
    await writeTask(h, task)
    await h.write('node_runs', [
      runValues('inline', {
        seq: 1,
        prompt_text: '\ufeff中\n',
        prompt_path: 'legacy/also-recorded.md',
      }),
      runValues('file', { seq: 2, prompt_path: 'task/prompts/file.md' }),
    ])
    if (h.sourceHarness.provider === 'sqlite') {
      const bytes = Buffer.from('\ufeff中\n')
      h.sourceHarness.sqlite
        .query("UPDATE node_runs SET prompt_text=CAST(? AS TEXT) WHERE id='inline'")
        .run(bytes)
      expect(
        h.sourceHarness.sqlite
          .query("SELECT hex(prompt_text) AS bytes FROM node_runs WHERE id='inline'")
          .get(),
      ).toEqual({ bytes: bytes.toString('hex').toUpperCase() })
    }
    const stats: unknown[] = []
    const input = await h.input([conversion], {
      fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
      content: {
        async stat(location) {
          stats.push(location)
          return { state: 'present', size: 4, sha256: 'a'.repeat(64) }
        },
        async read() {
          throw new Error('migration must not relocate file prompts')
        },
      },
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      const inline = sink.rows('node_run_configs').find((row) => row.node_run_id === 'inline')!
      expect(Buffer.from(inline.prompt_inline_bytes as Uint8Array)).toEqual(
        Buffer.from('\ufeff中\n'),
      )
      const file = sink.rows('node_run_configs').find((row) => row.node_run_id === 'file')!
      const ref = decodeContentRefColumns(
        file.prompt_ref_json as string,
        file.prompt_inline_bytes as Uint8Array | null,
      )!
      expect(ref.kind).toBe('local-file')
      expect(ref.location).toEqual({
        codec: 'prompt',
        value: { promptText: null, promptPath: 'task/prompts/file.md' },
      })
      expect(stats).toEqual([ref.location])
      const receipts = [...sink.units.values()].flatMap((unit) => unit.artifacts)
      expect(receipts).toHaveLength(2)
      expect(
        receipts.every(
          (receipt) => receipt.publication === 'not-required' && receipt.missing === null,
        ),
      ).toBe(true)
    } finally {
      await input.source.close()
    }
  }, 180_000)
  for (const status of ['running', 'failed', 'canceled', 'done'])
    for (const cause of ['originally-absent', 'missing-at-freeze'] as const)
      test(`${cause}: missing prompt artifact in ${status} is recorded with original location and remains executable`, async () => {
        await h.install()
        const task = taskFacts('task', status)
        await writeTask(h, task)
        await h.write('node_runs', [runValues('file', { prompt_path: 'missing.md' })])
        const input = await h.input([conversion], {
          fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
          content: {
            async stat() {
              return { state: 'absent', cause, evidence: 'frozen inventory' }
            },
            async read() {
              throw new Error('absent')
            },
          },
        })
        try {
          const sink = new V2MemorySink()
          const summary = await runConversion(input, sink)
          expect(summary.blocks).toEqual([])
          expect(summary.historyOnly).toEqual([])
          expect([...sink.units.values()].flatMap((unit) => unit.artifacts)[0]!.missing).toEqual({
            state: cause,
            evidence: 'frozen inventory',
          })
          expect(sink.rows('node_runs')[0]!.record_mode).toBe('executable')
        } finally {
          await input.source.close()
        }
      }, 180_000)
})

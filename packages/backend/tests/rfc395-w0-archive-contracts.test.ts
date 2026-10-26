// RFC-395 II-b W0: T/N/C implement sections; Q consumes and reads v2. Locks archive coverage.
import { describe, expect, expectTypeOf, test } from 'bun:test'
import {
  TASK_ARCHIVE_SCHEMA_VERSION,
  TASK_ARCHIVE_V2_SCHEMA_VERSION,
  TASK_ARCHIVE_V2_TABLES,
  TASK_ARCHIVE_V3_TABLES,
  type TaskArchiveCollaborationSection,
  type TaskArchiveNodeRunSection,
  type TaskArchiveTaskSection,
  type TaskArchiveV2Reader,
  type TaskArchiveV2ReadView,
  type TaskArchiveV2Table,
  type TaskArchiveV3WireSections,
  type TaskArchiveWireValue,
} from '@/platform/contracts/taskArchive'

describe('RFC-395 W0 archive contracts', () => {
  test('Q owns separate v3 and historical v2 contracts', () => {
    expect(TASK_ARCHIVE_SCHEMA_VERSION).toBe(3)
    expect(TASK_ARCHIVE_V2_SCHEMA_VERSION).toBe(2)
    expect(TASK_ARCHIVE_V2_TABLES).toHaveLength(32)
    expect(TASK_ARCHIVE_V2_TABLES).toContain('task_repos')
    expectTypeOf<
      Awaited<ReturnType<TaskArchiveV2Reader['read']>>
    >().toEqualTypeOf<TaskArchiveV2ReadView>()
    expectTypeOf<string extends TaskArchiveV2Table ? true : false>().toEqualTypeOf<false>()
  })

  test('every existing archive family survives, with task_repos replaced by mounts', () => {
    const tables = Object.values(TASK_ARCHIVE_V3_TABLES).flatMap((section) => Object.keys(section))
    expect(new Set(tables).size).toBe(tables.length)
    for (const table of TASK_ARCHIVE_V2_TABLES)
      expect(tables).toContain(table === 'task_repos' ? 'task_repository_mounts' : table)
    expect(tables).not.toContain('task_repos')
    for (const table of [
      'task_definitions',
      'task_launch_contexts',
      'task_workspaces',
      'task_execution_generations',
      'node_run_configs',
      'node_run_runtime_states',
      'node_run_results',
      'node_run_inputs',
      'node_run_selections',
      'node_run_repo_checkpoints',
      'node_run_seq_allocations',
      'execution_legacy_evidence',
      'clarify_answers',
      'clarify_answer_drafts',
      'clarify_answer_attributions',
    ])
      expect(tables).toContain(table)
  })

  test('native sections expose precise target rows and independent clarify attribution', () => {
    expectTypeOf<TaskArchiveTaskSection['owner']>().toEqualTypeOf<'T'>()
    expectTypeOf<TaskArchiveNodeRunSection['owner']>().toEqualTypeOf<'N'>()
    expectTypeOf<TaskArchiveCollaborationSection['owner']>().toEqualTypeOf<'C'>()
    expectTypeOf<
      TaskArchiveTaskSection['rows']['task_repository_mounts'][number]['repoKey']
    >().toEqualTypeOf<string>()
    expectTypeOf<
      TaskArchiveNodeRunSection['rows']['node_run_repo_checkpoints'][number]['preSnapshot']
    >().toEqualTypeOf<string | null>()
    expectTypeOf<
      TaskArchiveCollaborationSection['rows']['clarify_answer_attributions'][number]['occurrence']
    >().toEqualTypeOf<number>()
    expectTypeOf<
      TaskArchiveCollaborationSection['rows']['clarify_rounds'][number]['legacyAnswersJson']
    >().toEqualTypeOf<string | null>()
  })

  test('wire types preserve binary columns, large integers and raw JSON-text spelling', () => {
    expectTypeOf<TaskArchiveWireValue<Uint8Array | null>>().toEqualTypeOf<{
      readonly codec: 'bytes@1'
      readonly base64: string
    } | null>()
    expectTypeOf<TaskArchiveWireValue<bigint>>().toEqualTypeOf<{
      readonly codec: 'bigint@1'
      readonly decimal: string
    }>()
    expectTypeOf<
      TaskArchiveV3WireSections['nodeRuns']['rows']['node_run_outputs'][number]['contentInlineBytes']
    >().toEqualTypeOf<TaskArchiveWireValue<Uint8Array | null>>()
    expectTypeOf<TaskArchiveWireValue<string>>().toEqualTypeOf<string>()
  })
})

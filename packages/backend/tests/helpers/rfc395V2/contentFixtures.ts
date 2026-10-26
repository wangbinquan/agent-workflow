import type { V2Harness } from '../rfc395V2Harness'
import { fixtureLookup } from '../rfc395V2Harness'
import { frozenEpoch1Registry } from '@/platform/persistence/migration/epoch1/definitions'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import type { ContentLocation } from '@/platform/content/contentRef'
import type {
  ContentInventory,
  ContentStat,
} from '@/platform/persistence/migration/conversion/content'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import {
  TASK_FACTS,
  type TaskFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import {
  NODE_CONTENT_TASK,
  REVIEW_CONTENT_TASK,
  GATE_CONTENT_TASK,
} from '@/platform/content/migration/receipts'
import {
  historyAdoptionsLookup,
  HISTORY_MISSIONS,
  HISTORY_ROUNDS,
  HISTORY_WORK_ITEMS,
} from '@/platform/persistence/migration/archives/adoptions'

export const contentText = ' { "z": 1, "a": [2, 3] }\r\n'
export const contentBytes = new TextEncoder().encode(contentText)
export const contentDigest = bytesDigest(contentBytes).slice(7)
export const objectId = '12345678-1234-4234-8234-123456789abc'

/** Frozen physical defaults only; inserts always pass through h.write's raw epoch-1 writer. */
export function frozenValues(table: string, overrides: DecodedSourceRow = {}): DecodedSourceRow {
  const definition = frozenEpoch1Registry.tables.find((value) => value.id === table)!
  const values = Object.fromEntries(
    Object.values(definition.columns).map((column) => {
      const value =
        column.default.kind === 'literal'
          ? column.default.value
          : column.nullable
            ? null
            : column.codec === 'bool'
              ? false
              : column.codec === 'enum'
                ? column.enumValues![0]!
                : ['int', 'identity', 'epochMs', 'durationMs', 'seq', 'real'].includes(column.codec)
                  ? 123
                  : column.codec === 'bigint'
                    ? 123n
                    : column.codec === 'bytes'
                      ? new Uint8Array([1])
                      : ['jsonText', 'jsonDoc', 'rawJson'].includes(column.codec)
                        ? '{}'
                        : `fixture-${column.name}`
      return [column.name, value]
    }),
  )
  return {
    ...values,
    ...(table === 'memories' ? { scope_type: 'global', scope_id: null } : {}),
    ...overrides,
  }
}

export async function seedContentParents(h: V2Harness): Promise<void> {
  await h.write('workflows', [
    frozenValues('workflows', {
      id: 'workflow',
      name: 'content-fixture',
      definition: '{"nodes":[],"edges":[]}',
    }),
  ])
  await h.write('tasks', [
    frozenValues('tasks', {
      id: 'task',
      workflow_id: 'workflow',
      status: 'done',
      workflow_snapshot: '{"nodes":[],"edges":[]}',
      inputs: '{}',
      space_kind: 'internal',
    }),
  ])
  await h.write('node_runs', [
    frozenValues('node_runs', {
      id: 'run',
      task_id: 'task',
      node_id: 'node',
      status: 'done',
      seq: null,
    }),
  ])
  await h.write('collaboration_gate_operations', [
    frozenValues('collaboration_gate_operations', {
      id: 'gate',
      task_id: 'task',
      state: 'completed',
      gate_kind: 'review',
      operation_kind: 'open',
      gate_ref: 'run',
      result_gate_revision: 124,
      receipt_json: '{"accepted":true}',
      committed_at: 123,
      completed_at: 124,
    }),
  ])
  await h.write('skills', [
    frozenValues('skills', { id: 'skill', name: 'fixture-skill', managed_path: null }),
  ])
  await h.write('doc_versions', [contentFixture('doc_versions')])
}

export function contentFixture(table: string, overrides: DecodedSourceRow = {}): DecodedSourceRow {
  const common = {
    digest: contentDigest,
    sha256: contentDigest,
    size: contentBytes.length,
    object_id: objectId,
  }
  const byTable: Readonly<Record<string, DecodedSourceRow>> = {
    collaboration_gate_artifacts: {
      operation_id: 'gate',
      artifact_key: 'artifact',
      staged_path: 'runs/.staging/doc.md',
      final_path: 'runs/task/review/doc.md',
      sha256: common.sha256,
      byte_size: common.size,
      state: 'finalized',
    },
    development_object_artifacts: {
      reference: 'blob:fixture',
      object_id: common.object_id,
      digest: common.digest,
      size: common.size,
    },
    doc_versions: {
      id: 'doc',
      task_id: 'task',
      review_node_id: 'node',
      review_node_run_id: 'run',
      source_node_id: 'node',
      body_path: 'runs/task/review/doc.md',
    },
    employee_reaction_artifacts: {
      digest: common.digest,
      body: contentText,
      bytes: common.size,
      kind: 'diagnostics',
    },
    hosted_node_event_archives: {
      id: 'archive',
      task_id: 'task',
      node_run_id: 'run',
      object_id: common.object_id,
      digest: common.digest,
      size: common.size,
      state: 'ready',
      first_id: 1,
      last_id: 1,
      row_count: 1,
    },
    hosted_task_archive_entries: {
      path: 'cs-archive:tasks/task/log',
      kind: 'file',
      parts_json: JSON.stringify([
        { key: 'part:first', id: objectId, sha256: contentDigest, size: common.size },
      ]),
    },
    hosted_task_artifacts: {
      reference: 'runs/task/ports/run/file',
      task_id: 'task',
      object_id: common.object_id,
      digest: common.digest,
      size: common.size,
    },
    node_run_outputs: {
      node_run_id: 'run',
      port_name: 'out',
      content: contentText,
      archive_json: ' { "v": 1, "items": [] } ',
      active: true,
    },
    review_comments: { id: 'comment', doc_version_id: 'doc', comment_text: contentText },
    skill_content_entries: {
      skill_id: 'skill',
      tree: 'live',
      path: 'SKILL.md',
      encoding: 'utf8',
      content: contentText,
      size: common.size,
    },
    skill_versions: {
      id: 'version',
      skill_id: 'skill',
      version_index: 1,
      files_path: 'skills/skill/versions/v1/files',
    },
    skills: { id: 'other-skill', name: 'other-skill', managed_path: 'skills/other-skill/files' },
    hosted_object_publications: {
      id: 'publication',
      scope: 'task',
      owner: 'task-artifact',
      logical_key: 'key',
      state: 'ready',
      object_id: common.object_id,
      sha256: common.sha256,
      size: common.size,
      source_sealed: null,
    },
  }
  return frozenValues(table, { ...byTable[table], ...overrides })
}

export class FakeContentInventory implements ContentInventory {
  readonly calls: ContentLocation[] = []
  private readonly entries = new Map<string, Uint8Array | ContentStat>()
  constructor(readonly fallback: Uint8Array = contentBytes) {}
  set(location: ContentLocation, value: Uint8Array | ContentStat): this {
    this.entries.set(canonicalSchemaJson(location), value)
    return this
  }
  async stat(location: ContentLocation): Promise<ContentStat> {
    this.calls.push(location)
    const value = this.entries.get(canonicalSchemaJson(location)) ?? this.fallback
    return value instanceof Uint8Array
      ? { state: 'present', size: value.byteLength, sha256: bytesDigest(value).slice(7) }
      : value
  }
  async read(location: ContentLocation): Promise<Uint8Array> {
    const value = this.entries.get(canonicalSchemaJson(location)) ?? this.fallback
    if (!(value instanceof Uint8Array)) throw new Error('fixture content absent')
    return Uint8Array.from(value)
  }
}

export function contentTask(
  execution: TaskFacts['execution'] = 'terminal-history',
  status = 'done',
): TaskFacts {
  return {
    taskId: 'task',
    parentTaskId: null,
    rootTaskId: null,
    status,
    startedAt: 123,
    execution,
    subjectKind: 'workflow',
    sourceId: 'workflow',
    definitionAnchorId: 'workflow',
    engineKind: 'dag',
    spaceKind: 'internal',
    workflowVersion: 1,
  }
}
export function contentLookups(
  tasks: readonly TaskFacts[] = [contentTask()],
): ConversionContribution {
  return {
    rules: [],
    validators: [],
    lookups: [
      fixtureLookup(
        TASK_FACTS,
        tasks.map((value) => [value.taskId, value]),
      ),
      fixtureLookup(NODE_CONTENT_TASK, [['run', { task_id: 'task' }]]),
      fixtureLookup(REVIEW_CONTENT_TASK, [['doc', { task_id: 'task' }]]),
      fixtureLookup(GATE_CONTENT_TASK, [['gate', { task_id: 'task' }]]),
    ],
  }
}
export function historyLookups(
  overrides: {
    readonly item?: DecodedSourceRow
    readonly round?: DecodedSourceRow
    readonly mission?: boolean
    readonly adoptions?: boolean
  } = {},
): ConversionContribution {
  return {
    rules: [],
    validators: [],
    lookups: [
      fixtureLookup(HISTORY_WORK_ITEMS, [
        [
          'work',
          overrides.item ?? {
            status: 'settled',
            pending_generation: null,
            publishing_epoch: null,
            pending_revision: null,
          },
        ],
      ]),
      fixtureLookup(HISTORY_ROUNDS, [
        ['round', overrides.round ?? { outcome: 'published', ended_at: 123 }],
      ]),
      fixtureLookup(HISTORY_MISSIONS, overrides.mission === false ? [] : [['mission', true]]),
      ...(overrides.adoptions === false ? [] : [historyAdoptionsLookup]),
    ],
  }
}

export async function readFrozenRows(h: V2Harness, table: string): Promise<readonly SourceRow[]> {
  const reader = await h.sourceHarness.source()
  try {
    await reader.preflight()
    const chunk = await reader.readChunk(table, null, 1000)
    return chunk.rows.map((canonical, index) => {
      const values = chunk.decodedRows[index]!
      const key = chunk.migrationKey.map((column) => canonicalValue(values[column]!))
      return {
        table,
        phase: 'current',
        key,
        encodedKey: encodeMigrationKey(table, key),
        canonical,
        values,
      }
    })
  } finally {
    await reader.close()
  }
}

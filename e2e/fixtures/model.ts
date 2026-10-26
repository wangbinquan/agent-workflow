// Node-loaded SQLite fixture transport; codecs are pure and persistence handles remain type-only.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  splitTaskCreation,
  taskMountAtCreation,
} from '../../packages/backend/src/modules/task-execution/domain/taskCreation'
import {
  TASK_DEFINITION_HOSTS,
  taskDefinitionOrigin,
} from '../../packages/backend/src/modules/task-execution/domain/taskSubject'
import { decodeTaskSubject } from '../../packages/backend/src/modules/task-execution/infrastructure/migration/task/subject'
import { taskRepositoryNodePaths } from '../../packages/backend/src/platform/taskRepository'
import { nodeRunLineageColumns } from '../../packages/backend/src/modules/task-execution/application/buildNodeRunMintRecord'
import { nodeRunRowPresence } from '../../packages/backend/src/modules/task-execution/domain/nodeRunRowPresence'
import { nodeRunFixtureIdentity } from '../../packages/backend/tests/helpers/model/identity'
import { producerShardSlot } from '../../packages/backend/src/modules/task-execution/domain/runInputShard'
import { agentReferenceRows } from '../../packages/backend/src/modules/resource-catalog/domain/agentReferenceKey'
import { decodeLegacyClarifyAnswerColumns } from '../../packages/backend/src/modules/collaboration/infrastructure/clarifyAnswerCodec'
import { scanJsonObjectEntries } from '../../packages/backend/src/platform/persistence/migration/conversion/orderedJson'
import { contentRefColumns } from '../../packages/backend/src/platform/content/contentStore'
import { legacyContentRef } from '../../packages/backend/src/platform/content/contentRef'
import { clarifyQuestionSetKey } from '../../packages/shared/src/clarifyMindmap'
import {
  workflowDependencyIndexEntries,
  type AgentReferences,
} from '../../packages/shared/src/resourceReferences'
import type { ClarifyQuestion } from '../../packages/shared/src/schemas/clarify'
import type {
  AgentFixtureSpec,
  ClarifyRoundFixtureSpec,
  NodeRunFixtureSpec,
  NodeRunOutputFixtureSpec,
  TaskFixtureSpec,
  TaskRepoFixtureSpec,
  WorkflowFixtureSpec,
} from '../../packages/backend/tests/helpers/model'
type Entry = {
  table: string
  property: string
  physical: string
  spec: string
  target: string
  json?: boolean
}
const inventory = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../packages/backend/tests/fixtures/rfc395-column-destinations.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as { columns: Entry[]; targetColumns: Record<string, Record<string, string>> }
function literal(value: unknown): string {
  if (value == null) return 'NULL'
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') return String(value)
  return "'" + String(value).replaceAll("'", "''") + "'"
}
const json = (value: unknown): string | null =>
  value == null ? null : typeof value === 'string' ? value : JSON.stringify(value)
const rows = <S>(input: S | readonly S[]): readonly S[] =>
  Array.isArray(input) ? input : [input as S]
function encode(table: string, spec: object): Record<string, unknown> {
  const input = spec as Record<string, unknown>
  return Object.fromEntries(
    inventory.columns
      .filter(
        (e) =>
          e.table === table &&
          !['repos', 'checkpoints', 'consumedEdges'].includes(e.spec) &&
          e.target !== 'deleted-shape' &&
          input[e.spec] !== undefined,
      )
      .map((e) => [e.property, e.json ? json(input[e.spec]) : input[e.spec]]),
  )
}
function physical(table: string, row: object): Record<string, unknown> {
  const columns = inventory.targetColumns[table]
  if (!columns) throw new Error('fixture-target-table-missing:' + table)
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key, value]) => key in columns && value !== undefined)
      .map(([key, value]) => [columns[key]!, value]),
  )
}
function insert(
  table: string,
  row: Record<string, unknown>,
  expressions: Record<string, string> = {},
): string {
  const values = physical(table, row)
  const columns = [...new Set([...Object.keys(values), ...Object.keys(expressions)])]
  return `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((c) => expressions[c] ?? literal(values[c])).join(',')});`
}
function inline(text: string) {
  const bytes = Buffer.from(text, 'utf8')
  const value = contentRefColumns.encode({
    version: 1,
    kind: 'inline',
    location: { codec: 'inline@1', value: null },
    contentId: null,
    contentVersion: null,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    mediaType: 'text/plain',
    bytes,
  })
  return { contentRefJson: value.json, contentInlineBytes: value.inlineBytes }
}
function mount(spec: TaskRepoFixtureSpec) {
  return taskMountAtCreation(spec.taskId, {
    ...spec,
    ordinal: spec.repoIndex,
    mountPath: spec.mountPath ?? '',
    repoUrl: spec.repoUrl ?? null,
    cachedRepoId: spec.cachedRepoId ?? null,
    baseBranch: spec.baseBranch ?? '',
    workingBranch: spec.workingBranch ?? null,
    baseCommit: spec.baseCommit ?? null,
    subdir: spec.subdir ?? '',
    readonly: spec.readonly ?? false,
    readonlyDirtyCount: spec.readonlyDirtyCount ?? null,
    workspaceProfileVersion: spec.workspaceProfileVersion ?? null,
    workspaceProfileDigest: spec.workspaceProfileDigest ?? null,
    hasSubmodules: spec.hasSubmodules ?? null,
    submoduleInitOk: spec.submoduleInitOk ?? null,
    submoduleInitError: spec.submoduleInitError ?? null,
  })
}
function directories(taskId: string, paths: readonly string[]): string {
  return taskRepositoryNodePaths(paths)
    .map(
      (nodePath) =>
        `INSERT OR IGNORE INTO task_space_nodes(task_id,node_path,schema_version) VALUES(${literal(taskId)},${literal(nodePath)},1);`,
    )
    .join('\n')
}
export function taskFixtureSql(input: TaskFixtureSpec | readonly TaskFixtureSpec[]): string {
  return rows(input)
    .map((spec) => {
      const subject = decodeTaskSubject(spec)
      const values = splitTaskCreation({
        subject,
        core: {
          ...spec,
          name: spec.name ?? 'task-' + spec.id.slice(-10),
          ownerUserId: spec.ownerUserId ?? null,
          catalogVisibility: spec.catalogVisibility ?? 'public',
          branchStartedAt: spec.branchStartedAt ?? spec.startedAt,
        },
        definition: {
          definitionOrigin: taskDefinitionOrigin(subject, false),
          workflowSnapshot: json(spec.workflowSnapshot)!,
          workflowVersion: spec.workflowVersion ?? null,
          inputs: json(spec.inputs)!,
          maxDurationMs: spec.maxDurationMs,
          maxTotalTokens: spec.maxTotalTokens,
          workgroupConfigJson: json(spec.workgroupConfigJson),
          refClosureJson: json(spec.refClosureJson),
        },
        launch: { kind: 'root', launchOrigin: spec.launchOrigin ?? 'manual' },
        launchContext: {
          ...spec,
          triggerContextJson: json(spec.triggerContextJson),
          platformInputPathsJson: json(spec.platformInputPathsJson),
        },
        workspace: {
          ...spec,
          baseCommit: spec.baseCommit ?? null,
          spaceKind: spec.spaceKind ?? 'remote',
        },
        repos: (spec.repos ?? []).map((repo) => ({
          ...mount({ ...repo, taskId: spec.id }),
          baseBranch: repo.baseBranch ?? '',
          branch: repo.branch,
          worktreePath: repo.worktreePath,
        })),
        nodePaths: [],
      })
      const taskExpressions: Record<string, string> = {}
      const launchExpressions: Record<string, string> = {}
      if (spec.parentTaskId) {
        const parent = literal(spec.parentTaskId)
        taskExpressions.root_task_id = `(SELECT coalesce(root_task_id,id) FROM tasks WHERE id=${parent})`
        launchExpressions.execution_lineage_id = `(SELECT coalesce(execution_lineage_id,task_id) FROM task_launch_contexts WHERE task_id=${parent})`
        launchExpressions.launch_origin = `(SELECT launch_origin FROM task_launch_contexts WHERE task_id=${parent})`
        const parentPath = spec.parentNodeRunId
          ? `coalesce((SELECT lineage_slot_path_json FROM node_runs WHERE id=${literal(spec.parentNodeRunId)}),(SELECT lineage_slot_path_json FROM task_launch_contexts WHERE task_id=${parent}))`
          : `(SELECT lineage_slot_path_json FROM task_launch_contexts WHERE task_id=${parent})`
        const key = spec.parentNodeRunId
          ? `coalesce((SELECT continuation_slot_key FROM node_runs WHERE id=${literal(spec.parentNodeRunId)}),${literal('legacy-call:' + spec.parentNodeRunId)})`
          : literal(spec.id)
        launchExpressions.lineage_slot_path_json = `json_insert(${parentPath},'$[#]',json_object('stableNodeKey','child-task','frozenOccurrenceKey',${key},'workflowRevision',${literal(spec.workflowVersion ?? null)}))`
      }
      for (const [key, column] of [
        ['rootTaskId', 'root_task_id'],
        ['executionLineageId', 'execution_lineage_id'],
        ['lineageSlotPathJson', 'lineage_slot_path_json'],
      ] as const)
        if (spec[key] !== undefined)
          (key === 'rootTaskId' ? taskExpressions : launchExpressions)[column] = literal(
            key === 'lineageSlotPathJson' ? json(spec[key]) : spec[key],
          )
      const root = insert('tasks', { ...encode('tasks', spec), ...values.task }, taskExpressions)
      return [
        'SAVEPOINT rfc395_task_fixture;',
        root,
        insert(
          'task_definitions',
          values.definition,
          subject.kind === 'workflow'
            ? {
                definition_origin: `CASE WHEN EXISTS(SELECT 1 FROM workflows WHERE id=${literal(spec.workflowId)} AND builtin=1) THEN ${literal(taskDefinitionOrigin(subject, true))} ELSE ${literal(taskDefinitionOrigin(subject, false))} END`,
              }
            : {},
        ),
        insert('task_launch_contexts', values.launchContext, launchExpressions),
        insert('task_workspaces', values.workspace),
        insert('task_execution_generations', values.generation),
        ...values.mounts.map((value) => insert('task_repository_mounts', value)),
        values.workgroupState ? insert('workgroup_task_state', values.workgroupState) : '',
        directories(
          spec.id,
          values.mounts.map((m) => m.mountPath ?? ''),
        ),
        'RELEASE rfc395_task_fixture;',
      ].join('\n')
    })
    .join('\n')
}
export function taskRepoFixtureSql(
  input: TaskRepoFixtureSpec | readonly TaskRepoFixtureSpec[],
): string {
  return rows(input)
    .map((spec) => {
      const value = mount(spec),
        id = literal(spec.taskId)
      const statement = insert('task_repository_mounts', value, {
        repo_key: `coalesce((SELECT repo_key FROM task_repository_mounts WHERE task_id=${id} AND ordinal=${spec.repoIndex}),${literal(value.repoKey)})`,
      })
      const updates = Object.keys(physical('task_repository_mounts', value))
        .filter((c) => !['task_id', 'repo_key'].includes(c))
        .map((c) => `${c}=excluded.${c}`)
        .join(',')
      return (
        statement.slice(0, -1) +
        ` ON CONFLICT(task_id,ordinal) DO UPDATE SET ${updates};\n` +
        directories(spec.taskId, [value.mountPath])
      )
    })
    .join('\n')
}
function runCompanions(spec: Partial<NodeRunFixtureSpec>, idsQuery: string): string {
  const values = encode('node_runs', spec)
  const config = { ...values } as Record<string, unknown>
  if (spec.promptText !== undefined || spec.promptPath !== undefined) {
    const content =
      typeof spec.promptText === 'string'
        ? inline(spec.promptText)
        : typeof spec.promptPath === 'string'
          ? (() => {
              const ref = contentRefColumns.encode(
                legacyContentRef('prompt', 'local-file', {
                  promptText: null,
                  promptPath: spec.promptPath,
                }),
              )
              return { contentRefJson: ref.json, contentInlineBytes: ref.inlineBytes }
            })()
          : { contentRefJson: null, contentInlineBytes: null }
    config.promptRefJson = content.contentRefJson
    config.promptInlineBytes = content.contentInlineBytes
  }
  const runtime = {
    ...values,
    ...(spec.opencodeSessionId !== undefined ? { sessionId: spec.opencodeSessionId } : {}),
    ...(spec.isoWorktreePath !== undefined ? { isolationRootRef: spec.isoWorktreePath } : {}),
  }
  const result = { ...values }
  const presence = nodeRunRowPresence({
    role: null,
    recordMode: 'executable',
    config,
    runtime,
    result,
  })
  return (
    [
      ['node_run_configs', config, presence.config],
      ['node_run_runtime_states', runtime, presence.runtimeState],
      ['node_run_results', result, presence.result],
    ] as const
  )
    .map(([table, data, present]) => {
      const fields = physical(table, data)
      if (!Object.keys(fields).length) return ''
      const assignments = Object.entries(fields)
        .map(([k, v]) => `${k}=${literal(v)}`)
        .join(',')
      if (!present) return `UPDATE ${table} SET ${assignments} WHERE node_run_id IN (${idsQuery});`
      return `INSERT INTO ${table}(node_run_id,${Object.keys(fields).join(',')}) SELECT id,${Object.values(fields).map(literal).join(',')} FROM node_runs WHERE id IN (${idsQuery}) ON CONFLICT(node_run_id) DO UPDATE SET ${assignments};`
    })
    .join('\n')
}
function checkpointSql(
  idsQuery: string,
  checkpoints: NonNullable<NodeRunFixtureSpec['checkpoints']>,
): string {
  if (!checkpoints.length)
    return `DELETE FROM node_run_repo_checkpoints WHERE node_run_id IN (${idsQuery});`
  return checkpoints
    .map(({ mountPath, ...fields }) => {
      const values = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          value === undefined ? null : key === 'submodules' ? JSON.stringify(value) : value,
        ]),
      )
      const physicalFields = physical('node_run_repo_checkpoints', values)
      if (!Object.keys(physicalFields).length) return ''
      return `INSERT INTO node_run_repo_checkpoints(node_run_id,task_id,repo_key,${Object.keys(physicalFields).join(',')}) SELECT r.id,r.task_id,(SELECT m.repo_key FROM task_repository_mounts m WHERE m.task_id=r.task_id AND m.mount_path=${literal(mountPath)}),${Object.values(physicalFields).map(literal).join(',')} FROM node_runs r WHERE r.id IN (${idsQuery}) ON CONFLICT(node_run_id,repo_key) DO UPDATE SET ${Object.entries(
        physicalFields,
      )
        .map(([key, value]) => `${key}=${literal(value)}`)
        .join(',')};`
    })
    .join('\n')
}
function inputSql(
  idsQuery: string,
  edges: NonNullable<NodeRunFixtureSpec['consumedEdges']>,
): string {
  const statements = edges.map((edge, ordinal) => {
    const producer = literal(edge.producerRunId)
    const match = `p.id=${producer} AND p.task_id=r.task_id AND p.node_id=${literal(edge.producerNodeId)}${edge.producerShardKey === undefined ? '' : ` AND p.shard_key IS ${literal(edge.producerShardKey)}`}`
    const slot =
      edge.producerShardKey === undefined
        ? `coalesce((SELECT CASE WHEN shard_key IS NULL THEN 'shard-v1:none' ELSE 'shard-v1:key:'||json_quote(shard_key) END FROM node_runs WHERE id=${producer}),'shard-v1:none')`
        : literal(producerShardSlot(edge.producerShardKey))
    const exists = `EXISTS(SELECT 1 FROM node_runs WHERE id=${producer})`
    return `INSERT INTO node_run_inputs(task_id,consumer_run_id,ordinal,producer_node_id,producer_run_id,producer_run_ref,input_kind,producer_shard_slot,provenance_quality,evidence_ref_json) SELECT r.task_id,r.id,${ordinal},${literal(edge.producerNodeId)},${producer},(SELECT p.id FROM node_runs p WHERE ${match}),'frame-input',${slot},CASE WHEN ${exists} THEN 'recorded' ELSE 'legacy-derived' END,CASE WHEN ${exists} THEN NULL ELSE ${literal(JSON.stringify({ fixture: 'missing historical producer', producerRunId: edge.producerRunId }))} END FROM node_runs r WHERE r.id IN (${idsQuery});`
  })
  return [
    `DELETE FROM node_run_inputs WHERE consumer_run_id IN (${idsQuery});`,
    ...statements,
    `UPDATE node_runs SET inputs_recorded=1 WHERE id IN (${idsQuery});`,
  ].join('\n')
}
function selectionSql(id: string): string {
  return `INSERT INTO node_run_selections(task_id,slot_key,selected_run_id,revision,generation_seq,cause,selected_at) SELECT task_id,slot_key,id,1,generation_seq,'fixture',coalesce(started_at,0) FROM node_runs WHERE id=${literal(id)} AND record_mode='executable' ON CONFLICT(task_id,slot_key) DO UPDATE SET selected_run_id=excluded.selected_run_id,revision=node_run_selections.revision+1,generation_seq=excluded.generation_seq,cause=excluded.cause,selected_at=excluded.selected_at WHERE node_run_selections.selected_run_id IS NULL OR CASE WHEN json_extract(excluded.slot_key,'$[4]')='repo-prep' AND (SELECT attempt_index FROM node_runs WHERE id=node_run_selections.selected_run_id) <> (SELECT attempt_index FROM node_runs WHERE id=excluded.selected_run_id) THEN (SELECT attempt_index FROM node_runs WHERE id=node_run_selections.selected_run_id) < (SELECT attempt_index FROM node_runs WHERE id=excluded.selected_run_id) ELSE (SELECT seq FROM node_runs WHERE id=node_run_selections.selected_run_id) <= (SELECT seq FROM node_runs WHERE id=excluded.selected_run_id) END;`
}
export function nodeRunFixtureSql(
  input: NodeRunFixtureSpec | readonly NodeRunFixtureSpec[],
): string {
  return rows(input)
    .map((spec) => {
      const batch = rows(input).filter((row) => row.taskId === spec.taskId)
      const identity = nodeRunFixtureIdentity(
        spec,
        batch.some((row) => row.containerRunId === spec.id),
        batch.some((row) => row.nodeId === spec.nodeId && row.rerunCause === 'fanout-shard'),
      )
      const lineage = nodeRunLineageColumns(
        {
          nodeId: spec.nodeId,
          iteration: spec.iteration ?? 0,
          shardKey: spec.shardKey ?? null,
          continuationSlotKey: spec.continuationSlotKey ?? null,
          lineageSlotPathJson: json(spec.lineageSlotPathJson),
        },
        { workflowVersion: null, lineageSlotPathJson: null },
      )
      const expressions: Record<string, string> = {
        generation_seq: `(SELECT max(generation_seq) FROM task_execution_generations WHERE task_id=${literal(spec.taskId)})`,
      }
      if (identity.role !== 'synthetic') {
        const container = `EXISTS(SELECT 1 FROM task_definitions d,json_each(d.workflow_snapshot,'$.nodes') n WHERE d.task_id=${literal(spec.taskId)} AND json_extract(n.value,'$.id')=${literal(spec.nodeId)} AND json_extract(n.value,'$.kind') LIKE 'wrapper-%') OR EXISTS(SELECT 1 FROM node_runs WHERE task_id=${literal(spec.taskId)} AND container_run_id=${literal(spec.id)})`
        const containerIdentity = nodeRunFixtureIdentity(spec, true)
        const shardIdentity = nodeRunFixtureIdentity(spec, false, true)
        const shard =
          spec.parentNodeRunId == null
            ? '0'
            : `EXISTS(SELECT 1 FROM node_runs WHERE task_id=${literal(spec.taskId)} AND node_id=${literal(spec.nodeId)} AND rerun_cause='fanout-shard')`
        expressions.role = `CASE WHEN ${container} THEN 'container' ELSE ${literal(identity.role)} END`
        expressions.slot_key = `CASE WHEN ${container} THEN ${literal(containerIdentity.slotKey)} WHEN ${shard} THEN ${literal(shardIdentity.slotKey)} ELSE ${literal(identity.slotKey)} END`
      }
      if (spec.scopePath === undefined && spec.containerRunId)
        expressions.scope_path = `(SELECT CASE WHEN coalesce(scope_path,'')='' THEN '' ELSE scope_path||'/' END||node_id||':'||${literal(spec.iteration ?? 0)} FROM node_runs WHERE id=${literal(spec.containerRunId)})`
      if (spec.seq === undefined)
        expressions.seq = `(SELECT seq FROM node_run_seq_allocations WHERE node_run_id=${literal(spec.id)})`
      if (spec.lineageSlotPathJson === undefined)
        expressions.lineage_slot_path_json = `json_insert((SELECT lineage_slot_path_json FROM task_launch_contexts WHERE task_id=${literal(spec.taskId)}),'$[#]',json_object('stableNodeKey',${literal(spec.nodeId)},'frozenOccurrenceKey',${literal(`${spec.iteration ?? 0}|${spec.shardKey ?? ''}`)},'workflowRevision',(SELECT source_revision FROM task_definitions WHERE task_id=${literal(spec.taskId)})))`
      const root = {
        ...encode('node_runs', spec),
        ...identity,
        ...lineage,
        scopePath: spec.scopePath ?? '',
        historicalParentId: spec.parentNodeRunId ?? null,
        attemptIndex: spec.retryIndex ?? 0,
        inputsRecorded: spec.consumedEdges !== undefined,
        recordMode: spec.envelopeNonce === null ? 'history-only' : 'executable',
        provenanceQuality: 'recorded',
        envelopeNonce: spec.envelopeNonce === undefined ? 'fixture:' + spec.id : spec.envelopeNonce,
      }

      return [
        'SAVEPOINT rfc395_run_fixture;',
        spec.seq === undefined
          ? `INSERT INTO node_run_seq_allocations(task_id,node_run_id,allocated_at) VALUES(${literal(spec.taskId)},${literal(spec.id)},${spec.startedAt ?? 0});`
          : '',
        insert('node_runs', root, expressions),
        runCompanions(spec, 'SELECT ' + literal(spec.id)),
        ...(spec.checkpoints
          ? [checkpointSql('SELECT ' + literal(spec.id), spec.checkpoints)]
          : []),
        spec.consumedEdges === undefined
          ? ''
          : inputSql('SELECT ' + literal(spec.id), spec.consumedEdges),
        selectionSql(spec.id),
        'RELEASE rfc395_run_fixture;',
      ].join('\n')
    })
    .join('\n')
}
export function workflowFixtureSql(
  input: WorkflowFixtureSpec | readonly WorkflowFixtureSpec[],
): string {
  return rows(input)
    .map((spec) =>
      [
        'SAVEPOINT rfc395_workflow_fixture;',
        insert('workflows', encode('workflows', spec)),
        ...workflowDependencyIndexEntries(json(spec.definition)!).map((entry) =>
          insert('workflow_dependency_index', {
            workflowId: spec.id,
            revision: spec.version ?? 1,
            ...entry,
          }),
        ),
        'RELEASE rfc395_workflow_fixture;',
      ].join('\n'),
    )
    .join('\n')
}
export function agentFixtureSql(input: AgentFixtureSpec | readonly AgentFixtureSpec[]): string {
  return rows(input)
    .map((spec) => {
      const parse = (value: unknown) => JSON.parse(json(value) ?? '[]') as unknown
      const refs = agentReferenceRows(spec.id, {
        skills: parse(spec.skills),
        dependsOn: parse(spec.dependsOn),
        mcp: parse(spec.mcp),
        plugins: parse(spec.plugins),
      } as AgentReferences)
      return [
        'SAVEPOINT rfc395_agent_fixture;',
        insert('agents', encode('agents', spec)),
        ...Object.entries(refs).flatMap(([kind, values]) =>
          values.map((row) =>
            insert(
              (
                {
                  skills: 'agent_skill_refs',
                  dependencies: 'agent_dependencies',
                  mcp: 'agent_mcp_refs',
                  plugins: 'agent_plugin_refs',
                } as Record<string, string>
              )[kind]!,
              row,
            ),
          ),
        ),
        'RELEASE rfc395_agent_fixture;',
      ].join('\n')
    })
    .join('\n')
}
export function clarifyRoundFixtureSql(
  input: ClarifyRoundFixtureSpec | readonly ClarifyRoundFixtureSpec[],
): string {
  return rows(input)
    .map((spec) => {
      const source = encode('clarify_rounds', spec),
        projection = decodeLegacyClarifyAnswerColumns(source)
      const root = {
        ...source,
        questionsRevision: 1,
        sealedQuestionSetKey:
          spec.status === 'answered'
            ? clarifyQuestionSetKey(JSON.parse(json(spec.questions)!) as ClarifyQuestion[])
            : null,
        answersRecorded: projection.answers !== null,
        draftsRecorded: projection.draftAnswers !== null,
        attributionsRecorded: projection.answerAttributions !== null,
        legacyAnswersJson: projection.answers === null ? json(spec.answers) : null,
      }
      const seen = new Map<string, number>()
      const answers = (projection.answers ?? []).map((answer, ordinal) => {
        const occurrence = seen.get(answer.questionId) ?? 0
        seen.set(answer.questionId, occurrence + 1)
        return insert('clarify_answers', {
          roundId: spec.id,
          questionId: answer.questionId,
          occurrence,
          ordinal,
          valueJson: JSON.stringify(answer),
          revision: 1,
          questionsRevision: 1,
          updatedAt: spec.answeredAt ?? spec.createdAt ?? 0,
        })
      })
      const maps = (
        [
          ['draftAnswers', 'clarify_answer_drafts'],
          ['answerAttributions', 'clarify_answer_attributions'],
        ] as const
      ).flatMap(([field, table]) => {
        const occurrences = new Map<string, number>()
        return projection[field] === null
          ? []
          : scanJsonObjectEntries(json(spec[field])!).map((entry) => {
              const occurrence = occurrences.get(entry.key) ?? 0
              occurrences.set(entry.key, occurrence + 1)
              return insert(table, {
                roundId: spec.id,
                questionId: entry.key,
                occurrence,
                ordinal: entry.ordinal,
                valueJson: entry.rawValue,
                revision: 1,
                questionsRevision: 1,
                updatedAt: spec.createdAt ?? 0,
              })
            })
      })
      return [
        'SAVEPOINT rfc395_clarify_fixture;',
        insert('clarify_rounds', root),
        ...answers,
        ...maps,
        'RELEASE rfc395_clarify_fixture;',
      ].join('\n')
    })
    .join('\n')
}
export const nodeRunOutputFixtureSql = (
  input: NodeRunOutputFixtureSpec | readonly NodeRunOutputFixtureSpec[],
): string =>
  rows(input)
    .map((spec) =>
      insert('node_run_outputs', { ...encode('node_run_outputs', spec), ...inline(spec.content) }),
    )
    .join('\n')
export const fixtureSqlParameter = Symbol('fixture-sql-parameter')

export function patchWorkgroupPauseReasonFixtureSql(taskId: string, reason: string | null): string {
  return `UPDATE workgroup_task_state SET pause_reason = ${literal(reason)} WHERE task_id = ${literal(taskId)};`
}
export function readWorkgroupPauseReasonFixtureSql(taskId: string): string {
  return `SELECT pause_reason FROM workgroup_task_state WHERE task_id = ${literal(taskId)};`
}
/** Corrupt the frozen launch document, independently of editable runtime state. */
export function corruptWorkgroupLaunchFixtureSql(taskId: string): string {
  return `UPDATE task_definitions SET workgroup_config_json = '{not json at all' WHERE task_id = ${literal(taskId)};`
}
export function readWorkgroupLaunchFixtureSql(taskId: string): string {
  return `SELECT workgroup_config_json AS workgroupConfigJson FROM task_definitions WHERE task_id = ${literal(taskId)};`
}
type SqlValue = string | number | boolean | null | typeof fixtureSqlParameter
type SqlWhere = Record<string, SqlValue | { $in?: readonly SqlValue[]; $ne?: SqlValue }>
function column(table: string, field: string): string {
  const entry = inventory.columns.find((e) => e.table === table && e.spec === field)
  if (!entry || ['repos', 'checkpoints', 'consumedEdges'].includes(field))
    throw new Error('Unsupported fixture SQL field: ' + field)
  if (table === 'node_runs' && field === 'parentNodeRunId') return 'historical_parent_id'
  if (table === 'node_runs' && field === 'retryIndex') return 'attempt_index'
  if (table === 'tasks' && field === 'worktreePath') return "coalesce(workspace_root_ref,'')"
  if (table === 'tasks' && field === 'workgroupConfigJson')
    return '(SELECT runtime_config_json FROM workgroup_task_state WHERE task_id=tasks.id)'
  if (table === 'tasks' && field === 'workflowId')
    return `(SELECT CASE subject_kind ${Object.entries(TASK_DEFINITION_HOSTS)
      .map(([kind, host]) => `WHEN ${literal(kind)} THEN ${literal(host.id)}`)
      .join(' ')} ELSE source_id END FROM task_definitions WHERE task_id=tasks.id)`
  if (
    table === 'tasks' &&
    ['workgroupId', 'codeRoundId', 'sourceAgentId', 'sourceAgentName'].includes(field)
  ) {
    const kind =
      field === 'workgroupId' ? 'workgroup' : field === 'codeRoundId' ? 'code-round' : 'agent'
    return `(SELECT ${field === 'sourceAgentName' ? 'source_name' : 'source_id'} FROM task_definitions WHERE task_id=tasks.id AND subject_kind=${literal(kind)})`
  }
  if (table === 'node_runs' && field === 'promptText')
    return '(SELECT CAST(prompt_inline_bytes AS TEXT) FROM node_run_configs WHERE node_run_id=node_runs.id)'
  if (table === 'node_runs' && field === 'promptPath')
    return "(SELECT json_extract(prompt_ref_json,'$.location.value.promptPath') FROM node_run_configs WHERE node_run_id=node_runs.id)"
  if (entry.target.startsWith(table + '.')) return entry.target.split('.')[1]!
  const [target, name] = entry.target.split('.')
  if (!name) throw new Error('Fixture SQL requires explicit aggregate projection: ' + field)
  return `(SELECT ${name} FROM ${target} WHERE ${table === 'tasks' ? 'task_id' : 'node_run_id'}=${table}.id${target === 'task_repository_mounts' ? ' AND ordinal=0' : ''})`
}
const parameter = (value: SqlValue) => (value === fixtureSqlParameter ? '?' : literal(value))
function predicate(table: string, where: SqlWhere): string {
  return (
    Object.entries(where)
      .map(([field, value]) => {
        const name = column(table, field)
        if (value === null) return `${name} IS NULL`
        if (typeof value === 'object') {
          if (value.$in) return `${name} IN (${value.$in.map(parameter).join(',')})`
          if ('$ne' in value)
            return value.$ne === null
              ? `${name} IS NOT NULL`
              : `${name} <> ${parameter(value.$ne!)}`
          throw new Error('Unsupported fixture SQL predicate')
        }
        return `${name}=${parameter(value)}`
      })
      .join(' AND ') || '1=1'
  )
}
function select(table: string, where: SqlWhere, fields: Readonly<Record<string, string>>): string {
  return `SELECT ${Object.entries(fields)
    .map(([alias, field]) => `${column(table, field)} AS "${alias}"`)
    .join(',')} FROM ${table} WHERE ${predicate(table, where)}`
}
export const readTaskFixturesSql = (
  where: SqlWhere,
  fields: Readonly<Record<string, keyof TaskFixtureSpec>>,
) => select('tasks', where, fields)
export const readNodeRunFixturesSql = (
  where: SqlWhere,
  fields: Readonly<Record<string, keyof NodeRunFixtureSpec>>,
) => select('node_runs', where, fields)
function patchAggregate(
  table: string,
  where: SqlWhere,
  patch: object,
  participants?: (idsQuery: string) => string,
): string {
  const groups = new Map<string, Record<string, unknown>>()
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const entry = inventory.columns.find((e) => e.table === table && e.spec === field)
    if (!entry) throw new Error('Unsupported fixture SQL patch: ' + field)
    const [target, name] = (
      table === 'tasks' && field === 'workgroupConfigJson'
        ? 'workgroup_task_state.runtime_config_json'
        : entry.target
    ).split('.')
    if (!name) throw new Error('Fixture SQL patch requires an aggregate codec: ' + field)
    const values = groups.get(target!) ?? {}
    values[name] = entry.json ? json(value) : value
    groups.set(target!, values)
  }
  // Capture the selected IDs once so changing a predicate column cannot change subsequent participants.
  const temporary = 'rfc395_patch_' + randomUUID().replaceAll('-', '')
  const statements = [...groups].map(([target, values]) => {
    const assignments = Object.entries(values)
      .map(([key, value]) => `${key}=${literal(value)}`)
      .join(',')
    const key = target === table ? 'id' : table === 'tasks' ? 'task_id' : 'node_run_id'
    if (
      [
        'node_run_configs',
        'node_run_runtime_states',
        'node_run_results',
        'workgroup_task_state',
      ].includes(target) &&
      Object.values(values).some((value) => value !== null)
    ) {
      const extra = target === 'workgroup_task_state' ? { updated_at: 0 } : {}
      const all = { ...values, ...extra }
      return `INSERT INTO ${target}(${key},${Object.keys(all).join(',')}) SELECT id,${Object.values(all).map(literal).join(',')} FROM ${temporary} WHERE 1=1 ON CONFLICT(${key}) DO UPDATE SET ${assignments};`
    }
    return `UPDATE ${target} SET ${assignments} WHERE ${key} IN (SELECT id FROM ${temporary})${target === 'task_repository_mounts' ? ' AND ordinal=0' : ''};`
  })
  return [
    `SAVEPOINT rfc395_patch; CREATE TEMP TABLE ${temporary}(id TEXT PRIMARY KEY); INSERT INTO ${temporary} SELECT id FROM ${table} WHERE ${predicate(table, where)};`,
    ...statements,
    participants?.('SELECT id FROM ' + temporary) ?? '',
    `DROP TABLE ${temporary}; RELEASE rfc395_patch;`,
  ].join('\n')
}
export const patchTaskFixtureSql = (where: SqlWhere, patch: Partial<TaskFixtureSpec>): string =>
  patchAggregate('tasks', where, patch)
export function patchNodeRunFixtureSql(
  where: SqlWhere,
  patch: Partial<NodeRunFixtureSpec>,
): string {
  const { checkpoints, consumedEdges, promptText, promptPath, ...remaining } = patch
  return patchAggregate('node_runs', where, remaining, (idsQuery) =>
    [
      runCompanions({ promptText, promptPath }, idsQuery),
      checkpoints === undefined ? '' : checkpointSql(idsQuery, checkpoints),
      consumedEdges === undefined ? '' : inputSql(idsQuery, consumedEdges),
    ].join('\n'),
  )
}
export const deleteNodeRunFixturesSql = (where: SqlWhere): string =>
  `DELETE FROM node_runs WHERE ${predicate('node_runs', where)};`
export function readNodeRunCheckpointFixturesSql(
  where: SqlWhere,
  mountPath: string,
  field: 'preSnapshot' | 'isolationBase' | 'nodeTree' | 'submodules',
): string {
  const name = inventory.targetColumns.node_run_repo_checkpoints![field]!
  return `SELECT id,(SELECT c.${name} FROM node_run_repo_checkpoints c JOIN task_repository_mounts m ON c.task_id=m.task_id AND c.repo_key=m.repo_key WHERE c.node_run_id=node_runs.id AND m.mount_path=${literal(mountPath)}) AS "${field}" FROM node_runs WHERE ${predicate('node_runs', where)}`
}

/** Review diagnosis fixtures persist the same document decision using epoch-2 content columns. */
export function docVersionFixtureSql(spec: {
  id: string
  taskId: string
  reviewNodeId: string
  reviewNodeRunId: string
  sourceNodeId: string
  sourcePortName: string
  bodyPath: string
  decision: 'pending' | 'approved' | 'rejected' | 'iterated' | 'superseded'
  createdAt: number
  decidedAt: number | null
  decidedBy: string | null
}): string {
  const content = contentRefColumns.encode(
    legacyContentRef('review-body', 'local-file', spec.bodyPath),
  )
  const columns = {
    id: spec.id,
    task_id: spec.taskId,
    review_node_id: spec.reviewNodeId,
    review_node_run_id: spec.reviewNodeRunId,
    source_node_id: spec.sourceNodeId,
    source_port_name: spec.sourcePortName,
    version_index: 1,
    review_iteration: 0,
    content_ref_json: content.json,
    content_inline_bytes: content.inlineBytes,
    comments_json: '[]',
    decision: spec.decision,
    decision_reason: null,
    prompt_snapshot: null,
    source_file_path: null,
    created_at: spec.createdAt,
    decided_at: spec.decidedAt,
    decided_by: spec.decidedBy,
  }
  return `INSERT INTO doc_versions (${Object.keys(columns).join(',')}) VALUES (${Object.values(columns).map(literal).join(',')});`
}

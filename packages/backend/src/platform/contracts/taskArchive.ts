import type { DispositionArchive } from '@/platform/persistence/schema/history/dispositionArchive'
// RFC-395: owner sections and versioned task archive I/O.
import type { PersistenceTables } from '@/platform/persistence/schema/tables'

/** New archives use epoch-2 owner sections; v2 stays a historical read format. */
export const TASK_ARCHIVE_SCHEMA_VERSION = 3 as const
export const TASK_ARCHIVE_V2_SCHEMA_VERSION = 2 as const

/** Section/table order is part of the v3 manifest contract. Each array is present,
 * even when empty. Existing archive families remain represented after the split.
 */
export const TASK_ARCHIVE_V3_TABLES = {
  task: {
    tasks: 'tasks',
    task_definitions: 'taskDefinitions',
    task_launch_contexts: 'taskLaunchContexts',
    task_workspaces: 'taskWorkspaces',
    task_repository_mounts: 'taskRepositoryMounts',
    task_space_nodes: 'taskSpaceNodes',
    task_execution_generations: 'taskExecutionGenerations',
    lifecycle_alerts: 'lifecycleAlerts',
    recovery_events: 'recoveryEvents',
    workgroup_task_state: 'workgroupTaskState',
    workgroup_assignments: 'workgroupAssignments',
    workgroup_messages: 'workgroupMessages',
    workgroup_member_cursors: 'workgroupMemberCursors',
    task_execution_owners: 'taskExecutionOwners',
    task_execution_intents: 'taskExecutionIntents',
    task_execution_effects: 'taskExecutionEffects',
    task_execution_effect_attempts: 'taskExecutionEffectAttempts',
    task_execution_effect_fences: 'taskExecutionEffectFences',
    task_execution_lineage_operation_records: 'taskExecutionLineageOperationRecords',
    hosted_task_artifacts: 'hostedTaskArtifacts',
    hosted_execution_bindings: 'hostedExecutionBindings',
    hosted_execution_events: 'hostedExecutionEvents',
  },
  nodeRuns: {
    node_runs: 'nodeRuns',
    node_run_configs: 'nodeRunConfigs',
    node_run_runtime_states: 'nodeRunRuntimeStates',
    node_run_results: 'nodeRunResults',
    node_run_inputs: 'nodeRunInputs',
    node_run_selections: 'nodeRunSelections',
    node_run_repo_checkpoints: 'nodeRunRepoCheckpoints',
    node_run_outputs: 'nodeRunOutputs',
    node_run_events: 'nodeRunEvents',
    node_run_seq_allocations: 'nodeRunSeqAllocations',
    // N exports evidence for the entire task tree, including record_kind='task'.
    execution_legacy_evidence: 'executionLegacyEvidence',
    node_execution_event_sources: 'nodeExecutionEventSources',
  },
  collaboration: {
    task_collaborators: 'taskCollaborators',
    review_node_reviewers: 'reviewNodeReviewers',
    task_questions: 'taskQuestions',
    task_feedback: 'taskFeedback',
    task_node_clarify_directives: 'taskNodeClarifyDirectives',
    clarify_rounds: 'clarifyRounds',
    clarify_answers: 'clarifyAnswers',
    clarify_answer_drafts: 'clarifyAnswerDrafts',
    clarify_answer_attributions: 'clarifyAnswerAttributions',
    collaboration_gate_operations: 'collaborationGateOperations',
    collaboration_gate_artifacts: 'collaborationGateArtifacts',
    doc_versions: 'docVersions',
    review_comments: 'reviewComments',
  },
} as const satisfies Readonly<
  Record<'task' | 'nodeRuns' | 'collaboration', Readonly<Record<string, keyof PersistenceTables>>>
>

export type TaskArchiveSectionName = keyof typeof TASK_ARCHIVE_V3_TABLES
type SectionRows<T extends Readonly<Record<string, keyof PersistenceTables>>> = {
  readonly [Name in keyof T]: readonly Readonly<PersistenceTables[T[Name]]['$inferSelect']>[]
}
export interface TaskArchiveTaskSection {
  readonly owner: 'T'
  readonly rows: SectionRows<typeof TASK_ARCHIVE_V3_TABLES.task>
}
export interface TaskArchiveNodeRunSection {
  readonly owner: 'N'
  readonly rows: SectionRows<typeof TASK_ARCHIVE_V3_TABLES.nodeRuns>
}
export interface TaskArchiveCollaborationSection {
  readonly owner: 'C'
  readonly dispositionEvidence?: readonly DispositionArchive[]
  readonly rows: SectionRows<typeof TASK_ARCHIVE_V3_TABLES.collaboration>
}
export interface TaskArchiveV3Sections {
  readonly task: TaskArchiveTaskSection
  readonly nodeRuns: TaskArchiveNodeRunSection
  readonly collaboration: TaskArchiveCollaborationSection
}

/** Q's wire encoding preserves bytes and large integers; JSON-text columns stay
 * strings and are not parsed/reserialized. Native section readers return the rows
 * above, with Uint8Array values. Q encodes them once when writing JSONL.
 */
export type TaskArchiveWireValue<T> = T extends Uint8Array
  ? { readonly codec: 'bytes@1'; readonly base64: string }
  : T extends bigint
    ? { readonly codec: 'bigint@1'; readonly decimal: string }
    : T extends readonly (infer Item)[]
      ? readonly TaskArchiveWireValue<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: TaskArchiveWireValue<T[Key]> }
        : T
export type TaskArchiveV3WireSections = TaskArchiveWireValue<TaskArchiveV3Sections>

/** Union of historical v2 rosters, not a required set: writers added tables
 * without bumping v2. Each manifest records its own digest-covered roster. */
export const TASK_ARCHIVE_V2_TABLES = [
  'tasks',
  'task_repos',
  'task_space_nodes',
  'task_collaborators',
  'review_node_reviewers',
  'task_questions',
  'task_feedback',
  'task_node_clarify_directives',
  'clarify_rounds',
  'collaboration_gate_operations',
  'collaboration_gate_artifacts',
  'doc_versions',
  'review_comments',
  'lifecycle_alerts',
  'recovery_events',
  'workgroup_task_state',
  'workgroup_assignments',
  'workgroup_messages',
  'workgroup_member_cursors',
  'node_runs',
  'node_run_outputs',
  'node_run_events',
  'task_execution_owners',
  'task_execution_intents',
  'task_execution_effects',
  'task_execution_effect_attempts',
  'task_execution_effect_fences',
  'task_execution_lineage_operation_records',
  'hosted_task_artifacts',
  'hosted_execution_bindings',
  'hosted_execution_events',
  'node_execution_event_sources',
] as const
export type TaskArchiveV2Table = (typeof TASK_ARCHIVE_V2_TABLES)[number]
export type TaskArchiveLegacyValue =
  | null
  | boolean
  | number
  | string
  | readonly TaskArchiveLegacyValue[]
  | { readonly [key: string]: TaskArchiveLegacyValue }
export type TaskArchiveLegacyRow = Readonly<Record<string, TaskArchiveLegacyValue>>
export interface TaskArchiveV2Manifest {
  readonly schemaVersion: typeof TASK_ARCHIVE_V2_SCHEMA_VERSION
  readonly rootTaskId: string
  readonly taskIds: readonly string[]
  readonly exportedAt: string
  /** Directory counts are digest-covered metadata, not JSONL table names. */
  readonly rows: Readonly<Partial<Record<TaskArchiveV2Table | 'runs_dirs' | 'logs_dirs', number>>>
  readonly terminalMaintenance: {
    readonly claim: TaskArchiveLegacyRow
    readonly members: readonly TaskArchiveLegacyRow[]
  }
  readonly digest: string
}
export interface TaskArchiveV2Source {
  readManifest(): Promise<Uint8Array>
  readTable(table: TaskArchiveV2Table): AsyncIterable<Uint8Array>
}
export interface TaskArchiveV2ReadView {
  readonly manifest: TaskArchiveV2Manifest
  /** Historical JSON fields retain their original shape. Unlisted tables yield no rows. */
  rows(table: TaskArchiveV2Table): AsyncIterable<TaskArchiveLegacyRow>
}
export interface TaskArchiveV2Reader {
  /** Q verifies the v2 manifest/digest and row counts without rewriting original bytes.
   * A v2 read is history-only; it never inserts old rows into target tables or mints
   * executable identities. Use the supported migration path for an actual restore.
   */
  read(source: TaskArchiveV2Source): Promise<TaskArchiveV2ReadView>
}

export interface TaskArchiveV3Manifest {
  readonly schemaVersion: typeof TASK_ARCHIVE_SCHEMA_VERSION
  readonly rootTaskId: string
  readonly taskIds: readonly string[]
  readonly exportedAt: string
  readonly sections: Readonly<
    Record<
      TaskArchiveSectionName,
      { readonly owner: 'T' | 'N' | 'C'; readonly tables: readonly string[] }
    >
  >
  readonly rows: Readonly<Record<string, number>>
  readonly tableDigests: Readonly<Record<string, string>>
  readonly terminalMaintenance: {
    readonly claim: TaskArchiveLegacyRow
    readonly members: readonly TaskArchiveLegacyRow[]
  }
  readonly digest: string
}
export interface TaskArchiveSource {
  readManifest(): Promise<Uint8Array>
  /** Absent files for empty v2 tables yield no chunks. */
  readTable(table: string): AsyncIterable<Uint8Array>
}
export interface TaskArchiveReadView {
  readonly manifest: TaskArchiveV2Manifest | TaskArchiveV3Manifest
  rows(table: string): AsyncIterable<Readonly<Record<string, unknown>>>
}

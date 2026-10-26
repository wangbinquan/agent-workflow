// RFC-395 activation: this context declares the live epoch-2 schema directly.
import {
  column as c,
  defineContribution,
  retention,
  raw,
  foreignKey,
  index,
} from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'

const owner = defineContribution('memory')

const memoryDistillEventsDefinition = owner.table({
  id: 'memory_distill_events',
  schemaSymbol: 'memoryDistillEvents',
  columns: {
    id: c.identity('id', { primary: true }),
    distillJobId: c.id('distill_job_id'),
    attemptIndex: c.int('attempt_index'),
    sessionId: c.id('session_id'),
    parentSessionId: c.id('parent_session_id', { nullable: true }),
    ts: c.int('ts'),
    kind: c.text('kind'),
    payload: c.text('payload'),
  },
  foreignKeys: [
    foreignKey(
      'memory_distill_events_distill_job_id_memory_distill_jobs_id_fk',
      ['distill_job_id'],
      'memory_distill_jobs',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  indexes: [
    index('idx_distill_events_job_attempt', ['distill_job_id', 'attempt_index', 'ts']),
    index('idx_distill_events_session', ['distill_job_id', 'session_id', 'ts']),
  ],
  retention: retention.operational,
})

export const memoryDistillEvents = materializeDrizzle(memoryDistillEventsDefinition).table

const memoryDistillJobsDefinition = owner.table({
  id: 'memory_distill_jobs',
  schemaSymbol: 'memoryDistillJobs',
  columns: {
    id: c.id('id', { primary: true }),
    debounceKey: c.id('debounce_key'),
    sourceKind: c.enum('source_kind', ['clarify', 'review', 'feedback', 'agent-run', 'task-run']),
    sourceEventId: c.id('source_event_id'),
    taskId: c.id('task_id', { nullable: true }),
    scopeResolvedJson: c.jsonText('scope_resolved_json'),
    status: c.enum('status', ['pending', 'running', 'done', 'failed', 'canceled']),
    attempts: c.int('attempts', { default: 0 }),
    nextRunAt: c.epochMs('next_run_at'),
    lastError: c.text('last_error', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    startedAt: c.epochMs('started_at', { nullable: true }),
    finishedAt: c.epochMs('finished_at', { nullable: true }),
    opencodeSessionId: c.id('opencode_session_id', { nullable: true }),
    userPromptMd: c.text('user_prompt_md', { nullable: true }),
    exitCode: c.int('exit_code', { nullable: true }),
    stderrExcerpt: c.text('stderr_excerpt', { nullable: true }),
    dedupSnapshotIdsJson: c.jsonText('dedup_snapshot_ids_json', { nullable: true }),
    outputLang: c.text('output_lang', { nullable: true }),
  },
  checks: [
    {
      name: 'memory_distill_jobs_source_kind_enum',
      expression: raw(
        "\"memory_distill_jobs\".\"source_kind\" IN ('clarify','review','feedback','agent-run','task-run')",
        "\"source_kind\" IN ('clarify','review','feedback','agent-run','task-run')",
      ),
    },
    {
      name: 'memory_distill_jobs_status_enum',
      expression: raw(
        "\"memory_distill_jobs\".\"status\" IN ('pending','running','done','failed','canceled')",
        "\"status\" IN ('pending','running','done','failed','canceled')",
      ),
    },
  ],
  indexes: [
    index('idx_distill_jobs_status_next', ['status', 'next_run_at']),
    index('idx_distill_jobs_debounce', ['debounce_key', 'status']),
    index('idx_distill_jobs_task', ['task_id', 'source_kind']),
  ],
  retention: retention.business,
})

export const memoryDistillJobs = materializeDrizzle(memoryDistillJobsDefinition).table

const memoryScopeMoveEventsDefinition = owner.table({
  id: 'memory_scope_move_events',
  schemaSymbol: 'memoryScopeMoveEvents',
  columns: {
    id: c.id('id', { primary: true }),
    memoryId: c.id('memory_id'),
    actorUserId: c.id('actor_user_id'),
    actorSource: c.enum('actor_source', ['session', 'pat', 'daemon', 'cli', 'system']),
    fromScopeType: c.enum('from_scope_type', ['agent', 'workflow', 'repo', 'repo_group', 'global']),
    fromScopeId: c.id('from_scope_id', { nullable: true }),
    toScopeType: c.enum('to_scope_type', ['agent', 'workflow', 'repo', 'repo_group', 'global']),
    toScopeId: c.id('to_scope_id', { nullable: true }),
    expectedVersion: c.int('expected_version'),
    resultingVersion: c.int('resulting_version'),
    correlationId: c.id('correlation_id'),
    causationId: c.id('causation_id', { nullable: true }),
    occurredAt: c.epochMs('occurred_at'),
  },
  checks: [
    {
      name: 'memory_scope_move_events_actor_source',
      expression: raw(
        "\"memory_scope_move_events\".\"actor_source\" IN ('session','pat','daemon','cli','system')",
        "\"actor_source\" IN ('session','pat','daemon','cli','system')",
      ),
    },
    {
      name: 'memory_scope_move_events_from_scope',
      expression: raw(
        '("memory_scope_move_events"."from_scope_type" = \'global\' AND "memory_scope_move_events"."from_scope_id" IS NULL) OR ("memory_scope_move_events"."from_scope_type" IN (\'agent\',\'workflow\',\'repo\',\'repo_group\') AND "memory_scope_move_events"."from_scope_id" IS NOT NULL AND length("memory_scope_move_events"."from_scope_id") > 0)',
        '("from_scope_type" = \'global\' AND "from_scope_id" IS NULL) OR ("from_scope_type" IN (\'agent\',\'workflow\',\'repo\',\'repo_group\') AND "from_scope_id" IS NOT NULL AND length("from_scope_id") > 0)',
      ),
    },
    {
      name: 'memory_scope_move_events_to_scope',
      expression: raw(
        '("memory_scope_move_events"."to_scope_type" = \'global\' AND "memory_scope_move_events"."to_scope_id" IS NULL) OR ("memory_scope_move_events"."to_scope_type" IN (\'agent\',\'workflow\',\'repo\',\'repo_group\') AND "memory_scope_move_events"."to_scope_id" IS NOT NULL AND length("memory_scope_move_events"."to_scope_id") > 0)',
        '("to_scope_type" = \'global\' AND "to_scope_id" IS NULL) OR ("to_scope_type" IN (\'agent\',\'workflow\',\'repo\',\'repo_group\') AND "to_scope_id" IS NOT NULL AND length("to_scope_id") > 0)',
      ),
    },
    {
      name: 'memory_scope_move_events_not_noop',
      expression: raw(
        '"memory_scope_move_events"."from_scope_type" <> "memory_scope_move_events"."to_scope_type" OR "memory_scope_move_events"."from_scope_id" IS NOT "memory_scope_move_events"."to_scope_id"',
        '"from_scope_type" <> "to_scope_type" OR "from_scope_id" IS DISTINCT FROM "to_scope_id"',
      ),
    },
    {
      name: 'memory_scope_move_events_version_step',
      expression: raw(
        '"memory_scope_move_events"."expected_version" > 0 AND "memory_scope_move_events"."resulting_version" = "memory_scope_move_events"."expected_version" + 1',
        '"expected_version" > 0 AND "resulting_version" = "expected_version" + 1',
      ),
    },
    {
      name: 'memory_scope_move_events_time_nonnegative',
      expression: raw('"memory_scope_move_events"."occurred_at" >= 0', '"occurred_at" >= 0'),
    },
  ],
  indexes: [
    index('idx_memory_scope_move_events_memory_version', ['memory_id', 'resulting_version'], {
      unique: true,
    }),
    index('idx_memory_scope_move_events_occurred', ['occurred_at', 'memory_id']),
  ],
  retention: retention.operational,
})

export const memoryScopeMoveEvents = materializeDrizzle(memoryScopeMoveEventsDefinition).table

const memoriesDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [
    {
      name: 'memories_supersedes_fk',
      columns: ['supersedes_id'],
      foreignTable: 'memories',
      foreignColumns: ['id'],
      onDelete: 'set null',
      onUpdate: 'no action',
      lifecycle:
        'Deleting a memory clears historical supersession pointers, retaining the referring memory.',
    },
    {
      name: 'memories_superseded_by_fk',
      columns: ['superseded_by_id'],
      foreignTable: 'memories',
      foreignColumns: ['id'],
      onDelete: 'set null',
      onUpdate: 'no action',
      lifecycle:
        'Deleting a memory clears historical supersession pointers, retaining the referring memory.',
    },
  ],
  checks: [
    {
      name: 'memories_scope_type_enum',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: "\"memories\".\"scope_type\" IN ('agent','workflow','repo','repo_group','global')",
        postgresql: "\"scope_type\" IN ('agent','workflow','repo','repo_group','global')",
      },
    },
    {
      name: 'memories_status_enum',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          "\"memories\".\"status\" IN ('candidate','approved','archived','superseded','rejected','fused')",
        postgresql:
          "\"status\" IN ('candidate','approved','archived','superseded','rejected','fused')",
      },
    },
    {
      name: 'memories_source_kind_enum',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          "\"memories\".\"source_kind\" IN ('clarify','review','feedback','agent-run','task-run','manual')",
        postgresql:
          "\"source_kind\" IN ('clarify','review','feedback','agent-run','task-run','manual')",
      },
    },
    {
      name: 'memories_distill_action_enum',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"memories"."distill_action" IS NULL OR "memories"."distill_action" IN (\'new\',\'update_of\',\'duplicate_of\',\'conflict_with\')',
        postgresql:
          "\"distill_action\" IS NULL OR \"distill_action\" IN ('new','update_of','duplicate_of','conflict_with')",
      },
    },
    {
      name: 'memories_scope_type_shape',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '("memories"."scope_type" = \'global\' AND "memories"."scope_id" IS NULL) OR ("memories"."scope_type" != \'global\' AND "memories"."scope_id" IS NOT NULL)',
        postgresql:
          '("scope_type" = \'global\' AND "scope_id" IS NULL) OR ("scope_type" != \'global\' AND "scope_id" IS NOT NULL)',
      },
    },
    {
      name: 'memories_fused_into_skill_shape',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '("memories"."status" = \'fused\') = ("memories"."fused_into_skill" IS NOT NULL)',
        postgresql: '("status" = \'fused\') = ("fused_into_skill" IS NOT NULL)',
      },
    },
    {
      name: 'memories_fused_into_skill_id_shape',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '("memories"."status" = \'fused\') = ("memories"."fused_into_skill_id" IS NOT NULL)',
        postgresql: '("status" = \'fused\') = ("fused_into_skill_id" IS NOT NULL)',
      },
    },
  ],
  indexes: [
    {
      name: 'idx_memories_scope_status',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'scope_type' },
        { kind: 'column', name: 'scope_id' },
        { kind: 'column', name: 'status' },
      ],
      where: null,
    },
    {
      name: 'idx_memories_status_created',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'status' },
        { kind: 'column', name: 'created_at' },
      ],
      where: null,
    },
    {
      name: 'idx_memories_supersedes',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'supersedes_id' }],
      where: null,
    },
    {
      name: 'idx_memories_created',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'created_at' }],
      where: null,
    },
    {
      name: 'idx_memories_source',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'source_kind' },
        { kind: 'column', name: 'source_event_id' },
      ],
      where: null,
    },
    {
      name: 'idx_memories_fused_skill_id',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'fused_into_skill_id' },
        { kind: 'column', name: 'fused_into_skill_version' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'memories',
  schemaSymbol: 'memories',
  columns: {
    id: c.id('id', { primary: true }),
    scopeType: c.enum('scope_type', ['agent', 'workflow', 'repo', 'repo_group', 'global']),
    scopeId: c.id('scope_id', { nullable: true }),
    title: c.text('title'),
    bodyMd: c.text('body_md'),
    tags: c.text('tags', { default: '[]' }),
    status: c.enum('status', [
      'candidate',
      'approved',
      'archived',
      'superseded',
      'rejected',
      'fused',
    ]),
    sourceKind: c.enum('source_kind', [
      'clarify',
      'review',
      'feedback',
      'agent-run',
      'task-run',
      'manual',
    ]),
    sourceEventId: c.id('source_event_id', { nullable: true }),
    sourceTaskId: c.id('source_task_id', { nullable: true }),
    distillJobId: c.id('distill_job_id', { nullable: true }),
    distillAction: c.enum('distill_action', ['new', 'update_of', 'duplicate_of', 'conflict_with'], {
      nullable: true,
    }),
    supersedesId: c.id('supersedes_id', { nullable: true }),
    supersededById: c.id('superseded_by_id', { nullable: true }),
    approvedByUserId: c.id('approved_by_user_id', { nullable: true }),
    approvedAt: c.epochMs('approved_at', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    version: c.int('version', { default: 1 }),
    fusedIntoSkill: c.text('fused_into_skill', { nullable: true }),
    fusedIntoSkillId: c.id('fused_into_skill_id', { nullable: true }),
    fusedIntoSkillVersion: c.int('fused_into_skill_version', { nullable: true }),
    fusedAt: c.epochMs('fused_at', { nullable: true }),
    fusedByUserId: c.id('fused_by_user_id', { nullable: true }),
    fusedFusionId: c.id('fused_fusion_id', { nullable: true }),
  },
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const memories = materializeDrizzle(memoriesDefinition).table

export const schemaContribution = {
  owner: 'memory',
  version: 2,
  tables: [
    memoryDistillEventsDefinition,
    memoryDistillJobsDefinition,
    memoryScopeMoveEventsDefinition,
    memoriesDefinition,
  ],
} as const

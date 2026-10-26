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

const owner = defineContribution('collaboration')

const reviewNodeReviewersDefinition = owner.table({
  id: 'review_node_reviewers',
  schemaSymbol: 'reviewNodeReviewers',
  columns: {
    taskId: c.id('task_id'),
    reviewNodeId: c.id('review_node_id'),
    reviewerUserId: c.id('reviewer_user_id'),
    assignedByUserId: c.id('assigned_by_user_id'),
    assignedAt: c.epochMs('assigned_at'),
  },
  primaryKey: ['task_id', 'review_node_id', 'reviewer_user_id'],
  foreignKeys: [
    foreignKey('review_node_reviewers_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
    foreignKey(
      'review_node_reviewers_reviewer_user_id_users_id_fk',
      ['reviewer_user_id'],
      'users',
      ['id'],
      { onDelete: 'restrict' },
    ),
    foreignKey(
      'review_node_reviewers_assigned_by_user_id_users_id_fk',
      ['assigned_by_user_id'],
      'users',
      ['id'],
      { onDelete: 'restrict' },
    ),
  ],
  indexes: [
    index('idx_review_node_reviewers_actor', ['reviewer_user_id', 'task_id', 'review_node_id']),
    index('idx_review_node_reviewers_node', ['task_id', 'review_node_id']),
  ],
  retention: retention.business,
})

export const reviewNodeReviewers = materializeDrizzle(reviewNodeReviewersDefinition).table

const taskFeedbackDefinition = owner.table({
  id: 'task_feedback',
  schemaSymbol: 'taskFeedback',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    authorUserId: c.id('author_user_id', { nullable: true }),
    bodyMd: c.text('body_md'),
    createdAt: c.epochMs('created_at'),
    distilled: c.int('distilled', { default: 0 }),
    distillJobId: c.id('distill_job_id', { nullable: true }),
  },
  indexes: [index('idx_task_feedback_task', ['task_id', 'created_at'])],
  retention: retention.business,
})

export const taskFeedback = materializeDrizzle(taskFeedbackDefinition).table

const taskQuestionsDefinition = owner.table({
  id: 'task_questions',
  schemaSymbol: 'taskQuestions',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    originNodeRunId: c.id('origin_node_run_id'),
    questionId: c.id('question_id'),
    questionTitle: c.text('question_title'),
    sourceKind: c.enum('source_kind', ['self', 'cross', 'manual']),
    roleKind: c.enum('role_kind', ['self', 'questioner', 'designer']),
    iteration: c.int('iteration', { default: 0 }),
    loopIter: c.int('loop_iter', { default: 0 }),
    defaultTargetNodeId: c.id('default_target_node_id', { nullable: true }),
    overrideTargetNodeId: c.id('override_target_node_id', { nullable: true }),
    dispatchedAt: c.epochMs('dispatched_at', { nullable: true }),
    dispatchedBy: c.text('dispatched_by', { nullable: true }),
    triggerRunId: c.id('trigger_run_id', { nullable: true }),
    stagedAt: c.epochMs('staged_at', { nullable: true }),
    stagedBy: c.text('staged_by', { nullable: true }),
    autoDispatchDeferredAt: c.epochMs('auto_dispatch_deferred_at', { nullable: true }),
    sealedAt: c.epochMs('sealed_at', { nullable: true }),
    sealedBy: c.text('sealed_by', { nullable: true }),
    confirmation: c.enum('confirmation', ['open', 'confirmed'], { default: 'open' }),
    confirmedBy: c.text('confirmed_by', { nullable: true }),
    confirmedByRole: c.text('confirmed_by_role', { nullable: true }),
    confirmedAt: c.epochMs('confirmed_at', { nullable: true }),
    lastReassignedBy: c.text('last_reassigned_by', { nullable: true }),
    lastReassignedAt: c.epochMs('last_reassigned_at', { nullable: true }),
    manualBody: c.text('manual_body', { nullable: true }),
    manualCreatedBy: c.text('manual_created_by', { nullable: true }),
    createdAt: c.epochMs('created_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
    updatedAt: c.epochMs('updated_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
  },
  foreignKeys: [
    foreignKey('task_questions_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  indexes: [
    index('idx_task_questions_task', ['task_id']),
    index('idx_task_questions_origin', ['origin_node_run_id']),
    index('uniq_task_questions_identity', ['origin_node_run_id', 'question_id', 'role_kind'], {
      unique: true,
    }),
  ],
  retention: retention.business,
})

export const taskQuestions = materializeDrizzle(taskQuestionsDefinition).table

const clarifyRoundsDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [
    {
      name: 'clarify_rounds_task_id_tasks_id_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
    {
      name: 'clarify_rounds_asking_node_run_id_node_runs_id_fk',
      columns: ['asking_node_run_id'],
      foreignTable: 'node_runs',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
    {
      name: 'clarify_rounds_intermediary_node_run_id_node_runs_id_fk',
      columns: ['intermediary_node_run_id'],
      foreignTable: 'node_runs',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
  ],
  checks: [
    {
      name: 'clarify_rounds_kind_enum',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"clarify_rounds"."kind" IN (\'self\', \'cross\')',
        postgresql: "\"kind\" IN ('self', 'cross')",
      },
    },
    {
      name: 'clarify_rounds_directive_enum',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"clarify_rounds"."directive" IS NULL OR "clarify_rounds"."directive" IN (\'continue\', \'stop\')',
        postgresql: '"directive" IS NULL OR "directive" IN (\'continue\', \'stop\')',
      },
    },
    {
      name: 'clarify_rounds_status_enum',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          "\"clarify_rounds\".\"status\" IN ('awaiting_human', 'answered', 'canceled', 'abandoned')",
        postgresql: "\"status\" IN ('awaiting_human', 'answered', 'canceled', 'abandoned')",
      },
    },
    {
      name: 'clarify_rounds_kind_shape',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '("clarify_rounds"."kind" = \'self\' AND "clarify_rounds"."status" != \'abandoned\') OR ("clarify_rounds"."kind" = \'cross\' AND "clarify_rounds"."status" != \'canceled\')',
        postgresql:
          '("kind" = \'self\' AND "status" != \'abandoned\') OR ("kind" = \'cross\' AND "status" != \'canceled\')',
      },
    },
  ],
  indexes: [
    {
      name: 'idx_clarify_rounds_task',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'task_id' }],
      where: null,
    },
    {
      name: 'idx_clarify_rounds_kind_status',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'kind' },
        { kind: 'column', name: 'status' },
      ],
      where: null,
    },
    {
      name: 'idx_clarify_rounds_asking',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'asking_node_id' },
        { kind: 'column', name: 'container_run_id' },
        { kind: 'column', name: 'loop_iter' },
        { kind: 'column', name: 'iteration' },
      ],
      where: null,
    },
    {
      name: 'idx_clarify_rounds_intermediary',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'intermediary_node_id' },
        { kind: 'column', name: 'loop_iter' },
        { kind: 'column', name: 'iteration' },
      ],
      where: null,
    },
    {
      name: 'idx_clarify_rounds_target_consumer',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'target_consumer_node_id' },
        { kind: 'column', name: 'loop_iter' },
        { kind: 'column', name: 'iteration' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'clarify_rounds',
  schemaSymbol: 'clarifyRounds',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    kind: c.enum('kind', ['self', 'cross']),
    askingNodeId: c.id('asking_node_id'),
    askingNodeRunId: c.id('asking_node_run_id'),
    askingShardKey: c.id('asking_shard_key', { nullable: true }),
    intermediaryNodeId: c.id('intermediary_node_id'),
    intermediaryNodeRunId: c.id('intermediary_node_run_id'),
    targetConsumerNodeId: c.id('target_consumer_node_id', { nullable: true }),
    loopIter: c.int('loop_iter', { default: 0 }),
    containerRunId: c.id('container_run_id', { nullable: true }),
    iteration: c.int('iteration', { default: 0 }),
    questionsJson: c.jsonText('questions_json'),
    directive: c.enum('directive', ['continue', 'stop'], { nullable: true }),
    status: c.enum('status', ['awaiting_human', 'answered', 'canceled', 'abandoned'], {
      default: 'awaiting_human',
    }),
    truncationWarningsJson: c.jsonText('truncation_warnings_json', { nullable: true }),
    designerRunTriggeredAt: c.epochMs('designer_run_triggered_at', { nullable: true }),
    abandonedAt: c.epochMs('abandoned_at', { nullable: true }),
    createdAt: c.epochMs('created_at', {
      default: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '(unixepoch() * 1000)',
        postgresql: '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      },
    }),
    answeredAt: c.epochMs('answered_at', { nullable: true }),
    answeredBy: c.text('answered_by', { nullable: true }),
    submittedByRole: c.text('submitted_by_role', { nullable: true }),
    questionsRevision: c.int('questions_revision', { default: 1 }),
    sealedQuestionSetKey: c.text('sealed_question_set_key', { nullable: true }),
    answersRecorded: c.bool('answers_recorded', { default: false }),
    draftsRecorded: c.bool('drafts_recorded', { default: false }),
    attributionsRecorded: c.bool('attributions_recorded', { default: false }),
    legacyAnswersJson: c.text('legacy_answers_json', { nullable: true }),
  },
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const clarifyRounds = materializeDrizzle(clarifyRoundsDefinition).table

const clarifyAnswersDefinition = owner.table({
  version: 1,
  unique: [{ name: 'clarify_answers_order', columns: ['round_id', 'ordinal'], nulls: 'distinct' }],
  foreignKeys: [
    {
      name: 'clarify_answers_round_fk',
      columns: ['round_id'],
      foreignTable: 'clarify_rounds',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Answer editing state belongs to this clarify round.',
    },
  ],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'clarify_answers',
  schemaSymbol: 'clarifyAnswers',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    roundId: c.id('round_id'),
    questionId: c.id('question_id'),
    occurrence: c.int('occurrence'),
    ordinal: c.int('ordinal'),
    valueJson: c.jsonText('value_json'),
    revision: c.int('revision', { default: 1 }),
    questionsRevision: c.int('questions_revision'),
    updatedAt: c.epochMs('updated_at'),
  },
  primaryKey: ['round_id', 'question_id', 'occurrence'],
  migrationKey: ['round_id', 'question_id', 'occurrence'],
})

export const clarifyAnswers = materializeDrizzle(clarifyAnswersDefinition).table

const clarifyAnswerDraftsDefinition = owner.table({
  version: 1,
  unique: [
    { name: 'clarify_answer_drafts_order', columns: ['round_id', 'ordinal'], nulls: 'distinct' },
  ],
  foreignKeys: [
    {
      name: 'clarify_answer_drafts_round_fk',
      columns: ['round_id'],
      foreignTable: 'clarify_rounds',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Answer editing state belongs to this clarify round.',
    },
  ],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'clarify_answer_drafts',
  schemaSymbol: 'clarifyAnswerDrafts',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    roundId: c.id('round_id'),
    questionId: c.id('question_id'),
    occurrence: c.int('occurrence'),
    ordinal: c.int('ordinal'),
    valueJson: c.jsonText('value_json'),
    revision: c.int('revision', { default: 1 }),
    questionsRevision: c.int('questions_revision'),
    updatedAt: c.epochMs('updated_at'),
  },
  primaryKey: ['round_id', 'question_id', 'occurrence'],
  migrationKey: ['round_id', 'question_id', 'occurrence'],
})

export const clarifyAnswerDrafts = materializeDrizzle(clarifyAnswerDraftsDefinition).table

const clarifyAnswerAttributionsDefinition = owner.table({
  version: 1,
  unique: [
    {
      name: 'clarify_answer_attributions_order',
      columns: ['round_id', 'ordinal'],
      nulls: 'distinct',
    },
  ],
  foreignKeys: [
    {
      name: 'clarify_answer_attributions_round_fk',
      columns: ['round_id'],
      foreignTable: 'clarify_rounds',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Answer editing state belongs to this clarify round.',
    },
  ],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'clarify_answer_attributions',
  schemaSymbol: 'clarifyAnswerAttributions',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    roundId: c.id('round_id'),
    questionId: c.id('question_id'),
    occurrence: c.int('occurrence'),
    ordinal: c.int('ordinal'),
    valueJson: c.jsonText('value_json'),
  },
  primaryKey: ['round_id', 'question_id', 'occurrence'],
  migrationKey: ['round_id', 'question_id', 'occurrence'],
})

export const clarifyAnswerAttributions = materializeDrizzle(
  clarifyAnswerAttributionsDefinition,
).table

const collaborationGateOperationsDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [
    {
      name: 'collaboration_gate_operations_task_id_tasks_id_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
  ],
  checks: [
    {
      name: 'collaboration_gate_operations_task_revision_nonnegative',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"collaboration_gate_operations"."expected_task_revision" >= 0',
        postgresql: '"expected_task_revision" >= 0',
      },
    },
    {
      name: 'collaboration_gate_operations_gate_revision_nonnegative',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"collaboration_gate_operations"."expected_gate_revision" >= 0',
        postgresql: '"expected_gate_revision" >= 0',
      },
    },
    {
      name: 'collaboration_gate_operations_result_revision_next',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"collaboration_gate_operations"."result_gate_revision" IS NULL OR "collaboration_gate_operations"."result_gate_revision" = "collaboration_gate_operations"."expected_gate_revision" + 1',
        postgresql:
          '"result_gate_revision" IS NULL OR "result_gate_revision" = "expected_gate_revision" + 1',
      },
    },
    {
      name: 'collaboration_gate_operations_claim_epoch_nonnegative',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"collaboration_gate_operations"."claim_epoch" >= 0',
        postgresql: '"claim_epoch" >= 0',
      },
    },
    {
      name: 'collaboration_gate_operations_schema_version_positive',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"collaboration_gate_operations"."schema_version" > 0',
        postgresql: '"schema_version" > 0',
      },
    },
    {
      name: 'collaboration_gate_operations_manifest_json_valid',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: 'json_valid("collaboration_gate_operations"."manifest_json")',
        postgresql: 'json_valid("manifest_json")',
      },
    },
    {
      name: 'collaboration_gate_operations_receipt_json_valid',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"collaboration_gate_operations"."receipt_json" IS NULL OR json_valid("collaboration_gate_operations"."receipt_json")',
        postgresql: '"receipt_json" IS NULL OR json_valid("receipt_json")',
      },
    },
    {
      name: 'collaboration_gate_operations_failure_json_valid',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"collaboration_gate_operations"."failure_json" IS NULL OR json_valid("collaboration_gate_operations"."failure_json")',
        postgresql: '"failure_json" IS NULL OR json_valid("failure_json")',
      },
    },
    {
      name: 'collaboration_gate_operations_committed_shape',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"collaboration_gate_operations"."state" <> \'committed\' OR ("collaboration_gate_operations"."result_gate_revision" IS NOT NULL AND "collaboration_gate_operations"."receipt_json" IS NOT NULL AND "collaboration_gate_operations"."committed_at" IS NOT NULL)',
        postgresql:
          '"state" <> \'committed\' OR ("result_gate_revision" IS NOT NULL AND "receipt_json" IS NOT NULL AND "committed_at" IS NOT NULL)',
      },
    },
    {
      name: 'collaboration_gate_operations_completed_shape',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"collaboration_gate_operations"."state" <> \'completed\' OR ("collaboration_gate_operations"."failure_json" IS NOT NULL OR ("collaboration_gate_operations"."result_gate_revision" IS NOT NULL AND "collaboration_gate_operations"."receipt_json" IS NOT NULL AND "collaboration_gate_operations"."committed_at" IS NOT NULL))',
        postgresql:
          '"state" <> \'completed\' OR ("failure_json" IS NOT NULL OR ("result_gate_revision" IS NOT NULL AND "receipt_json" IS NOT NULL AND "committed_at" IS NOT NULL))',
      },
    },
    {
      name: 'collaboration_gate_operations_failed_shape',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"collaboration_gate_operations"."state" <> \'failed\' OR "collaboration_gate_operations"."failure_json" IS NOT NULL',
        postgresql: '"state" <> \'failed\' OR "failure_json" IS NOT NULL',
      },
    },
    {
      name: 'collaboration_gate_operations_gate_kind_enum',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          "\"collaboration_gate_operations\".\"gate_kind\" IN ('review','clarify','questions')",
        postgresql: "\"gate_kind\" IN ('review','clarify','questions')",
      },
    },
    {
      name: 'collaboration_gate_operations_operation_kind_enum',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          "\"collaboration_gate_operations\".\"operation_kind\" IN ('open','decide','manual-question-open','legacy-seed')",
        postgresql: "\"operation_kind\" IN ('open','decide','manual-question-open','legacy-seed')",
      },
    },
    {
      name: 'collaboration_gate_operations_state_enum',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          "\"collaboration_gate_operations\".\"state\" IN ('preparing','prepared','committed','cleanup_pending','completed','failed')",
        postgresql:
          "\"state\" IN ('preparing','prepared','committed','cleanup_pending','completed','failed')",
      },
    },
  ],
  indexes: [
    {
      name: 'idx_collaboration_gate_operations_idempotency',
      unique: true,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'task_id' },
        { kind: 'column', name: 'gate_kind' },
        { kind: 'column', name: 'operation_kind' },
        { kind: 'column', name: 'idempotency_key' },
      ],
      where: null,
    },
    {
      name: 'idx_collaboration_gate_operations_revision',
      unique: true,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'gate_kind' },
        { kind: 'column', name: 'gate_ref' },
        { kind: 'column', name: 'result_gate_revision' },
      ],
      where: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"collaboration_gate_operations"."result_gate_revision" IS NOT NULL',
        postgresql: '"result_gate_revision" IS NOT NULL',
      },
    },
    {
      name: 'idx_collaboration_gate_operations_one_active',
      unique: true,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'task_id' },
        { kind: 'column', name: 'gate_kind' },
        { kind: 'column', name: 'gate_ref' },
        { kind: 'column', name: 'operation_kind' },
      ],
      where: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          "\"collaboration_gate_operations\".\"state\" IN ('preparing', 'prepared', 'committed', 'cleanup_pending')",
        postgresql: "\"state\" IN ('preparing', 'prepared', 'committed', 'cleanup_pending')",
      },
    },
    {
      name: 'idx_collaboration_gate_operations_recovery',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'state' },
        { kind: 'column', name: 'claim_expires_at' },
        { kind: 'column', name: 'updated_at' },
      ],
      where: null,
    },
    {
      name: 'idx_collaboration_gate_operations_task_gate',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'task_id' },
        { kind: 'column', name: 'gate_kind' },
        { kind: 'column', name: 'gate_ref' },
        { kind: 'column', name: 'created_at' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'collaboration_gate_operations',
  schemaSymbol: 'collaborationGateOperations',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    gateKind: c.enum('gate_kind', ['review', 'clarify', 'questions']),
    operationKind: c.enum('operation_kind', [
      'open',
      'decide',
      'manual-question-open',
      'legacy-seed',
    ]),
    gateRef: c.id('gate_ref'),
    idempotencyKey: c.id('idempotency_key'),
    requestHash: c.text('request_hash'),
    actorUserId: c.id('actor_user_id', { nullable: true }),
    expectedTaskRevision: c.int('expected_task_revision'),
    expectedGateRevision: c.int('expected_gate_revision'),
    resultGateRevision: c.int('result_gate_revision', { nullable: true }),
    state: c.enum('state', [
      'preparing',
      'prepared',
      'committed',
      'cleanup_pending',
      'completed',
      'failed',
    ]),
    claimEpoch: c.int('claim_epoch', { default: 0 }),
    claimExpiresAt: c.epochMs('claim_expires_at', { nullable: true }),
    schemaVersion: c.int('schema_version', { default: 1 }),
    manifestJson: c.jsonText('manifest_json', { default: '{}' }),
    receiptJson: c.jsonText('receipt_json', { nullable: true }),
    failureJson: c.jsonText('failure_json', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    committedAt: c.epochMs('committed_at', { nullable: true }),
    completedAt: c.epochMs('completed_at', { nullable: true }),
  },
  retention: {
    class: 'owner-managed-operational',
    rule: 'The owning bounded context defines retention and archive jobs through its application port.',
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
  rowRules: [
    {
      kind: 'immutableOnceSet',
      columns: ['result_gate_revision', 'receipt_json', 'committed_at'],
      when: {
        kind: 'unary',
        op: 'IS NOT NULL',
        value: { kind: 'column', name: 'result_gate_revision' },
      },
      errorCode: 'human-gate-committed-receipt-immutable',
    },
  ],
})

export const collaborationGateOperations = materializeDrizzle(
  collaborationGateOperationsDefinition,
).table

const taskCollaboratorsDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [
    {
      name: 'task_collaborators_task_id_tasks_id_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
    {
      name: 'task_collaborators_user_id_users_id_fk',
      columns: ['user_id'],
      foreignTable: 'users',
      foreignColumns: ['id'],
      onDelete: 'restrict',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 restrict delete and no action update semantics; target is a logical table reference.',
    },
    {
      name: 'task_collaborators_added_by_fk',
      columns: ['added_by'],
      foreignTable: 'users',
      foreignColumns: ['id'],
      onDelete: 'no action',
      onUpdate: 'no action',
      lifecycle: 'Nonnullable collaborator attribution remains until the collaboration is removed.',
    },
  ],
  checks: [],
  indexes: [
    {
      name: 'idx_task_collab_user',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'user_id' }],
      where: null,
    },
    {
      name: 'idx_task_collab_task',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'task_id' }],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'task_collaborators',
  schemaSymbol: 'taskCollaborators',
  columns: {
    taskId: c.id('task_id'),
    userId: c.id('user_id'),
    role: c.enum('role', ['owner', 'collaborator', 'observer']),
    addedBy: c.text('added_by'),
    addedAt: c.epochMs('added_at'),
  },
  primaryKey: ['task_id', 'user_id', 'role'],
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  migrationKey: ['task_id', 'user_id', 'role'],
})

export const taskCollaborators = materializeDrizzle(taskCollaboratorsDefinition).table

const docVersionsDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [
    {
      name: 'doc_versions_task_id_tasks_id_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
    {
      name: 'doc_versions_review_node_run_id_node_runs_id_fk',
      columns: ['review_node_run_id'],
      foreignTable: 'node_runs',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
  ],
  checks: [],
  indexes: [
    {
      name: 'idx_doc_versions_review_run',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'review_node_run_id' },
        { kind: 'column', name: 'version_index' },
      ],
      where: null,
    },
    {
      name: 'idx_doc_versions_task',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'task_id' }],
      where: null,
    },
    {
      name: 'idx_doc_versions_review_item',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'review_node_run_id' },
        { kind: 'column', name: 'item_index' },
      ],
      where: null,
    },
    {
      name: 'idx_doc_versions_pending_created',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'created_at' }],
      where: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"doc_versions"."decision" = \'pending\'',
        postgresql: '"decision" = \'pending\'',
      },
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'doc_versions',
  schemaSymbol: 'docVersions',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    reviewNodeId: c.id('review_node_id'),
    reviewNodeRunId: c.id('review_node_run_id'),
    sourceNodeId: c.id('source_node_id'),
    sourcePortName: c.text('source_port_name'),
    versionIndex: c.int('version_index'),
    reviewIteration: c.int('review_iteration'),
    commentsJson: c.jsonText('comments_json', { default: '[]' }),
    decision: c.enum('decision', ['pending', 'approved', 'rejected', 'iterated', 'superseded'], {
      default: 'pending',
    }),
    decisionReason: c.text('decision_reason', { nullable: true }),
    promptSnapshot: c.text('prompt_snapshot', { nullable: true }),
    sourceFilePath: c.text('source_file_path', { nullable: true }),
    itemIndex: c.int('item_index', { nullable: true }),
    selection: c.enum('selection', ['unselected', 'accepted', 'not_accepted'], { nullable: true }),
    itemPath: c.text('item_path', { nullable: true }),
    selectionStale: c.bool('selection_stale', { nullable: true }),
    roundGeneration: c.int('round_generation', { nullable: true }),
    createdAt: c.epochMs('created_at', {
      default: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '(unixepoch() * 1000)',
        postgresql: '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      },
    }),
    decidedAt: c.epochMs('decided_at', { nullable: true }),
    decidedBy: c.text('decided_by', { nullable: true }),
    decidedByRole: c.text('decided_by_role', { nullable: true }),
    contentRefJson: c.jsonText('content_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'content_inline_bytes' },
    }),
    contentInlineBytes: c.bytes('content_inline_bytes', { nullable: true }),
  },
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const docVersions = materializeDrizzle(docVersionsDefinition).table

const reviewCommentsDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [
    {
      name: 'review_comments_doc_version_id_doc_versions_id_fk',
      columns: ['doc_version_id'],
      foreignTable: 'doc_versions',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
  ],
  checks: [],
  indexes: [
    {
      name: 'idx_review_comments_version',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'doc_version_id' },
        { kind: 'column', name: 'anchor_section_path' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'review_comments',
  schemaSymbol: 'reviewComments',
  columns: {
    id: c.id('id', { primary: true }),
    docVersionId: c.id('doc_version_id'),
    anchorSectionPath: c.text('anchor_section_path'),
    anchorParagraphIdx: c.int('anchor_paragraph_idx'),
    anchorOffsetStart: c.int('anchor_offset_start'),
    anchorOffsetEnd: c.int('anchor_offset_end'),
    selectedText: c.text('selected_text'),
    contextBefore: c.text('context_before'),
    contextAfter: c.text('context_after'),
    occurrenceIndex: c.int('occurrence_index'),
    author: c.text('author', { default: 'local' }),
    authorRole: c.text('author_role', { nullable: true }),
    createdAt: c.epochMs('created_at', {
      default: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '(unixepoch() * 1000)',
        postgresql: '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      },
    }),
    contentRefJson: c.jsonText('content_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'content_inline_bytes' },
    }),
    contentInlineBytes: c.bytes('content_inline_bytes', { nullable: true }),
  },
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const reviewComments = materializeDrizzle(reviewCommentsDefinition).table

const collaborationGateArtifactsDefinition = owner.table({
  version: 3,
  unique: [],
  foreignKeys: [
    {
      name: 'collaboration_gate_artifacts_operation_id_collaboration_gate_operations_id_fk',
      columns: ['operation_id'],
      foreignTable: 'collaboration_gate_operations',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
  ],
  checks: [
    {
      name: 'collaboration_gate_artifacts_byte_size_nonnegative',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"collaboration_gate_artifacts"."byte_size" >= 0',
        postgresql: '"byte_size" >= 0',
      },
    },
    {
      name: 'collaboration_gate_artifacts_receipt_json_valid',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"collaboration_gate_artifacts"."receipt_json" IS NULL OR json_valid("collaboration_gate_artifacts"."receipt_json")',
        postgresql: '"receipt_json" IS NULL OR json_valid("receipt_json")',
      },
    },
    {
      name: 'collaboration_gate_artifacts_artifact_kind_fixed',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"collaboration_gate_artifacts"."artifact_kind" = \'review-doc\'',
        postgresql: '"artifact_kind" = \'review-doc\'',
      },
    },
    {
      name: 'collaboration_gate_artifacts_state_enum',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          "\"collaboration_gate_artifacts\".\"state\" IN ('declared','staged','consumed','finalized','cleanup_pending')",
        postgresql: "\"state\" IN ('declared','staged','consumed','finalized','cleanup_pending')",
      },
    },
  ],
  indexes: [
    {
      name: 'idx_collaboration_gate_artifacts_final_key',
      unique: true,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'final_content_key' }],
      where: null,
    },
    {
      name: 'idx_collaboration_gate_artifacts_state',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'state' },
        { kind: 'column', name: 'updated_at' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'collaboration_gate_artifacts',
  schemaSymbol: 'collaborationGateArtifacts',
  columns: {
    operationId: c.id('operation_id'),
    artifactKey: c.id('artifact_key'),
    artifactKind: c.enum('artifact_kind', ['review-doc']),
    sha256: c.text('sha256'),
    byteSize: c.int('byte_size'),
    state: c.enum('state', ['declared', 'staged', 'consumed', 'finalized', 'cleanup_pending']),
    receiptJson: c.jsonText('receipt_json', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
    stagedContentRefJson: c.jsonText('staged_content_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'staged_inline_bytes' },
      nullable: true,
    }),
    stagedInlineBytes: c.bytes('staged_inline_bytes', { nullable: true }),
    finalContentKey: c.id('final_content_key'),
    contentRefJson: c.jsonText('content_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'content_inline_bytes' },
      nullable: true,
    }),
    contentInlineBytes: c.bytes('content_inline_bytes', { nullable: true }),
  },
  primaryKey: ['operation_id', 'artifact_key'],
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  migrationKey: ['operation_id', 'artifact_key'],
})

export const collaborationGateArtifacts = materializeDrizzle(
  collaborationGateArtifactsDefinition,
).table

export const schemaContribution = {
  owner: 'collaboration',
  version: 2,
  tables: [
    reviewNodeReviewersDefinition,
    taskFeedbackDefinition,
    taskQuestionsDefinition,
    clarifyRoundsDefinition,
    clarifyAnswersDefinition,
    clarifyAnswerDraftsDefinition,
    clarifyAnswerAttributionsDefinition,
    collaborationGateOperationsDefinition,
    taskCollaboratorsDefinition,
    docVersionsDefinition,
    reviewCommentsDefinition,
    collaborationGateArtifactsDefinition,
  ],
} as const

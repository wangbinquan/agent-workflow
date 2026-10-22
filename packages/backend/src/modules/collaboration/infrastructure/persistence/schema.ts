// RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.
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

const clarifyRoundsDefinition = owner.table({
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
    answersJson: c.jsonText('answers_json', { nullable: true }),
    directive: c.enum('directive', ['continue', 'stop'], { nullable: true }),
    status: c.enum('status', ['awaiting_human', 'answered', 'canceled', 'abandoned'], {
      default: 'awaiting_human',
    }),
    truncationWarningsJson: c.jsonText('truncation_warnings_json', { nullable: true }),
    designerRunTriggeredAt: c.epochMs('designer_run_triggered_at', { nullable: true }),
    abandonedAt: c.epochMs('abandoned_at', { nullable: true }),
    createdAt: c.epochMs('created_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
    answeredAt: c.epochMs('answered_at', { nullable: true }),
    answeredBy: c.text('answered_by', { nullable: true }),
    submittedByRole: c.text('submitted_by_role', { nullable: true }),
    answerAttributionsJson: c.jsonText('answer_attributions_json', { nullable: true }),
    draftAnswersJson: c.jsonText('draft_answers_json', { nullable: true }),
  },
  foreignKeys: [
    foreignKey('clarify_rounds_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
    foreignKey(
      'clarify_rounds_asking_node_run_id_node_runs_id_fk',
      ['asking_node_run_id'],
      'node_runs',
      ['id'],
      { onDelete: 'cascade' },
    ),
    foreignKey(
      'clarify_rounds_intermediary_node_run_id_node_runs_id_fk',
      ['intermediary_node_run_id'],
      'node_runs',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  checks: [
    {
      name: 'clarify_rounds_kind_enum',
      expression: raw(
        '"clarify_rounds"."kind" IN (\'self\', \'cross\')',
        "\"kind\" IN ('self', 'cross')",
      ),
    },
    {
      name: 'clarify_rounds_directive_enum',
      expression: raw(
        '"clarify_rounds"."directive" IS NULL OR "clarify_rounds"."directive" IN (\'continue\', \'stop\')',
        '"directive" IS NULL OR "directive" IN (\'continue\', \'stop\')',
      ),
    },
    {
      name: 'clarify_rounds_status_enum',
      expression: raw(
        "\"clarify_rounds\".\"status\" IN ('awaiting_human', 'answered', 'canceled', 'abandoned')",
        "\"status\" IN ('awaiting_human', 'answered', 'canceled', 'abandoned')",
      ),
    },
    {
      name: 'clarify_rounds_kind_shape',
      expression: raw(
        '("clarify_rounds"."kind" = \'self\' AND "clarify_rounds"."status" != \'abandoned\') OR ("clarify_rounds"."kind" = \'cross\' AND "clarify_rounds"."status" != \'canceled\')',
        '("kind" = \'self\' AND "status" != \'abandoned\') OR ("kind" = \'cross\' AND "status" != \'canceled\')',
      ),
    },
  ],
  indexes: [
    index('idx_clarify_rounds_task', ['task_id']),
    index('idx_clarify_rounds_kind_status', ['kind', 'status']),
    index('idx_clarify_rounds_asking', [
      'asking_node_id',
      'container_run_id',
      'loop_iter',
      'iteration',
    ]),
    index('idx_clarify_rounds_intermediary', ['intermediary_node_id', 'loop_iter', 'iteration']),
    index('idx_clarify_rounds_target_consumer', [
      'target_consumer_node_id',
      'loop_iter',
      'iteration',
    ]),
  ],
  retention: retention.business,
})

export const clarifyRounds = materializeDrizzle(clarifyRoundsDefinition).table

const collaborationGateArtifactsDefinition = owner.table({
  id: 'collaboration_gate_artifacts',
  schemaSymbol: 'collaborationGateArtifacts',
  columns: {
    operationId: c.id('operation_id'),
    artifactKey: c.id('artifact_key'),
    artifactKind: c.enum('artifact_kind', ['review-doc']),
    stagedPath: c.text('staged_path'),
    finalPath: c.text('final_path'),
    sha256: c.text('sha256'),
    byteSize: c.int('byte_size'),
    state: c.enum('state', ['declared', 'staged', 'consumed', 'finalized', 'cleanup_pending']),
    receiptJson: c.jsonText('receipt_json', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
  },
  primaryKey: ['operation_id', 'artifact_key'],
  foreignKeys: [
    foreignKey(
      'collaboration_gate_artifacts_operation_id_collaboration_gate_operations_id_fk',
      ['operation_id'],
      'collaboration_gate_operations',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  checks: [
    {
      name: 'collaboration_gate_artifacts_byte_size_nonnegative',
      expression: raw('"collaboration_gate_artifacts"."byte_size" >= 0', '"byte_size" >= 0'),
    },
    {
      name: 'collaboration_gate_artifacts_receipt_json_valid',
      expression: raw(
        '"collaboration_gate_artifacts"."receipt_json" IS NULL OR json_valid("collaboration_gate_artifacts"."receipt_json")',
        '"receipt_json" IS NULL OR json_valid("receipt_json")',
      ),
    },
    {
      name: 'collaboration_gate_artifacts_artifact_kind_fixed',
      expression: raw(
        '"collaboration_gate_artifacts"."artifact_kind" = \'review-doc\'',
        '"artifact_kind" = \'review-doc\'',
      ),
    },
    {
      name: 'collaboration_gate_artifacts_state_enum',
      expression: raw(
        "\"collaboration_gate_artifacts\".\"state\" IN ('declared','staged','consumed','finalized','cleanup_pending')",
        "\"state\" IN ('declared','staged','consumed','finalized','cleanup_pending')",
      ),
    },
  ],
  indexes: [
    index('idx_collaboration_gate_artifacts_final_path', ['final_path'], { unique: true }),
    index('idx_collaboration_gate_artifacts_state', ['state', 'updated_at']),
  ],
  retention: retention.business,
})

export const collaborationGateArtifacts = materializeDrizzle(
  collaborationGateArtifactsDefinition,
).table

const collaborationGateOperationsDefinition = owner.table({
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
  foreignKeys: [
    foreignKey('collaboration_gate_operations_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  checks: [
    {
      name: 'collaboration_gate_operations_task_revision_nonnegative',
      expression: raw(
        '"collaboration_gate_operations"."expected_task_revision" >= 0',
        '"expected_task_revision" >= 0',
      ),
    },
    {
      name: 'collaboration_gate_operations_gate_revision_nonnegative',
      expression: raw(
        '"collaboration_gate_operations"."expected_gate_revision" >= 0',
        '"expected_gate_revision" >= 0',
      ),
    },
    {
      name: 'collaboration_gate_operations_result_revision_next',
      expression: raw(
        '"collaboration_gate_operations"."result_gate_revision" IS NULL OR "collaboration_gate_operations"."result_gate_revision" = "collaboration_gate_operations"."expected_gate_revision" + 1',
        '"result_gate_revision" IS NULL OR "result_gate_revision" = "expected_gate_revision" + 1',
      ),
    },
    {
      name: 'collaboration_gate_operations_claim_epoch_nonnegative',
      expression: raw('"collaboration_gate_operations"."claim_epoch" >= 0', '"claim_epoch" >= 0'),
    },
    {
      name: 'collaboration_gate_operations_schema_version_positive',
      expression: raw(
        '"collaboration_gate_operations"."schema_version" > 0',
        '"schema_version" > 0',
      ),
    },
    {
      name: 'collaboration_gate_operations_manifest_json_valid',
      expression: raw(
        'json_valid("collaboration_gate_operations"."manifest_json")',
        'json_valid("manifest_json")',
      ),
    },
    {
      name: 'collaboration_gate_operations_receipt_json_valid',
      expression: raw(
        '"collaboration_gate_operations"."receipt_json" IS NULL OR json_valid("collaboration_gate_operations"."receipt_json")',
        '"receipt_json" IS NULL OR json_valid("receipt_json")',
      ),
    },
    {
      name: 'collaboration_gate_operations_failure_json_valid',
      expression: raw(
        '"collaboration_gate_operations"."failure_json" IS NULL OR json_valid("collaboration_gate_operations"."failure_json")',
        '"failure_json" IS NULL OR json_valid("failure_json")',
      ),
    },
    {
      name: 'collaboration_gate_operations_committed_shape',
      expression: raw(
        '"collaboration_gate_operations"."state" <> \'committed\' OR ("collaboration_gate_operations"."result_gate_revision" IS NOT NULL AND "collaboration_gate_operations"."receipt_json" IS NOT NULL AND "collaboration_gate_operations"."committed_at" IS NOT NULL)',
        '"state" <> \'committed\' OR ("result_gate_revision" IS NOT NULL AND "receipt_json" IS NOT NULL AND "committed_at" IS NOT NULL)',
      ),
    },
    {
      name: 'collaboration_gate_operations_completed_shape',
      expression: raw(
        '"collaboration_gate_operations"."state" <> \'completed\' OR ("collaboration_gate_operations"."failure_json" IS NOT NULL OR ("collaboration_gate_operations"."result_gate_revision" IS NOT NULL AND "collaboration_gate_operations"."receipt_json" IS NOT NULL AND "collaboration_gate_operations"."committed_at" IS NOT NULL))',
        '"state" <> \'completed\' OR ("failure_json" IS NOT NULL OR ("result_gate_revision" IS NOT NULL AND "receipt_json" IS NOT NULL AND "committed_at" IS NOT NULL))',
      ),
    },
    {
      name: 'collaboration_gate_operations_failed_shape',
      expression: raw(
        '"collaboration_gate_operations"."state" <> \'failed\' OR "collaboration_gate_operations"."failure_json" IS NOT NULL',
        '"state" <> \'failed\' OR "failure_json" IS NOT NULL',
      ),
    },
    {
      name: 'collaboration_gate_operations_gate_kind_enum',
      expression: raw(
        "\"collaboration_gate_operations\".\"gate_kind\" IN ('review','clarify','questions')",
        "\"gate_kind\" IN ('review','clarify','questions')",
      ),
    },
    {
      name: 'collaboration_gate_operations_operation_kind_enum',
      expression: raw(
        "\"collaboration_gate_operations\".\"operation_kind\" IN ('open','decide','manual-question-open','legacy-seed')",
        "\"operation_kind\" IN ('open','decide','manual-question-open','legacy-seed')",
      ),
    },
    {
      name: 'collaboration_gate_operations_state_enum',
      expression: raw(
        "\"collaboration_gate_operations\".\"state\" IN ('preparing','prepared','committed','cleanup_pending','completed','failed')",
        "\"state\" IN ('preparing','prepared','committed','cleanup_pending','completed','failed')",
      ),
    },
  ],
  indexes: [
    index(
      'idx_collaboration_gate_operations_idempotency',
      ['task_id', 'gate_kind', 'operation_kind', 'idempotency_key'],
      { unique: true },
    ),
    index(
      'idx_collaboration_gate_operations_revision',
      ['gate_kind', 'gate_ref', 'result_gate_revision'],
      {
        unique: true,
        where: raw(
          '"collaboration_gate_operations"."result_gate_revision" IS NOT NULL',
          '"result_gate_revision" IS NOT NULL',
        ),
      },
    ),
    index(
      'idx_collaboration_gate_operations_one_active',
      ['task_id', 'gate_kind', 'gate_ref', 'operation_kind'],
      {
        unique: true,
        where: raw(
          "\"collaboration_gate_operations\".\"state\" IN ('preparing', 'prepared', 'committed', 'cleanup_pending')",
          "\"state\" IN ('preparing', 'prepared', 'committed', 'cleanup_pending')",
        ),
      },
    ),
    index('idx_collaboration_gate_operations_recovery', [
      'state',
      'claim_expires_at',
      'updated_at',
    ]),
    index('idx_collaboration_gate_operations_task_gate', [
      'task_id',
      'gate_kind',
      'gate_ref',
      'created_at',
    ]),
  ],
  retention: retention.operational,
})

export const collaborationGateOperations = materializeDrizzle(
  collaborationGateOperationsDefinition,
).table

const docVersionsDefinition = owner.table({
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
    bodyPath: c.text('body_path'),
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
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
    decidedAt: c.epochMs('decided_at', { nullable: true }),
    decidedBy: c.text('decided_by', { nullable: true }),
    decidedByRole: c.text('decided_by_role', { nullable: true }),
  },
  foreignKeys: [
    foreignKey('doc_versions_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
    foreignKey(
      'doc_versions_review_node_run_id_node_runs_id_fk',
      ['review_node_run_id'],
      'node_runs',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  indexes: [
    index('idx_doc_versions_review_run', ['review_node_run_id', 'version_index']),
    index('idx_doc_versions_task', ['task_id']),
    index('idx_doc_versions_review_item', ['review_node_run_id', 'item_index']),
    index('idx_doc_versions_pending_created', ['created_at'], {
      where: raw('"doc_versions"."decision" = \'pending\'', '"decision" = \'pending\''),
    }),
  ],
  retention: retention.business,
})

export const docVersions = materializeDrizzle(docVersionsDefinition).table

const reviewCommentsDefinition = owner.table({
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
    commentText: c.text('comment_text'),
    author: c.text('author', { default: 'local' }),
    authorRole: c.text('author_role', { nullable: true }),
    createdAt: c.epochMs('created_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
  },
  foreignKeys: [
    foreignKey(
      'review_comments_doc_version_id_doc_versions_id_fk',
      ['doc_version_id'],
      'doc_versions',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  indexes: [index('idx_review_comments_version', ['doc_version_id', 'anchor_section_path'])],
  retention: retention.business,
})

export const reviewComments = materializeDrizzle(reviewCommentsDefinition).table

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

const taskCollaboratorsDefinition = owner.table({
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
  foreignKeys: [
    foreignKey('task_collaborators_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
    foreignKey('task_collaborators_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
      onDelete: 'restrict',
    }),
  ],
  indexes: [index('idx_task_collab_user', ['user_id']), index('idx_task_collab_task', ['task_id'])],
  retention: retention.business,
})

export const taskCollaborators = materializeDrizzle(taskCollaboratorsDefinition).table

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

export const schemaContribution = owner.contribution([
  clarifyRoundsDefinition,
  collaborationGateArtifactsDefinition,
  collaborationGateOperationsDefinition,
  docVersionsDefinition,
  reviewCommentsDefinition,
  reviewNodeReviewersDefinition,
  taskCollaboratorsDefinition,
  taskFeedbackDefinition,
  taskQuestionsDefinition,
])

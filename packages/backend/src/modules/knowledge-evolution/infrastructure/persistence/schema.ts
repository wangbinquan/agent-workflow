// RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.
import {
  column as c,
  defineContribution,
  retention,
  raw,
  index,
} from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'

const owner = defineContribution('knowledge-evolution')

const fusionsDefinition = owner.table({
  id: 'fusions',
  schemaSymbol: 'fusions',
  columns: {
    id: c.id('id', { primary: true }),
    skillId: c.id('skill_id'),
    skillName: c.text('skill_name'),
    baseSkillVersion: c.int('base_skill_version'),
    preconditionToken: c.text('precondition_token', { nullable: true }),
    memoryIdsJson: c.jsonText('memory_ids_json'),
    intent: c.text('intent', { default: '' }),
    status: c.enum(
      'status',
      ['running', 'awaiting_approval', 'applying', 'done', 'rejected', 'canceled', 'failed'],
      { default: 'running' },
    ),
    iteration: c.int('iteration', { default: 1 }),
    currentTaskId: c.id('current_task_id', { nullable: true }),
    proposedWorktreePath: c.text('proposed_worktree_path', { nullable: true }),
    proposedDiff: c.text('proposed_diff', { nullable: true }),
    incorporatedMemoryIdsJson: c.jsonText('incorporated_memory_ids_json', { nullable: true }),
    skippedJson: c.jsonText('skipped_json', { nullable: true }),
    changelog: c.text('changelog', { nullable: true }),
    appliedSkillVersion: c.int('applied_skill_version', { nullable: true }),
    ownerUserId: c.id('owner_user_id'),
    createdAt: c.epochMs('created_at'),
    decidedByUserId: c.id('decided_by_user_id', { nullable: true }),
    decidedAt: c.epochMs('decided_at', { nullable: true }),
    decisionReason: c.text('decision_reason', { nullable: true }),
    error: c.text('error', { nullable: true }),
  },
  checks: [
    {
      name: 'fusions_status_enum',
      expression: raw(
        "\"fusions\".\"status\" IN ('running','awaiting_approval','applying','done','rejected','canceled','failed')",
        "\"status\" IN ('running','awaiting_approval','applying','done','rejected','canceled','failed')",
      ),
    },
  ],
  indexes: [index('idx_fusions_skill', ['skill_id']), index('idx_fusions_status', ['status'])],
  retention: retention.business,
})

export const fusions = materializeDrizzle(fusionsDefinition).table

export const schemaContribution = owner.contribution([fusionsDefinition])

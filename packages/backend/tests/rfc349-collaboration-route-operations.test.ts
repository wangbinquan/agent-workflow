import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8')
}

describe('RFC-349 collaboration route operations', () => {
  test('review, question and clarify routes consume the closed participant, not a database', () => {
    for (const path of [
      'src/routes/reviews.ts',
      'src/routes/taskQuestions.ts',
      'src/routes/clarify.ts',
    ]) {
      const text = source(path)
      expect(text, path).toContain('CollaborationRouteOperations')
      expect(text, path).toContain('operations: CollaborationRouteOperations')
      expect(text, path).not.toContain('operations?: CollaborationRouteOperations')
      expect(text, path).toContain('@/modules/collaboration/public/participants')
      expect(text, path).not.toContain(
        '@/modules/collaboration/application/ports/collaborationRouteOperations',
      )
      expect(text, path).not.toMatch(
        /@\/db|@\/server|drizzle-orm|\b(?:AppDeps|DbClient|PostgresqlDatabaseClient)\b|deps\./,
      )
      expect(text, path).toContain('collaboration-route-operations-not-composed')
    }
  })

  test('the application contract is provider-opaque and Promise-shaped', () => {
    const text = source(
      'src/modules/collaboration/application/ports/collaborationRouteOperations.ts',
    )
    expect(text).toContain('export interface CollaborationRouteOperations')
    expect(text).toContain('setSelection(input:')
    expect(text).toContain('createManual(input:')
    expect(text).toContain('saveDraft(input:')
    expect(text).not.toMatch(
      /@\/db|drizzle-orm|\b(?:DbClient|DbTxSync|PostgresqlDatabaseClient)\b|bun:sqlite/,
    )
    expect(text.match(/Promise</g)?.length ?? 0).toBeGreaterThanOrEqual(20)
  })

  test('SQLite and PostgreSQL factories implement the same closed aggregate', () => {
    const sqlite = source(
      'src/modules/collaboration/infrastructure/sqliteCollaborationRouteOperations.ts',
    )
    const postgresql = source(
      'src/modules/collaboration/infrastructure/postgresqlCollaborationRouteOperations.ts',
    )
    expect(sqlite).toContain('createSqliteCollaborationRouteOperations')
    expect(postgresql).toContain('createPostgresqlCollaborationRouteOperations')
    for (const group of ['reviews:', 'questions:', 'clarify:']) {
      expect(sqlite).toContain(group)
      expect(postgresql).toContain(group)
    }
    expect(postgresql).toMatch(/\.transaction\(/)
    expect(postgresql).toMatch(/\.select\(\)/)
    expect(postgresql).toMatch(/\.insert\(/)
    expect(postgresql).toMatch(/\.update\(/)
    expect(postgresql).toContain('await publishCommittedEventsAfterCommit')
    expect(postgresql).not.toMatch(
      /legacySqlite|createSqlite|\bas DbClient\b|\bas PostgresqlDatabaseClient\b|\bno-?op\b/i,
    )
  })

  test('PostgreSQL sealing requires task lifecycle and draft publication participants', () => {
    const postgresql = source(
      'src/modules/collaboration/infrastructure/postgresqlCollaborationRouteOperations.ts',
    )
    expect(postgresql).toContain(
      'taskNodeLifecycle: PostgresqlCollaborationRouteNodeLifecycleParticipantFactory',
    )
    expect(postgresql).not.toContain('@/modules/task-execution/composition')
    expect(postgresql).toContain('clarifyDraftEvents:')
    expect(postgresql).toContain(
      'await input.taskNodeLifecycle.inTransaction(tx).completeClarifyNode',
    )
    expect(postgresql).toContain('await composition.clarifyDraftEvents.publish')
    expect(postgresql).not.toContain('taskBroadcaster')

    const composition = source(
      'src/modules/collaboration/composition/collaborationRouteOperations.ts',
    )
    const publisher = source(
      'src/modules/collaboration/infrastructure/collaborationClarifyDraftEventPublisher.ts',
    )
    expect(composition).toContain('composePostgresqlCollaborationRouteOperations')
    expect(composition).toContain('context: CollaborationCommandContext')
    expect(composition).toContain('bindCollaborationRouteContext')
    expect(composition).toContain('createCollaborationClarifyDraftEventPublisher()')
    expect(publisher).toContain('taskBroadcaster.broadcast(TASK_CHANNEL(input.taskId)')
    expect(publisher).toContain("type: 'clarify.draft.updated'")
  })

  test('SQLite daemon composition wires every collaboration decision port without a root cycle', () => {
    const start = source('src/cli/start.ts')
    const root = source('src/modules/collaboration/composition.ts')
    const composition = source(
      'src/modules/collaboration/composition/legacySqliteDecisionCommands.ts',
    )

    for (const factory of [
      'createSqliteReviewDecisionCommand',
      'createSqliteQuestionDispatchCommand',
      'createSqliteClarifyDecisionCommand',
    ]) {
      expect(start).toContain(factory)
      expect(composition).toContain(`export { ${factory} }`)
      expect(root).not.toContain(`export { ${factory} }`)
    }
    expect(start).toContain('reviewDecisions: createSqliteReviewDecisionCommand')
    expect(start).toContain('questionDispatches: createSqliteQuestionDispatchCommand')
    expect(start).toContain('clarifyDecisions: createSqliteClarifyDecisionCommand')

    for (const path of [
      'src/modules/collaboration/infrastructure/legacySqliteReviewDecisionComposition.ts',
      'src/modules/collaboration/infrastructure/legacySqliteQuestionDispatchComposition.ts',
      'src/modules/collaboration/infrastructure/legacySqliteClarifyDecisionComposition.ts',
    ]) {
      const text = source(path)
      expect(text, path).toContain('../composition/commandContext')
      expect(text, path).not.toContain('@/services/humanGateComposition')
      expect(text, path).toContain('await import(')
    }
  })
})

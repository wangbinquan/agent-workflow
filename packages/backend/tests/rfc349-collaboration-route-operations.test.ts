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

  // RFC-359 W7：这一对适配器已合一。旧断言（两份工厂各自含 reviews:/questions:/clarify:、
  // PG 那份自带 .transaction()/.select()/.insert()/.update() 的原生重写）随
  // `postgresqlCollaborationRouteOperations.ts` 一并退役——2026-09-07 的双引擎对拍
  // （`rfc359-w7-collaboration-route-conformance.test.ts`）照出那份重写的两处真实分叉：
  // `reviews.setSelection` / `clarify.saveDraft` 跑在裸 `db.transaction` 上、不可重入，
  // 外层事务回滚带不走它们的写。正典是被转发的中立实现。
  test('路由持久化面只有一个工厂，且不含任何 provider 分叉', () => {
    const factory = source(
      'src/modules/collaboration/infrastructure/collaborationRouteOperations.ts',
    )
    for (const group of ['reviews:', 'questions:', 'clarify:']) {
      expect(factory).toContain(group)
    }
    expect(factory).toContain('createCollaborationRouteOperations')
    expect(factory).toContain('ProviderNeutralDatabase')
    expect(factory).not.toMatch(
      /\bPostgresqlDatabaseClient\b|\bDbClient\b|\$provider|'postgresql'|'sqlite'/,
    )
    // 惰性 import 是为了断开 `services/humanGateComposition` 绕回 composition barrel 的值环。
    expect(factory).toContain("() => import('./legacySqliteReview')")
    expect(() =>
      source('src/modules/collaboration/infrastructure/postgresqlCollaborationRouteOperations.ts'),
    ).toThrow()
    expect(() =>
      source('src/modules/collaboration/infrastructure/sqliteCollaborationRouteOperations.ts'),
    ).toThrow()
  })

  test('封存时的任务生命周期参与者与草稿投影仍由装配点注入', () => {
    const composition = source(
      'src/modules/collaboration/composition/collaborationRouteOperations.ts',
    )
    const publisher = source(
      'src/modules/collaboration/infrastructure/collaborationClarifyDraftEventPublisher.ts',
    )
    expect(composition).toContain('composePostgresqlCollaborationRouteOperations')
    expect(composition).toContain('composeSqliteCollaborationRouteOperations')
    expect(composition).toContain('context: CollaborationCommandContext')
    expect(composition).toContain('bindCollaborationRouteContext')
    expect(composition).toContain('createCollaborationClarifyDraftEventPublisher()')
    expect(publisher).toContain('taskBroadcaster.broadcast(TASK_CHANNEL(input.taskId)')
    expect(publisher).toContain("type: 'clarify.draft.updated'")
    // 持久化实现不再直接够全局广播器：草稿事件走注入的 publisher。
    const factory = source(
      'src/modules/collaboration/infrastructure/collaborationRouteOperations.ts',
    )
    expect(factory).toContain('draftEvents: input.clarifyDraftEvents')
    expect(factory).not.toContain('taskBroadcaster')
  })

  test('SQLite daemon composition wires every collaboration decision port without a root cycle', () => {
    const start = source('src/cli/start.ts')
    const root = source('src/modules/collaboration/composition.ts')
    const composition = source(
      'src/modules/collaboration/composition/legacySqliteDecisionCommands.ts',
    )

    for (const factory of [
      'createReviewDecisionCommand',
      'createQuestionDispatchCommand',
      'createClarifyDecisionCommand',
    ]) {
      expect(start).toContain(factory)
      expect(composition).toContain(`export { ${factory} }`)
      expect(root).not.toContain(`export { ${factory} }`)
    }
    expect(start).toContain('reviewDecisions: createReviewDecisionCommand')
    expect(start).toContain('questionDispatches: createQuestionDispatchCommand')
    expect(start).toContain('clarifyDecisions: createClarifyDecisionCommand')

    for (const path of [
      'src/modules/collaboration/infrastructure/reviewDecisionCommand.ts',
      'src/modules/collaboration/infrastructure/questionDispatchCommand.ts',
      'src/modules/collaboration/infrastructure/clarifyDecisionCommand.ts',
    ]) {
      const text = source(path)
      expect(text, path).toContain('../composition/commandContext')
      expect(text, path).not.toContain('@/services/humanGateComposition')
      expect(text, path).toContain('await import(')
    }
  })
})

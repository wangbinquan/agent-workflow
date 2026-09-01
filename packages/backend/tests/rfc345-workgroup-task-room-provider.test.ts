import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sourceRoot = resolve(import.meta.dir, '../src')
const read = (path: string): string => readFileSync(resolve(sourceRoot, path), 'utf8')

describe('RFC-345 task-scoped Workgroup room provider boundary', () => {
  test('the route consumes one required closed module binding', () => {
    const route = read('routes/workgroupTasks.ts')
    expect(route).toContain('readonly module: WorkgroupTaskRoomModule')
    expect(route).toContain('readonly authorityFor: (actor: Actor) => WorkgroupOperationContext')
    expect(route).not.toContain('AppDeps')
    expect(route).not.toContain('DbClient')
    expect(route).not.toContain('@/services/workgroup/')
    expect(route).not.toContain('buildWorkgroupTaskActions')
  })

  test('the public contract is closed and provider clients remain private', () => {
    const types = read('modules/resource-catalog/public/types.ts')
    const operations = read('modules/resource-catalog/public/operations.ts')
    expect(types).toContain("readonly kind: 'json-body'")
    expect(types).toContain("readonly kind: 'json-document'")
    expect(operations).toContain('export interface WorkgroupTaskRoomModule')
    for (const source of [types, operations]) {
      expect(source).not.toContain('PostgresqlDatabaseClient')
      expect(source).not.toContain('DbClient')
    }
  })

  test('SQLite legacy mechanics terminate in infrastructure', () => {
    const sqlite = read('modules/resource-catalog/infrastructure/sqliteWorkgroupTaskRoom.ts')
    expect(sqlite).toContain('buildWorkgroupTaskActions(dependencies)')
    expect(sqlite).toContain('buildConfigActions(dependencies, core)')
    expect(sqlite).toContain('buildDwActions(dependencies, core)')
    expect(sqlite).toContain('buildRoomReads(dependencies, core)')
  })

  test('PostgreSQL owns room rows and joins the exact TaskExecution participant', () => {
    const adapter = read('modules/resource-catalog/infrastructure/postgresqlWorkgroupTaskRoom.ts')
    const commands = read(
      'modules/resource-catalog/infrastructure/postgresqlWorkgroupTaskRoomCommands.ts',
    )
    const queries = read(
      'modules/resource-catalog/infrastructure/postgresqlWorkgroupTaskRoomQueries.ts',
    )
    const composition = read('modules/resource-catalog/composition/workgroupTaskRoom.ts')

    expect(adapter).toContain('runPostgresqlResourceCatalogTransaction')
    expect(adapter).toContain('taskParticipantFactory.inTransaction(transaction)')
    expect(adapter).toContain('participant.loadVisible')
    expect(commands).toContain('loadVisibleTask(transaction, participant')
    expect(commands).toContain('participant.replaceConfig')
    expect(commands).toContain('participant.dismissOpenClarifyParksForAutonomous')
    expect(commands).toContain('participant.continueTask')
    expect(commands).toContain('participant.failTask')
    expect(queries).toContain('participant.listVisibleActive')
    expect(queries).toContain('participant.loadClarifyProjection')
    expect(queries).toContain('participant.listHostRuns')
    expect(composition).toContain('composePostgresqlWorkgroupTaskRoom')
    expect(composition).toContain('createPostgresqlWorkgroupTaskRoomTransactionRunner')

    const provider = `${adapter}\n${commands}\n${queries}`
    for (const ownedTable of [
      'workgroupAssignments',
      'workgroupMessages',
      'workgroupTaskState',
      'workgroupMemberCursors',
    ]) {
      expect(provider).toContain(ownedTable)
    }
    const schemaImports =
      provider.match(/import \{[\s\S]*?\} from '@\/db\/schema'/gu)?.join('\n') ?? ''
    for (const foreignTable of [
      'clarifyRounds',
      'nodeRuns',
      'taskCollaborators',
      'taskNodeClarifyDirectives',
      'tasks',
      'users',
    ]) {
      expect(schemaImports).not.toMatch(new RegExp(`\\b${foreignTable}\\b`))
    }
    expect(provider).not.toContain('/legacy/')
    expect(provider).not.toContain('createSqliteWorkgroupTaskRoomDriver')
  })

  test('PostgreSQL route behavior stays behind closed injected seams', () => {
    const adapter = read('modules/resource-catalog/infrastructure/postgresqlWorkgroupTaskRoom.ts')
    expect(adapter).toContain('WorkgroupTaskRoomActiveUserDirectory')
    expect(adapter).toContain('WorkgroupTaskRoomDynamicWorkflowOperations')
    expect(adapter).toContain('findActiveUserIds')
    expect(adapter).toContain('validateGenerated')
    expect(adapter).toContain('readonly broadcast:')
    expect(adapter).not.toContain('PostgresqlTaskExecutionTransaction')
    expect(adapter).not.toContain('PostgresqlCollaborationTransaction')
  })

  test('consumer-zero compatibility facades stay retired', () => {
    for (const facade of ['configActions', 'dwActions', 'room', 'taskActions']) {
      expect(() => read(`services/workgroup/${facade}.ts`)).toThrow()
    }
  })
})

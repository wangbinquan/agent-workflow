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

  test('两个 provider 各自的任务房实现已退役，只剩一份中立实现', () => {
    // RFC-359 W4-D19b —— 合一前 SQLite 走 legacy 引擎上的薄驱动、PostgreSQL 走原生实现；
    // 现在两个 bootstrap 装的是同一份 `composeWorkgroupTaskRoom`。
    for (const retired of [
      'sqliteWorkgroupTaskRoom',
      'postgresqlWorkgroupTaskRoom',
      'postgresqlWorkgroupTaskRoomCommands',
      'postgresqlWorkgroupTaskRoomQueries',
    ]) {
      expect(() => read(`modules/resource-catalog/infrastructure/${retired}.ts`)).toThrow()
    }
    const composition = read('modules/resource-catalog/composition/workgroupTaskRoom.ts')
    expect(composition).toContain('export function composeWorkgroupTaskRoom(')
    expect(composition).not.toContain('composeSqliteWorkgroupTaskRoom')
    expect(composition).not.toContain('composePostgresqlWorkgroupTaskRoom')
    for (const bootstrap of ['server.ts', 'cli/postgresqlDaemonApplication.ts']) {
      expect(read(bootstrap)).toContain('composeWorkgroupTaskRoom({')
    }
  })

  test('房间拥有自己的行，并在同一笔事务里接上 TaskExecution 参与者', () => {
    const adapter = read('modules/resource-catalog/infrastructure/workgroupTaskRoom.ts')
    const commands = read('modules/resource-catalog/infrastructure/workgroupTaskRoomCommands.ts')
    const queries = read('modules/resource-catalog/infrastructure/workgroupTaskRoomQueries.ts')
    const composition = read('modules/resource-catalog/composition/workgroupTaskRoom.ts')

    expect(adapter).toContain('runResourceCatalogTransaction')
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
    expect(composition).toContain('createWorkgroupTaskRoomTransactionRunner')

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
    // 房间不认识数据库品牌：客户端类型只有中立那一个。
    for (const source of [adapter, commands, queries]) {
      expect(source).not.toContain('PostgresqlDatabaseClient')
      expect(source).not.toContain('DbClient')
    }
  })

  test('路由行为全部走注入的封闭接缝', () => {
    const adapter = read('modules/resource-catalog/infrastructure/workgroupTaskRoom.ts')
    expect(adapter).toContain('WorkgroupTaskRoomActiveUserDirectory')
    expect(adapter).toContain('WorkgroupTaskRoomDynamicWorkflowOperations')
    expect(adapter).toContain('findActiveUserIds')
    expect(adapter).toContain('validateGenerated')
    expect(adapter).toContain('readonly broadcast:')
    // RFC-359 W4-D19b —— 「恢复执行」按部署形态注入：单进程做预检 + 内联驱动，多进程两件皆空操作。
    expect(adapter).toContain('WorkgroupTaskRoomContinuationDriver')
    expect(adapter).toContain('assertResumable')
    expect(adapter).toContain('driveAfterCommit')
    expect(adapter).not.toContain('PostgresqlTaskExecutionTransaction')
    expect(adapter).not.toContain('PostgresqlCollaborationTransaction')
  })

  test('consumer-zero compatibility facades stay retired', () => {
    for (const facade of ['configActions', 'dwActions', 'room', 'taskActions']) {
      expect(() => read(`services/workgroup/${facade}.ts`)).toThrow()
    }
  })
})

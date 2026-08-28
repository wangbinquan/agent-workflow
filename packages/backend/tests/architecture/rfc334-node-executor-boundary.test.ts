import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

describe('RFC-334 node-executor owner boundary', () => {
  test('domain and engine skeleton do not import legacy scheduler or infrastructure bags', () => {
    const paths = [
      'packages/backend/src/modules/task-execution/domain/nodeExecution.ts',
      'packages/backend/src/modules/task-execution/engine/node/nodeExecutor.ts',
      'packages/backend/src/modules/task-execution/engine/node/nodeExecutorRegistry.ts',
      'packages/backend/src/modules/task-execution/engine/node/nodeExecutionGateway.ts',
    ]
    for (const path of paths) {
      const source = read(path)
      expect(source).not.toContain('@/services/scheduler')
      expect(source).not.toMatch(/\b(?:DbClient|SchedulerState|LegacyTaskMechanicsState|RunTaskOptions)\b/)
      expect(source).not.toContain("from '@/db/schema'")
    }
  })

  test('host request contains no workgroup assignment or strategy ownership', () => {
    const source = read(
      'packages/backend/src/modules/task-execution/application/ports/workgroupHostExecution.ts',
    )
    expect(source).not.toMatch(
      /readonly\s+(?:assignmentStatus|turnCursor|strategy|roundState)\??\s*:/,
    )
    expect(source).not.toMatch(/\b(?:DbClient|SchedulerState|LegacyTaskMechanicsState)\b/)
  })

  test('T4 is additive only: the production DAG still has one legacy selector until atomic cuts', () => {
    const scope = read(
      'packages/backend/src/modules/task-execution/composition/taskDagScope.ts',
    )
    expect(scope).toContain("from '@/services/scheduler'")
    expect(scope.match(/\brunOneNode\(/g)).toHaveLength(1)
    expect(scope).not.toContain('NodeExecutionGateway')
  })
})

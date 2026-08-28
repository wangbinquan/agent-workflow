import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

function nodeEngineBoundaryViolations(source: string): string[] {
  return [
    source.includes('@/services/scheduler') ? 'legacy-scheduler-import' : null,
    /\b(?:DbClient|SchedulerState|LegacyTaskMechanicsState|RunTaskOptions)\b/.test(source)
      ? 'infrastructure-bag'
      : null,
    source.includes("from '@/db/schema'") ? 'raw-schema-import' : null,
  ].filter((value): value is string => value !== null)
}

describe('RFC-334 node-executor owner boundary', () => {
  test('domain and every node engine file avoid legacy scheduler and infrastructure bags', () => {
    const engineDir = 'packages/backend/src/modules/task-execution/engine/node'
    const paths = [
      'packages/backend/src/modules/task-execution/domain/nodeExecution.ts',
      ...readdirSync(resolve(ROOT, engineDir))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => `${engineDir}/${name}`),
    ]
    expect(paths.length).toBeGreaterThanOrEqual(12)
    for (const path of paths) {
      const source = read(path)
      expect(nodeEngineBoundaryViolations(source), path).toEqual([])
    }
  })

  test('negative fixture: a legacy scheduler import is rejected by the same boundary matcher', () => {
    const fixture = "import { runOneNode } from '@/services/scheduler'"
    expect(nodeEngineBoundaryViolations(fixture)).toContain('legacy-scheduler-import')
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

  test('agent and workgroup clarify opening uses the collaboration required port', () => {
    const port = read(
      'packages/backend/src/modules/task-execution/application/ports/collaborationNodeGate.ts',
    )
    const composition = read(
      'packages/backend/src/modules/task-execution/composition/nodeExecution.ts',
    )
    const mechanics = read(
      'packages/backend/src/modules/task-execution/composition/nodeMechanics.ts',
    )
    expect(port).toContain('openAgentClarify')
    expect(composition).toContain('openAgentClarify(request)')
    expect(mechanics.match(/collaboration\.openAgentClarify\(/g)).toHaveLength(3)
    expect(mechanics).not.toMatch(/await\s+createClarifyRound\s*\(/)
  })

  test('the production DAG imports the gateway and the legacy selector symbol is extinct', () => {
    const scope = read('packages/backend/src/modules/task-execution/composition/taskDagScope.ts')
    const scheduler = read('packages/backend/src/services/scheduler.ts')
    expect(scope).toContain("import { executeNode } from './nodeExecution'")
    expect(scope.match(/\bexecuteNode\(/g)).toHaveLength(1)
    expect(scope).not.toMatch(/\brunOneNode\s*\(/)
    expect(scope).not.toMatch(/import\s*\{[^}]*\brunOneNode\b/)
    expect(scheduler).not.toMatch(/export async function runOneNode\b/)
  })

  test('workgroup and dynamic hosts enter the typed agent lane at all four production sites', () => {
    const application = read(
      'packages/backend/src/modules/task-execution/composition/taskEngineApplication.ts',
    )
    const scheduler = read('packages/backend/src/services/scheduler.ts')
    expect(application.match(/buildNodeExecutionWorkgroupHooks\(state\)/g)).toHaveLength(4)
    expect(application).not.toContain('buildWorkgroupHooks')
    expect(scheduler).not.toMatch(/export function buildWorkgroupHooks\b/)
    expect(scheduler).not.toMatch(/\bfunction runHostNode\b/)
  })

  test('composition has only the explicit W2-D wrapper bridge back to legacy scheduler', () => {
    const composition = read(
      'packages/backend/src/modules/task-execution/composition/nodeExecution.ts',
    )
    const legacyImport = composition.match(
      /import\s*\{([^}]*)\}\s*from '@\/services\/scheduler'/,
    )
    expect(legacyImport).not.toBeNull()
    const names = (legacyImport?.[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .sort()
    expect(names).toEqual(['runWrapperFanoutNode', 'runWrapperGitNode', 'runWrapperLoopNode'])
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

function nodeEngineBoundaryViolations(source: string): string[] {
  return [
    source.includes('@/services/scheduler') ? 'legacy-scheduler-import' : null,
    /(?:from\s*|import\s*\()\s*['"][^'"]*services\//.test(source) ? 'services-import' : null,
    /(?:from\s*|import\s*\()\s*['"][^'"]*composition\//.test(source) ? 'composition-import' : null,
    /\b(?:DbClient|SchedulerState|LegacyTaskMechanicsState|TaskMechanicsState|RunTaskOptions)\b/.test(
      source,
    )
      ? 'infrastructure-bag'
      : null,
    source.includes("from '@/db/schema'") ? 'raw-schema-import' : null,
  ].filter((value): value is string => value !== null)
}

function engineFiles(directory: string): string[] {
  return readdirSync(resolve(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? engineFiles(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('RFC-334 node-executor owner boundary', () => {
  test('domain and every node engine file avoid legacy scheduler and infrastructure bags', () => {
    const engineDir = 'packages/backend/src/modules/task-execution/engine'
    const paths = [
      'packages/backend/src/modules/task-execution/domain/nodeExecution.ts',
      ...engineFiles(engineDir),
    ]
    expect(paths.length).toBeGreaterThanOrEqual(40)
    for (const path of [
      'code-host-call/runCodeHostCallNode',
      'input/runInputNode',
      'output/runOutputNode',
      'review/reviewNodeExecutor',
      'clarify/settleIdleClarify',
      'clarify-cross-agent/runCrossClarifyNode',
      // RFC-404: the call-workflow / call-workgroup executors and their shared body.
      'call-workflow/callWorkflowNodeExecutor',
      'call-workgroup/callWorkgroupNodeExecutor',
      'shared/child-call/runChildCallNode',
      'shared/child-call/launchChildCall',
      'shared/child-call/childCallWatch',
      // RFC-405 / RFC-406: the agent-single executor and its two lane bodies.
      'agent-single/agentSingleNodeExecutor',
      'agent-single/runAgentSingleNode',
      'agent-single/runWorkgroupHost',
    ])
      expect(paths).toContain(`${engineDir}/node/${path}.ts`)
    expect(paths).toContain(`${engineDir}/node/script/runScriptNode.ts`)
    expect(paths).toContain(`${engineDir}/node/script/runOneScriptAttempt.ts`)
    expect(paths).toContain(`${engineDir}/node/shared/resolveMergeConflicts.ts`)
    expect(paths).toContain(`${engineDir}/kernel/assembly.ts`)
    expect(paths).toContain(`${engineDir}/kernel/nodeRunLedger.ts`)
    for (const path of paths) {
      const source = read(path)
      expect(nodeEngineBoundaryViolations(source), path).toEqual([])
    }
  })

  test('negative fixture: a legacy scheduler import is rejected by the same boundary matcher', () => {
    const fixture = "import { runOneNode } from '@/services/scheduler'"
    expect(nodeEngineBoundaryViolations(fixture)).toContain('legacy-scheduler-import')
  })

  test('nested engine sources reject services, composition and TaskMechanicsState', () => {
    for (const [source, violation] of [
      ["import { helper } from '@/services/helper'", 'services-import'],
      ["import { helper } from '../../../composition/helper'", 'composition-import'],
      ['function execute(state: TaskMechanicsState) {}', 'infrastructure-bag'],
    ]) {
      expect(nodeEngineBoundaryViolations(source!), 'engine/node/script/nested.ts').toContain(
        violation!,
      )
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

  test('agent and workgroup clarify opening uses the collaboration required port', () => {
    const port = read(
      'packages/backend/src/modules/task-execution/application/ports/collaborationNodeGate.ts',
    )
    const composition = read(
      'packages/backend/src/modules/task-execution/composition/nodeExecution.ts',
    )
    // RFC-405 / RFC-406: both lanes of the agent executor open their rounds through its collaboration
    // port; the binding forwards to the collaboration runtime, which satisfies the required gate port.
    const host = read(
      'packages/backend/src/modules/task-execution/engine/node/agent-single/runWorkgroupHost.ts',
    )
    const agentNode = read(
      'packages/backend/src/modules/task-execution/engine/node/agent-single/runAgentSingleNode.ts',
    )
    const agentBinding = read(
      'packages/backend/src/modules/task-execution/composition/agentNodeExecution.ts',
    )
    expect(port).toContain('openAgentClarify')
    expect(agentBinding).toContain(
      'state.opts.collaborationRuntime satisfies CollaborationNodeGatePort',
    )
    expect(composition).toContain(
      "'agent-single': new AgentSingleNodeExecutor(createAgentNodeExecutionPorts(state)),",
    )
    expect(composition).not.toContain('legacyHostPort')
    expect(host.match(/collaboration\.openAgentClarify\(/g)).toHaveLength(1)
    expect(agentNode.match(/collaboration\.openAgentClarify\(/g)).toHaveLength(2)
    expect(agentBinding.match(/collaboration\(\)\.openAgentClarify\(/g)).toHaveLength(1)
    for (const source of [host, agentNode, agentBinding, composition])
      expect(source).not.toMatch(/await\s+createClarifyRound\s*\(/)
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
    expect(
      application.match(
        /buildNodeExecutionWorkgroupHooks\(\s*state,\s*runtimeComponents\.wrapperRuntimeFactory/g,
      ),
    ).toHaveLength(4)
    expect(application).not.toContain('buildWorkgroupHooks')
    expect(scheduler).not.toMatch(/export function buildWorkgroupHooks\b/)
    expect(scheduler).not.toMatch(/\bfunction runHostNode\b/)
  })

  test('composition owns the closed W2-D runtime and has no legacy scheduler bridge', () => {
    const composition = read(
      'packages/backend/src/modules/task-execution/composition/nodeExecution.ts',
    )
    const wrapperComposition = read(
      'packages/backend/src/modules/task-execution/composition/wrapperRuntime.ts',
    )
    const runtime = read(
      'packages/backend/src/modules/task-execution/engine/wrapper/wrapperRuntime.ts',
    )
    expect(composition).not.toContain('@/services/scheduler')
    expect(composition).toContain('wrapperRuntimeFactory(state)')
    expect(composition).not.toContain('composeWrapperRuntime')
    expect(wrapperComposition).toContain('new WrapperRuntime')
    expect(wrapperComposition).toContain("'wrapper-loop': new LoopStrategy")
    expect(wrapperComposition).toContain("'wrapper-git': new GitStrategy")
    expect(wrapperComposition).toContain("'wrapper-fanout': new FanoutStrategy")
    expect(runtime).toContain('for (const kind of WRAPPER_NODE_KINDS)')
    expect(runtime).not.toMatch(/\bdefault\s*:/)
  })
})

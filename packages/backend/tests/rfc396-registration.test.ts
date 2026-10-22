import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTemplate } from '@agent-workflow/shared'
import { employeeTypePackageDescriptorSchema } from '@/modules/digital-employee/domain/model'
import { graphEmployeeTypePackage } from '@/modules/development-automation/application/graph-development/employeeType'
import {
  GRAPH_BUILTIN_AGENTS,
  GRAPH_BUILTIN_WORKFLOWS,
} from '@/modules/development-automation/application/graph-development/builtinResources'
import { inspectExecutionContractWorkflowDefinition } from '@/modules/resource-catalog/domain/executionContractWorkflow'
import { graphExecutionContractRegistrations } from '@/modules/development-automation/application/graph-development/toolContracts'
import { graphEmployeeRuntimeCodec } from '@/modules/development-automation/application/graph-development/employeeCodec'
import { describeEachProvider } from './helpers/eachProvider'
import { employeeAutomationFixture } from './helpers/daemonEmployeeAutomationBundle'
import { INTERPRETER_SPEC } from '@/modules/task-execution/infrastructure/local/scriptRun'

test('graph type has six responsibilities while view combinations are selected within design', () => {
  const type = employeeTypePackageDescriptorSchema.parse(
    JSON.parse(graphEmployeeTypePackage.descriptorJson),
  )
  expect(type.typeRef).toEqual({ typeId: 'graph-development', revision: 1 })
  expect(type.authoringManifest.workItems).toHaveLength(6)
  expect(type.reactionRules.map((rule) => rule.workItemRef)).toContain('verify-change')
  const designer = GRAPH_BUILTIN_AGENTS.find((agent) =>
    agent.definition.outputs.includes('design-model'),
  )!
  expect(designer.definition.bodyMd).toContain('不得固定输出')
  for (const workflow of GRAPH_BUILTIN_WORKFLOWS) {
    for (const node of workflow.definition.definition.nodes) {
      if ('promptTemplate' in node && typeof node.promptTemplate === 'string')
        expect(
          parseTemplate(node.promptTemplate).filter((segment) => segment.kind === 'invalid'),
        ).toEqual([])
    }
    const gates = workflow.item === 'review-design' ? ['review' as const] : ['clarify' as const]
    expect(
      inspectExecutionContractWorkflowDefinition(
        workflow.definition.definition,
        'agent-result',
        gates,
      ).ok,
    ).toBe(true)
    expect(inspectExecutionContractWorkflowDefinition(workflow.definition.definition).ok).toBe(
      false,
    )
  }
})

test('intake records temporary and repository files with their original references and selected branch', () => {
  const result = JSON.parse(
    graphEmployeeRuntimeCodec.buildInitialCaseJson(
      JSON.stringify({
        caseRef: 'case',
        employeeRef: { id: 'employee', revision: 1 },
        workScopeJson: JSON.stringify({ kind: 'task' }),
        intake: {
          target: { repositoryId: 'repository' },
          kind: 'body-and-files',
          body: '原始需求',
          typeOptions: { 'working-branch': 'feature', 'publication-branch': 'published-feature' },
          uploads: [
            {
              blobRef: 'blob',
              sha256: '1'.repeat(64),
              originalName: 'spec.md',
              placement: 'temporary',
              targetPath: null,
            },
          ],
        },
      }),
    ),
  )
  const context = JSON.parse(result.primaryContextJson)
  expect(context.request.body).toBe('原始需求')
  expect(context.request.targetBranch).toBe('feature')
  expect(context.request.publicationBranch).toBe('published-feature')
  expect(context.request.uploads[0]).toEqual({
    artifactRef: 'employee-input:blob',
    sha256: '1'.repeat(64),
    originalName: 'spec.md',
    placement: 'temporary',
    targetPath: null,
  })
})

describeEachProvider('RFC-396 registered graph resources and legacy compatibility', (harness) => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })
  test('the actual session bundle loads both types and publishes a reusable graph job', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc396-registration-'))
    homes.push(home)
    const f = employeeAutomationFixture(harness, home)
    await f.employee.platformTools.load()
    await f.employee.module.maintenance.ready()
    await f.employee.initializeGraph()
    const tools = JSON.parse(
      f.employee.platformTools.listJson(
        JSON.stringify({ typeId: 'graph-development', revision: 1 }),
        'design-and-clarify',
      ),
    )
    expect(tools).toHaveLength(1)
    expect(tools[0].content.implementation.kind).toBe('workflow')
    const legacy = employeeTypePackageDescriptorSchema.parse(
      JSON.parse(
        (await import('@/modules/development-automation/composition/employeeTypePackage'))
          .developmentEmployeeTypePackage.descriptorJson,
      ),
    )
    expect(
      (await f.employee.module.queries.listTypes()).find(
        (type) => type.typeRef.typeId === 'development',
      ),
    ).toEqual(legacy)
    await f.employee.initializeGraph()
    expect(f.employee.graph).toBeDefined()
  }, 30_000)
})

test('implementation contract is shared by Agent, Workflow and Program with explicit transports', () => {
  const registration = graphExecutionContractRegistrations.find(
    (item) => item.contractRef.contractId === 'graph-development.implement-change',
  )!
  const guide = JSON.parse(registration.guideJson)
  expect(guide.allowedExecutorKinds).toEqual(['agent', 'workflow', 'program'])
  expect(guide.transports.program.inputLocation).toBe('DIGITAL_EMPLOYEE_INPUT_JSON')
  expect(guide.transports.workflow.outputPort).toBe('agent-result')
  const result = {
    summary: 'Ready',
    result: {
      traceProposals: [],
      testRefs: [],
      limitations: ['Explicitly incomplete'],
      deliveryContent: { commitMessage: 'candidate', title: 'candidate', description: '' },
    },
  }
  expect(JSON.parse(registration.validateOutputJson!(JSON.stringify(result)))).toEqual(result)
  expect(() => registration.validateOutputJson!('{"summary":"everything passed"}')).toThrow()
})

test('native review receipt script uses the Node ESM mode and actual single-newline input delimiter', async () => {
  const workflow = GRAPH_BUILTIN_WORKFLOWS.find((item) => item.item === 'review-design')!
  const node = workflow.definition.definition.nodes.find((node) => node.id === 'receipt')!
  if (node.kind !== 'script' || node.language !== 'node' || typeof node.script !== 'string')
    throw new Error('missing review receipt script')
  const root = mkdtempSync(join(tmpdir(), 'rfc396-review-script-'))
  const spec = INTERPRETER_SPEC[node.language]
  const path = join(root, `script.${spec.ext}`)
  writeFileSync(path, node.script)
  try {
    const proc = Bun.spawn(spec.argv(spec.binary, path), {
      env: {
        ...process.env,
        AW_PORT_PROMPT:
          'Context\nINPUT_JSON\n' +
          JSON.stringify({ materials: { basis: { id: 'basis', digest: 'digest' } } }),
        AW_PORT_DECISION_META: JSON.stringify({ decision: 'approved' }),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({
      result: { basisId: 'basis', basisDigest: 'digest', receipt: { decision: 'approved' } },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

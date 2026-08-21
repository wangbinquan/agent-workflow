import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import {
  agentExecutionContractKeys,
  emptyAgent,
  withAgentExecutionContractKeys,
  withAgentExecutionContractsAndPorts,
} from '../src/components/AgentForm'
import { buildResponsibilityGraphLayout } from '../src/components/digital-employees/ResponsibilityGraph'
import type { EmployeeTypePackage } from '../src/components/digital-employees/types'
import { executionContractProgramStarter } from '../src/components/execution-contracts/ExecutionContractGuidePanel'

const read = (file: string): string =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', file), 'utf8')

describe('RFC-310 Digital Employee OS information architecture', () => {
  test('tool configuration is anchored to a selected work item on the fixed graph', () => {
    const typePage = read('routes/digital-employees.$typeRef.tsx')
    const graph = read('components/digital-employees/ResponsibilityGraph.tsx')

    expect(typePage).toContain("label: zh ? '工具箱' : 'Toolbox'")
    expect(typePage).toContain('<ToolboxPanel')
    expect(typePage).toContain('item={selectedItem}')
    expect(typePage).toContain('typeName={localized(type.displayName, language)}')
    expect(typePage).toContain('数字员工 / ${props.typeName} / ${localized(props.item.label')
    expect(typePage).toContain("zh ? '增加工具' : 'Add tool'")
    expect(typePage).toContain('props.contract?.allowedToolKinds ?? []')
    expect(typePage).not.toContain("? ['agent', 'workflow', 'program']")
    expect(typePage).toContain('parameterValues: parsedParameters')
    expect(typePage).toContain("search={{ view: 'toolbox', workItem:")
    expect(typePage).toContain("search: { ...search, view: 'toolbox', workItem }")
    expect(typePage).not.toContain('stageId')
    expect(graph).toContain('item.nextWorkItemRefs')
    expect(graph).toContain('employee-graph__edge--loop')
    expect(graph).toContain('employee-graph__dispatch-trunk')
    expect(graph).toContain('employee-graph__dispatch-branch')
    expect(graph).toContain('employee-graph-lane-label')
    expect(graph).toContain('data-from={source.item.workItemRef}')
    expect(graph).not.toContain('onConnect')
  })

  test('responsibility graph separates the event hub and parallel reaction duties', () => {
    const text = (value: string) => ({ 'zh-CN': value, 'en-US': value })
    const item = (
      workItemRef: string,
      responsibilityLaneId: string,
      order: number,
      nextWorkItemRefs: string[],
    ) => ({
      workItemRef,
      regionId: 'care',
      responsibilityLaneId,
      order,
      label: text(workItemRef),
      description: text(workItemRef),
      workContractRef: { contractId: workItemRef, version: 1 },
      materialSummary: text(workItemRef),
      completionStandard: text(workItemRef),
      nodeKind: 'system' as const,
      collaborationContractId: null,
      toolRoleGroups: [],
      nextWorkItemRefs,
    })
    const type = {
      authoringManifest: {
        lifecycleRegions: [
          {
            regionId: 'care',
            label: text('MR 看护与修绿'),
            description: text('按事件响应'),
            order: 0,
            responsibilityLanes: [
              {
                laneId: 'attention',
                label: text('MR 事件入口'),
                description: text('事件分发'),
                order: 0,
                kind: 'spine',
              },
              {
                laneId: 'review',
                label: text('检视意见'),
                description: text('检视闭环'),
                order: 10,
                kind: 'branch',
              },
              {
                laneId: 'pipeline',
                label: text('流水线门禁'),
                description: text('流水线闭环'),
                order: 20,
                kind: 'branch',
              },
            ],
          },
        ],
        workItems: [
          item('observe', 'attention', 10, ['review-classify', 'pipeline-collect']),
          item('review-classify', 'review', 20, ['review-repair']),
          item('review-repair', 'review', 30, ['observe']),
          item('pipeline-collect', 'pipeline', 40, ['pipeline-classify']),
          item('pipeline-classify', 'pipeline', 50, ['observe']),
        ],
      },
    } as unknown as EmployeeTypePackage

    const layout = buildResponsibilityGraphLayout(type)
    const byRef = new Map(layout.nodes.map((node) => [node.item.workItemRef, node]))
    const observe = byRef.get('observe')!
    const reviewClassify = byRef.get('review-classify')!
    const reviewRepair = byRef.get('review-repair')!
    const pipelineCollect = byRef.get('pipeline-collect')!

    expect(layout.bands[0]!.lanes.map((lane) => lane.id)).toEqual([
      'attention',
      'review',
      'pipeline',
    ])
    expect(observe.x).toBeGreaterThan(reviewClassify.x)
    expect(reviewClassify.y).toBe(reviewRepair.y)
    expect(reviewClassify.x).toBeLessThan(reviewRepair.x)
    expect(pipelineCollect.y).toBeGreaterThan(reviewClassify.y)
  })

  test('platform execution contracts guide and gate Agent or Script configuration', () => {
    const typePage = read('routes/digital-employees.$typeRef.tsx')
    const agentForm = read('components/AgentForm.tsx')

    expect(typePage).toContain(
      "`/api/execution-contracts/${encodeURIComponent(contractKey ?? '')}`",
    )
    expect(typePage).toContain('<ExecutionContractGuidePanel')
    expect(typePage).toContain('/agent-candidates`')
    expect(typePage).toContain("validationReceipt.status === 'valid'")
    expect(typePage).not.toContain('BUILTIN_AGENT_CONTRACTS')
    expect(typePage).not.toContain('development.analyze-implement@1')
    expect(typePage).toContain("source.includes('TODO_IMPLEMENT_CONTRACT')")
    expect(typePage).toContain('检查契约并加入工具箱')
    expect(agentForm).toContain('<ExecutionContractPicker')
    expect(agentForm).toContain("enabled={tab === 'ports'}")
    expect(agentForm).toContain('managedPortNames=')
    expect(agentForm.indexOf('<ExecutionContractPicker')).toBeLessThan(
      agentForm.indexOf('<InputsEditor'),
    )

    expect(
      agentExecutionContractKeys({
        executionContracts: [
          { contractId: 'development.prepare-materials', version: 1 },
          { contractId: 'development.prepare-materials', version: 1 },
          { contractId: '', version: 1 },
          'invalid',
        ],
      }),
    ).toEqual(['development.prepare-materials@1'])
    expect(
      withAgentExecutionContractKeys({ preserved: true }, [
        'development.prepare-materials@1',
        'invalid',
      ]),
    ).toEqual({
      preserved: true,
      executionContracts: [{ contractId: 'development.prepare-materials', version: 1 }],
    })

    const linked = withAgentExecutionContractsAndPorts(
      {
        ...emptyAgent(),
        outputs: ['ordinary', 'agent-result', 'agent-result'],
        outputKinds: { ordinary: 'markdown', 'agent-result': 'signal' },
        outputWrapperPortNames: { ordinary: 'published', 'agent-result': 'forbidden' },
        branchPorts: ['ordinary', 'agent-result'],
      },
      ['development.prepare-materials@1'],
    )
    expect(linked.outputs).toEqual(['ordinary', 'agent-result'])
    expect(linked.outputKinds).toEqual({ ordinary: 'markdown' })
    expect(linked.outputWrapperPortNames).toEqual({ ordinary: 'published' })
    expect(linked.branchPorts).toEqual(['ordinary'])

    const switched = withAgentExecutionContractsAndPorts(linked, [
      'development.analyze-implement@1',
    ])
    expect(switched.outputs).toEqual(['ordinary', 'agent-result'])
    expect(agentExecutionContractKeys(switched.frontmatterExtra)).toEqual([
      'development.analyze-implement@1',
    ])

    const unlinked = withAgentExecutionContractsAndPorts(switched, [])
    expect(unlinked.outputs).toEqual(['ordinary'])
    expect(agentExecutionContractKeys(unlinked.frontmatterExtra)).toEqual([])

    for (const runtime of ['bash', 'node', 'python'] as const) {
      const starter = executionContractProgramStarter(runtime)
      expect(starter).toContain('AW_PORT_CONTRACT_INPUT')
      expect(starter).toContain('AW_PORT_FILE_CONTRACT_INPUT')
      expect(starter).toContain('TODO_IMPLEMENT_CONTRACT')
      expect(starter).toContain('contextPatches')
      expect(starter).toContain('effectSuggestions')
      expect(starter).toContain('artifactRefs')
    }
  })

  test('work intake and runtime are first-class routes in the unified task surface', () => {
    const create = read('routes/employee-cases.new.tsx')
    const detail = read('routes/employee-cases.$caseId.tsx')

    expect(create).toContain("path: '/tasks/employee-cases/new'")
    expect(create).toContain("'body-and-files'")
    expect(create).toContain("'external-id'")
    expect(create).toContain('targetPath')
    expect(detail).toContain("path: '/tasks/employee-cases/$caseId'")
    expect(detail).toContain('<ResponsibilityGraph')
    expect(detail).toContain('mode="runtime"')
    expect(detail).toContain("zh ? '事件队列' : 'Event queue'")
    expect(detail).toContain("zh ? '员工协作' : 'Employee collaboration'")
    expect(detail).toContain('/api/employee-cases/${encodeURIComponent(caseId)}/resume')
    expect(detail).toContain("? '已处理，继续工作'")
    expect(detail).toContain('contextFacts(registration, context.state, language)')
    expect(detail).toContain('registration?.projectionFields.length')
    expect(detail).not.toContain("typeId === 'development.")
    expect(detail).toContain('查看完整技术记录')
    expect(detail).not.toContain('title={context.typeId}')
    expect(detail).not.toContain('· {caseId}')
    expect(detail).toContain('下一步：等待关注对象发生变化')
    expect(detail).toContain('businessStateLabel(binding.state, zh)')
    expect(detail).toContain("? '工作事件'")
  })

  test('employee setup keeps the next action on the same page and supports later edits', () => {
    const typePage = read('routes/digital-employees.$typeRef.tsx')

    expect(typePage).toContain('下一步：给必需工作项增加工具')
    expect(typePage).toContain('下一步：先准备岗位模板')
    expect(typePage).toContain('onClick={() => openEditor(employee)}')
    expect(typePage).toContain('保存并发布新版本')
    expect(typePage).toContain("search={{ view: 'jobs' }}")
  })

  test('Event Center is global and retry settings have one Limits authority', () => {
    const events = read('routes/events.tsx')
    const settings = read('routes/settings.tsx')

    expect(events).toContain("title={zh ? '事件中心' : 'Event Center'}")
    expect(events).toContain("{zh ? 'Webhook 推送来源' : 'Webhook push sources'}")
    expect(settings).not.toContain("| 'digitalEmployee'")
    expect(settings).not.toContain('DigitalEmployeePolicyTab')
    expect(settings).toContain('defaultNodeRetries')
    expect(settings).toContain('sessionRestartBudget')
    expect(settings).toContain('limitsSharedRetryTitle')
  })

  test('task actions and every digital employee surface use the shared page spacing', () => {
    const tasks = read('routes/tasks.tsx')
    const styles = read('styles.css')
    const zh = read('i18n/zh-CN.ts')
    const routes = [
      'routes/digital-employees.tsx',
      'routes/digital-employees.$typeRef.tsx',
      'routes/employee-cases.new.tsx',
      'routes/employee-cases.$caseId.tsx',
    ]

    expect(tasks).not.toContain('className="page-header__actions"')
    expect(zh).toContain("newButton: '新建编排任务'")
    for (const route of routes) expect(read(route)).toContain('digital-employee-surface__body')
    expect(styles).toMatch(/\.digital-employee-surface__body\s*{[^}]*padding: 0 22px 22px/s)
    expect(styles).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.digital-employee-surface__body\s*{[^}]*padding: 0 16px 16px/,
    )
  })
})

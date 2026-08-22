import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import {
  agentExecutionContractKeys,
  emptyAgent,
  withAgentExecutionContractKeys,
  withAgentExecutionContractsAndPorts,
} from '../src/components/AgentForm'
import { executionContractProgramStarter } from '../src/components/execution-contracts/ExecutionContractGuidePanel'

const read = (file: string): string =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', file), 'utf8')

describe('RFC-310 Digital Employee OS information architecture', () => {
  test('tool configuration is anchored to a selected work item on the fixed graph', () => {
    const typePage = read('routes/digital-employees.$typeRef.tsx')
    const graph = read('components/digital-employees/ResponsibilitySwimlaneMap.tsx')

    expect(typePage).toContain("label: zh ? '工具箱' : 'Toolbox'")
    expect(typePage).toContain('<div className="employee-toolbox-workspace">')
    expect(typePage).toContain('<ResponsibilitySwimlaneMap')
    expect(typePage).not.toContain('<ResponsibilityGraph')
    expect(typePage).toContain('<ToolboxPanel')
    expect(typePage).toContain('item={selectedItem}')
    expect(typePage).toContain('data-testid="employee-toolbox-duty-dialog"')
    expect(typePage).toContain('open={selectedItem !== null}')
    expect(typePage).toContain("search: { view: 'toolbox' }")
    expect(typePage).toContain('`Configure duty: ${localized(selectedItem.label, language)}`')
    expect(typePage).not.toContain('数字员工 / ${props.typeName} / ${localized(props.item.label')
    expect(typePage).toContain("zh ? '增加工具' : 'Add tool'")
    expect(typePage).toContain('props.contract?.allowedToolKinds ?? []')
    expect(typePage).not.toContain("? ['agent', 'workflow', 'program']")
    expect(typePage).toContain('parameterValues: parsedParameters')
    expect(typePage).toContain("search={{ view: 'toolbox', workItem:")
    expect(typePage).toContain("search: { view: 'toolbox', workItem }")
    expect(typePage).not.toContain('stageId')
    expect(graph).toContain('item.nextWorkItemRefs')
    expect(graph).toContain('employee-toolbox-region__lanes')
    expect(graph).toContain('employee-toolbox-lane')
    expect(graph).toContain("'可选能力'")
    expect(graph).toContain("? '工具'")
    expect(graph).toContain("? '平台'")
    expect(graph).toContain('data-dispatch-route-key={node.key}')
    expect(graph).toContain('employee-toolbox-card--active')
    expect(typePage).toContain('employee-runtime-dispatch')
    expect(typePage).toContain('增加错误类型')
    expect(typePage).toContain('未配置：这名数字员工不会启用该泳道，也不会订阅对应事件。')
    expect(typePage).toContain('可选能力 · 配置后启用')
    expect(typePage).toContain('启用本泳道后必填')
    expect(typePage).toContain('不启用这项能力')
    expect(typePage).toContain('不启用员工协同')
    expect(graph).not.toContain('onConnect')

    const styles = read('styles.css')
    expect(styles).not.toContain('.employee-graph')
  })

  test('the shared swimlane map keeps parallel duties separate and expands typed repairs', () => {
    const graph = read('components/digital-employees/ResponsibilitySwimlaneMap.tsx')
    const styles = read('styles.css')

    expect(graph).toContain('region.responsibilityLanes')
    expect(graph).toContain('.sort(')
    expect(graph).toContain('includedLaneIds.has(item.responsibilityLaneId)')
    expect(graph).toContain('laneDispatchNodes')
    expect(graph).toContain('replacedDestinationRefs')
    expect(graph).toContain('P{node.priority}')
    expect(graph).toContain('props.cardState?.(item)')
    expect(styles).toContain(
      'grid-template-columns: repeat(var(--employee-lane-columns, 1), minmax(0, 168px))',
    )
    expect(styles).toContain('justify-content: start')
    expect(styles).not.toContain(
      '.employee-toolbox-region--branching .employee-toolbox-lane__axis::before',
    )
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
    const create = read('components/task-creation/TaskCreationSubjectDescriptorContract.tsx')
    const repositorySpace = read('components/task-creation/TaskCreationRepositorySpace.tsx')
    const detail = read('routes/employee-cases.$caseId.tsx')
    const wizard = read('routes/tasks.new.tsx')
    const router = read('router.tsx')
    const shell = read('components/task-creation/TaskCreationWizardShell.tsx')
    const host = read('components/task-creation/TaskCreationWizardHost.tsx')

    expect(create).not.toContain("path: '/tasks/employee-cases/new'")
    expect(router).not.toContain('employee-cases.new')
    expect(router).not.toContain('/tasks/employee-cases/new')
    expect(create).toContain("'body-and-files'")
    expect(create).toContain("'external-id'")
    expect(create).toContain('targetPath')
    expect(create).toContain('fixedRepositoryId')
    expect(create).not.toContain('目标仓库已由数字员工绑定')
    expect(create).toContain('fixedRepositoryId ?? target[field.fieldRef]')
    expect(create).toContain('<TaskCreationContractFields')
    expect(create).toContain('<TaskCreationRepositorySpace')
    expect(repositorySpace).toContain('<RepoSourceList')
    expect(create).toContain('disabled')
    expect(create).toContain('groupLayout.data?.repos')
    expect(create).toContain('effectiveTarget')
    expect(create).not.toContain('<Stepper')
    expect(create).toContain("{ key: 'mode', title: t('taskWizard.stepMode') }")
    expect(create).toContain("{ key: 'space', title: t('taskWizard.stepSpace') }")
    expect(create).toContain("{ key: 'content', title: t('taskWizard.stepContent') }")
    expect(create).toContain("{ key: 'confirm', title: t('taskWizard.stepConfirm') }")
    expect(create).toContain('data-testid="wizard-summary"')
    expect(create).toContain('data-testid="wizard-launch"')
    expect(create).toContain('<TaskCreationContractFrame')
    expect(create).not.toContain('<TaskCreationKindPicker')
    expect(create).not.toContain('<TaskCreationWizardShell')
    expect(shell).toContain('data-testid="task-wizard"')
    expect(host).toContain('<Stepper')
    expect(host).toContain('<TaskCreationKindPicker')
    expect(host).toContain('<TaskCreationWizardShell')
    expect(wizard).not.toContain("to: '/tasks/employee-cases/new'")
    expect(wizard).not.toContain('<TaskCreationKindPicker')
    expect(wizard).not.toContain("navigate({ to: '/tasks/new', search: { kind: next } })")
    expect(detail).toContain("path: '/tasks/employee-cases/$caseId'")
    expect(detail).toContain('<ResponsibilitySwimlaneMap')
    expect(detail).toContain('dispatchNodes={runtimeDispatchNodes}')
    expect(detail).toContain('cardState={runtimeCardState}')
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
    expect(detail).toContain("zh ? '员工工作时间线' : 'Employee work timeline'")
    expect(detail).toContain('data-testid="employee-work-timeline"')
    expect(detail).toContain('inputContextRefsJson')
    expect(detail).toContain('outputJson')
  })

  test('employee setup keeps the next action on the same page and supports later edits', () => {
    const typePage = read('routes/digital-employees.$typeRef.tsx')
    const map = read('components/digital-employees/ResponsibilitySwimlaneMap.tsx')
    const styles = read('styles.css')

    expect(typePage).toContain('下一步：给必需工作项增加工具')
    expect(typePage).toContain('下一步：先准备岗位模板')
    expect(typePage).toContain('onClick={() => openEditor(employee)}')
    expect(typePage).toContain("? '保存'")
    expect(typePage).not.toContain("label={zh ? '工作状态'")
    expect(typePage).not.toContain("? '工作中'")
    expect(typePage).toContain("search={{ view: 'jobs' }}")
    expect(typePage).toContain('job-template-detail-editor')
    expect(typePage).toContain('data-testid="employee-job-identity-dialog"')
    expect(typePage).toContain('data-testid="employee-job-duty-dialog"')
    expect(typePage).toContain("'创建并配置职责'")
    expect(typePage).toContain('const createDraft = useMutation')
    expect(typePage).toContain('defaultToolBindings: []')
    expect(typePage).toContain('setEditingJob(draft)')
    expect(typePage).toContain("{zh ? '基本信息' : 'Basic information'}")
    expect(typePage).not.toContain('employee-job-editor__identity')
    expect(styles).not.toContain('.employee-job-editor__identity')
    expect(styles).toContain('.employee-toolbox-card--configured')
    expect(styles).toContain('.employee-toolbox-card--missing')
    expect(styles).toContain('.employee-toolbox-card--fan-out')
    expect(styles).toContain('.employee-toolbox-card__stack-layer--middle')
    expect(styles).toContain('.employee-toolbox-card__stack-layer--back')
    expect(map).toContain('const fanOutDestinationRefs = new Set(')
    expect(map).toContain('source.orderedDispatchAuthoring?.destinationWorkItemRefs')
    expect(map).not.toContain("item.inputMultiplicity === 'collection'")
    expect(map).toContain('employee-toolbox-card--fan-out')
    expect(map).not.toContain('repair-feedback')
    expect(map).toContain('employee-toolbox-region--${lanes.length > 1')
    expect(map).toContain('employee-toolbox-lane__axis')
    expect(map).toContain("? '主泳道'")
    expect(map).toContain("? '职责泳道'")
    expect(styles).toContain(
      'grid-template-columns: var(--employee-lane-label-width) 20px minmax(0, 1fr)',
    )
    expect(styles).not.toContain(
      '.employee-toolbox-region--branching .employee-toolbox-lane__axis::before',
    )
    expect(styles).toContain('.employee-toolbox-card + .employee-toolbox-card::before')
    expect(styles).not.toContain('minmax(min(100%, 210px), 1fr)')
    expect(styles).toContain('minmax(0, 168px)')
    const dutyNameRule = styles.match(/\.employee-toolbox-card strong \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(dutyNameRule).toContain('white-space: normal')
    expect(dutyNameRule).toContain('overflow: visible')
    expect(dutyNameRule).not.toContain('text-overflow: ellipsis')
    expect(styles).toContain(
      '.job-template-detail-editor > header > .employee-summary-card__actions',
    )
    expect(styles).toContain('.employee-duty-dialog .execution-contract-guide > *')
    expect(styles).toContain(
      'grid-template-columns: minmax(0, 0.8fr) minmax(0, 1fr) minmax(0, 1.2fr)',
    )
    expect(typePage).toContain('requiredMissingWorkItemRefs')
    expect(typePage).toContain("value: 'task'")
    expect(typePage).toContain('GROUP_OPTION_PREFIX')
    expect(typePage).toContain('任务启动时指定仓库')
    expect(typePage).toContain("queryKey: ['digital-employee-outcomes', 'runtime']")
    expect(typePage).toContain("queryKey: ['digital-employee-outcomes', 'legacy']")
    expect(typePage).toContain('data-testid={`digital-employee-outcomes-${employee.id}`}')
    expect(typePage).toContain("zh ? '已合入' : 'Merged'")
    expect(typePage).toContain('data-testid={`digital-employee-create-task-${employee.id}`}')
    expect(typePage).not.toContain("search={{ category: 'digital-employee' }}")
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
    const wizard = read('routes/tasks.new.tsx')
    const host = read('components/task-creation/TaskCreationWizardHost.tsx')
    const create = read('components/task-creation/TaskCreationSubjectDescriptorContract.tsx')
    const digitalEmployees = read('routes/digital-employees.tsx')
    const typePage = read('routes/digital-employees.$typeRef.tsx')
    const styles = read('styles.css')
    const zh = read('i18n/zh-CN.ts')
    const routes = [
      'routes/digital-employees.tsx',
      'routes/digital-employees.$typeRef.tsx',
      'routes/employee-cases.$caseId.tsx',
    ]

    expect(tasks).not.toContain('className="page-header__actions"')
    expect(tasks).not.toContain('tasks-new-digital-employee')
    expect(zh).toContain("newButton: '新建任务'")
    expect(wizard).not.toContain('<TaskCreationKindPicker')
    expect(host).toContain('<TaskCreationKindPicker')
    expect(digitalEmployees).not.toContain('digital-employees-new-task')
    expect(typePage).toContain("search={{ kind: 'digital-employee', employeeId: employee.id }}")
    expect(create).not.toContain('digital-employee-surface__body')
    for (const route of routes) expect(read(route)).toContain('digital-employee-surface__body')
    expect(styles).toMatch(/\.digital-employee-surface__body\s*{[^}]*padding: 0 22px 22px/s)
    expect(styles).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.digital-employee-surface__body\s*{[^}]*padding: 0 16px 16px/,
    )
  })
})

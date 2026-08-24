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
  test('type package upgrades never become a user migration action', () => {
    const typePage = read('routes/digital-employees.$typeRef.tsx')

    for (const retiredSurface of [
      'digital-employee-upgrade-candidates',
      '/upgrade-candidates',
      '/employees/${encodeURIComponent(editing.id)}/upgrade',
      'Upgrade to current version',
      '升级到当前版本',
      'Explicit upgrade',
      '显式升级',
      'legacy-job-template-upgrades',
      'legacy-digital-employee-upgrades',
      'upgradingJob',
    ]) {
      expect(typePage).not.toContain(retiredSurface)
    }
  })

  test('tool configuration is anchored to a selected work item on the fixed graph', () => {
    const typePage = read('routes/digital-employees.$typeRef.tsx')
    const taskDetail = read('routes/employee-cases.$caseId.tsx')
    const graph = read('components/digital-employees/EmployeeCapabilityPanorama.tsx')
    const compatibility = read('components/digital-employees/ResponsibilitySwimlaneMap.tsx')

    expect(typePage).toContain("label: zh ? '工具箱' : 'Toolbox'")
    expect(typePage).toContain('<div className="employee-toolbox-workspace">')
    expect(typePage).toContain('<EmployeeCapabilityPanorama')
    expect(typePage.match(/<EmployeeCapabilityPanorama/g)).toHaveLength(2)
    expect(taskDetail.match(/<EmployeeCapabilityPanorama/g)).toHaveLength(1)
    expect(typePage).toContain("from '@/components/digital-employees/EmployeeCapabilityPanorama'")
    expect(taskDetail).toContain("from '@/components/digital-employees/EmployeeCapabilityPanorama'")
    expect(compatibility).toContain('EmployeeCapabilityPanorama as ResponsibilitySwimlaneMap')
    expect(typePage).not.toContain('<ResponsibilityGraph')
    expect(typePage).toContain('<ToolboxPanel')
    expect(typePage).toContain('item={selectedItem}')
    expect(typePage).toContain('data-testid="employee-toolbox-duty-dialog"')
    expect(typePage).toContain('open={selectedItem !== null}')
    expect(typePage).toContain("search: { view: 'toolbox' }")
    expect(typePage).toContain('`Configure duty: ${localized(selectedItem.label, language)}`')
    expect(typePage).not.toContain('数字员工 / ${props.typeName} / ${localized(props.item.label')
    expect(typePage).toContain("zh ? '增加工具' : 'Add tool'")
    expect(typePage).toContain('selectedRole?.workContractRef ?? props.item.workContractRef')
    expect(typePage).toContain('contract?.allowedToolKinds ?? []')
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
    expect(typePage).not.toContain('配置错误类型列表')
    expect(typePage).not.toContain('增加错误类型')
    expect(typePage).not.toContain('dispatchRouteRefsText')
    expect(typePage).toContain('dispatchRouteDefinitions')
    expect(typePage).toContain('<MultiSelect')
    expect(typePage).toContain('可选能力 · 配置后启用')
    expect(typePage).toContain('启用本泳道后必填')
    expect(typePage).toContain('不启用这项能力')
    expect(typePage).toContain('不启用员工协同')
    expect(graph).not.toContain('onConnect')

    const styles = read('styles.css')
    expect(styles).not.toContain('.employee-graph')
  })

  test('the shared swimlane map keeps parallel duties separate and expands typed repairs', () => {
    const graph = read('components/digital-employees/EmployeeCapabilityPanorama.tsx')
    const styles = read('styles.css')

    expect(graph).toContain('region.responsibilityLanes')
    expect(graph).toContain('.sort(')
    expect(graph).toContain('includedLaneIds.has(item.responsibilityLaneId)')
    expect(graph).toContain('laneDispatchNodes')
    expect(graph).toContain('replacedDestinationRefs')
    expect(graph).toContain('P${node.priority}')
    expect(graph).toContain('props.cardState?.(item)')
    expect(styles).toContain('--employee-tool-card-width: 100px')
    expect(styles).toContain('--employee-tool-card-width: 136px')
    expect(styles).toContain('@container (min-width: 1200px)')
    expect(styles).toContain('--employee-tool-card-height: 56px')
    expect(styles).toContain('--employee-lane-label-width: 100px')
    expect(styles).toContain('justify-content: start')
    expect(styles).not.toContain(
      '.employee-toolbox-region--branching .employee-toolbox-lane__axis::before',
    )
  })

  test('ingress and human-review cards are generic read-only projections', () => {
    const graph = read('components/digital-employees/EmployeeCapabilityPanorama.tsx')
    const display = read('components/digital-employees/ResponsibilityFlowDisplay.tsx')
    const types = read('components/digital-employees/types.ts')
    const typePage = read('routes/digital-employees.$typeRef.tsx')
    const runtime = read('routes/employee-cases.$caseId.tsx')
    const styles = read('styles.css')

    expect(types).toContain('workIngresses: WorkIngress[]')
    expect(types).toContain("configurationSurface: 'task-creation' | 'event-response-rules'")
    expect(types).toContain('reviewedPath?: {')
    expect(types).toContain('planningRoleRef: string')
    expect(types).toContain('workContractRef?: { contractId: string; version: number }')
    expect(graph).toContain("kind: 'ingress'")
    expect(graph).toContain("kind: 'ingress-branch'")
    expect(graph).toContain("kind: 'review-branch'")
    expect(display).toContain('data-work-ingress-ref={props.ingress.ingressRef}')
    expect(display).toContain('data-next-work-item-ref={props.ingress.nextWorkItemRef}')
    expect(display).toContain('data-review-stage="analysis"')
    expect(display).toContain('data-tool-role-ref={props.planningRoleRef}')
    expect(display).toContain('data-tool-slot-ref={props.planningSlotRef}')
    expect(display).toContain('detailText={props.planningPresentation?.compactDetail}')
    expect(display).not.toContain('data-review-stage="implementation"')
    expect(display).toContain('employee-toolbox-review-branch__merged-item')
    expect(display).toContain('employee-toolbox-review-branch__prefix')
    expect(display).toContain('employee-toolbox-review-branch__merge-target')
    expect(display).toContain('data-review-bypass')
    expect(display).toContain('data-review-bypass-join')
    expect(display).not.toContain('employee-toolbox-review-branch__direct-label')
    expect(display).toContain('data-review-option-ref={props.gate.optionRef}')
    expect(graph).toContain('item.humanReview === null')
    expect(graph).toContain('reviewProjectionByWorkItem.set(item.workItemRef')
    expect(graph).toContain("mode: 'conditional' | 'active'")
    expect(graph).toContain('data-capability-phase-id={region.regionId}')
    expect(graph).toContain('data-capability-lane-id={lane.laneId}')
    expect(display).toContain('data-capability-tool-ref=')
    expect(graph).not.toContain("typeId === 'development'")
    expect(graph).not.toContain("ingressRef === 'issue'")
    expect(graph).not.toContain("optionRef === 'review-implementation-plan'")
    expect(typePage).toContain("navigate({ to: '/events', search: { tab: 'subscriptions' } })")
    expect(typePage).toContain(
      "navigate({ to: '/tasks/new', search: { kind: 'digital-employee' } })",
    )
    expect(typePage).toContain("ingress.configurationSurface === 'task-creation'")
    expect(typePage).toContain('reviewOnly={selectedReview !== null}')
    expect(typePage).toContain('selectedToolSlotTarget={selectedToolSlotTarget}')
    expect(typePage).toContain('selectedToolRole?.workContractRef ?? selectedItem?.workContractRef')
    expect(typePage).toContain('candidate.content.roleRef === target.roleRef')
    expect(typePage).toContain('props.item.toolRoleGroups.length > 1')
    expect(typePage).toContain('roleScoped={props.toolRole !== null}')
    expect(typePage).toContain('props.roleScoped && availableRoles.length === 1')
    expect(typePage).toContain('requestedToolRole?.label ?? requestedWorkItem.label')
    expect(typePage).toContain('selectedEditorRole?.description ?? selectedEditorItem.description')
    expect(typePage).toContain('data-testid="employee-review-gate-detail"')
    expect(typePage).toContain('data-testid="employee-job-review-gate-detail"')
    expect(typePage).toContain('不能在这里增加或选择工具')
    expect(runtime).toContain('reviewToolState={runtimeReviewToolState}')
    expect(runtime).toContain("ingress.configurationSurface === 'task-creation'")
    expect(runtime).toContain("projection?.state === 'waiting'")
    expect(runtime).toContain("projection?.state === 'skipped'")
    expect(styles).toContain('.employee-toolbox-card--ingress')
    expect(styles).toContain('.employee-toolbox-ingress-branch__sources')
    expect(styles).toContain('.employee-toolbox-ingress-branch__merge')
    expect(styles).toMatch(
      /\.employee-toolbox-card--source-node \.employee-toolbox-card__kind\s*\{[^}]*font-size:\s*9px/,
    )
    expect(styles).toMatch(
      /\.employee-toolbox-ingress-branch \.employee-toolbox-card--source-node strong\s*\{[^}]*font-size:\s*12px/,
    )
    expect(styles).not.toContain('.employee-toolbox-lane--parallel-ingress {')
    expect(styles).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(styles).toMatch(/\.employee-toolbox-lane__cards\s*\{[^}]*align-items:\s*center/)
    expect(styles).toMatch(
      /\.employee-toolbox-review-branch\s*\{[^}]*border:\s*0[^}]*background:\s*transparent/,
    )
    expect(styles).toMatch(
      /\.employee-toolbox-review-branch__prefix::before\s*\{[^}]*border:\s*1px solid var\(--border\)[^}]*background:\s*var\(--panel\)/,
    )
    expect(styles).toContain('.employee-toolbox-review-branch__bypass')
    expect(styles).toContain('.employee-toolbox-review-branch__bypass-join')
    expect(styles).not.toContain('.employee-toolbox-review-branch__direct-label')
    expect(graph).toContain('new ResizeObserver(measureLaneColumns)')
    expect(graph).toContain('laneColumnCapacityById[lane.laneId] ?? totalColumnSpan')
    expect(graph).not.toContain('Math.min(totalColumnSpan, 5)')
    expect(styles).toContain('--employee-flow-gap: 15px')
    expect(styles).toContain('--employee-flow-arrow-width: 4px')
    expect(styles).toContain('--employee-flow-arrow-height: 6px')
    expect(styles).toContain('--employee-flow-card-clearance: 2px')
    expect(styles).toContain('--employee-flow-stroke-width: 2px')
    expect(styles).toContain('--employee-flow-color:')
    expect(styles).toContain('--employee-flow-target-border-width: 1px')
    expect(styles).toContain('right: calc(100% + var(--employee-flow-target-border-width, 0px))')
    expect(styles).toContain('--employee-review-bypass-entry: 7px')
    expect(styles).toContain('--employee-review-bypass-exit: 8px')
    expect(styles).toContain('left: calc(0px - var(--employee-review-bypass-entry')
    expect(styles.match(/\.employee-responsibility-flow-connector__arrow\s*\{/g)).toHaveLength(1)
    expect(styles.match(/\.employee-responsibility-flow-path\s*\{/g)).toHaveLength(1)
    expect(styles).toMatch(
      /\.employee-responsibility-flow-path\s*\{[^}]*stroke-width:\s*var\(--employee-flow-stroke-width\)/,
    )
    expect(styles).not.toContain('clip-path: polygon(')
    expect(display).toContain('function ResponsibilityFlowConnector(')
    expect(display).toContain('data-responsibility-flow-connector={props.kind}')
    expect(display).toContain('data-ingress-route-arrow-to={props.targetRef}')
    expect(display).toContain('className="employee-responsibility-flow-connector__arrow"')
    expect(display).toContain('<ResponsibilityFlowPath d="M 0 50 H 100" />')
    expect(display).toContain('points="0,0 4,3 0,6"')
    expect(display.match(/<ResponsibilityFlowConnector/g)?.length ?? 0).toBeGreaterThan(4)
    expect(styles).not.toContain('--employee-flow-gap: 5px')
    expect(display).toContain('props.sourceNode === true ? undefined')
    expect(graph).toContain("entry.kind === 'ingress-branch'")
    expect(styles).toContain('grid-column: span 2')
    expect(styles).toContain('grid-column: span 3')
    expect(styles).toContain('.employee-toolbox-card--human-gate')
  })

  // User regression 2026-08-22: failure types were edited globally from the
  // job, while repair tools accepted free-text ids and classifier selection did
  // not materialize its fan-out nodes.
  test('classifier tools own problem types and jobs only bind compatible handlers', () => {
    const typePage = read('routes/digital-employees.$typeRef.tsx')
    const types = read('components/digital-employees/types.ts')

    expect(types).toContain('dispatchRouteDefinitions?: Array<{')
    expect(typePage).toContain("'问题清单归工具所有'")
    expect(typePage).toContain("'Problem list belongs to the tool'")
    expect(typePage).toContain("zh ? '该工具解决哪些问题' : 'Problems solved by this tool'")
    expect(typePage).toContain('deriveDispatchRouteDrafts(')
    expect(typePage).toContain('preferredDispatchTool(')
    expect(typePage).toContain('setOrderedDispatchRoutes((current) =>')
    expect(typePage).toContain('data-testid="tool-dispatch-route-definitions"')
    expect(typePage).not.toContain('填写岗位模板中使用的类型标识')
    expect(typePage).not.toContain('关联流水线错误类型')
  })

  test('v2 classifier configuration is plain categories while the job owns processing order', () => {
    const typePage = read('routes/digital-employees.$typeRef.tsx')

    expect(typePage).toContain("processingOrderOwner === 'job'")
    expect(typePage).toContain("? '问题类型归工具所有'")
    expect(typePage).toContain("? '本工具的问题类型'")
    expect(typePage).not.toContain(
      "contract?.contractId === 'development.classify-pipeline-failures'",
    )
    expect(typePage).toContain("? '类型标识'")
    expect(typePage).toContain("? '名称'")
    expect(typePage).toContain("? '说明'")
    expect(typePage).toContain("label={zh ? '兜底分类' : 'Fallback category'}")
    expect(typePage).toContain('setFallbackRouteLocalRef')
    expect(typePage).toContain('fallback: route.fallback')
    expect(typePage).toContain("'问题类型尚未完成'")
    expect(typePage).toContain("'还没有已发布的问题类型'")
    expect(typePage).toContain('内置流水线失败修复 Agent')
    expect(typePage).toContain('const moveDispatchRoute = (')
    expect(typePage).toContain('岗位为每个类型选择处理方式并决定处理顺序')
    expect(typePage).toContain('岗位可调整非兜底类型的处理顺序')
  })

  // User regressions 2026-08-22/23: native drag was throttled, lagged behind
  // the pointer, and moving a later lane to the first slot could land at P2.
  test('lane dragging renders a temporary target order and animates each move', () => {
    const graph = read('components/digital-employees/EmployeeCapabilityPanorama.tsx')
    const styles = read('styles.css')

    expect(graph).toContain('dragPreviewOrder')
    expect(graph).toContain('effectiveLanePriorityOrder')
    expect(graph).toContain('previewPriorityIndex')
    expect(graph).toContain('slotBoundaries')
    expect(graph).toContain('onPointerMove')
    expect(graph).toContain('updatePointerDrag(session.sourceLaneId, event.clientY)')
    expect(graph).toContain('onPointerUp')
    expect(graph).toContain('mapElement.current?.setPointerCapture')
    expect(graph).toContain('for (const animation of element?.getAnimations() ?? [])')
    expect(graph).toContain('animation.cancel()')
    expect(graph).not.toContain('onDragEnter')
    expect(graph).not.toContain('draggable')
    expect(graph).toContain('animateLaneReorder')
    expect(graph).toContain("' employee-toolbox-lane--drop-target'")
    expect(styles).toContain('.employee-toolbox-lane--drop-target')
    expect(styles).toContain('.employee-toolbox-lane--dragging')
    expect(styles).toContain('touch-action: none')
    expect(styles).toContain('calc(0px - var(--employee-lane-drag-offset, 0px))')
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

    const planning = withAgentExecutionContractsAndPorts(switched, ['development.analyze-plan@1'], {
      'development.analyze-plan@1': {
        outputPort: 'analysis-plan',
        outputKind: 'path<md>',
      },
    })
    expect(planning.outputs).toEqual(['ordinary', 'analysis-plan'])
    expect(planning.outputKinds).toEqual({ ordinary: 'markdown', 'analysis-plan': 'path<md>' })
    expect(planning.outputs).not.toContain('agent-result')

    const unlinked = withAgentExecutionContractsAndPorts(planning, [])
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
    expect(detail).toContain('<EmployeeCapabilityPanorama')
    expect(detail).toContain('dispatchNodes={runtimeDispatchNodes}')
    expect(detail).toContain('toolState={runtimeToolState}')
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
    expect(detail).toContain("zh ? '任务流水 · 时间轴' : 'Task execution timeline'")
    expect(detail).toContain('data-testid="employee-work-timeline"')
    expect(detail).toContain('inputContextRefsJson')
    expect(detail).toContain('outputJson')
  })

  test('employee setup keeps the next action on the same page and supports later edits', () => {
    const typePage = read('routes/digital-employees.$typeRef.tsx')
    const map = read('components/digital-employees/EmployeeCapabilityPanorama.tsx')
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
    const stackRule = styles.match(/\.employee-toolbox-card--fan-out \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(stackRule).toContain('--employee-card-stack-shadows:')
    expect(stackRule).toContain('4px 4px 0 0 var(--employee-card-background)')
    expect(stackRule).toContain('8px 8px 0 0 var(--employee-card-background)')
    expect(stackRule).toContain('4px 4px 0 1px var(--employee-card-border)')
    expect(stackRule).toContain('8px 8px 0 1px var(--employee-card-border)')
    expect(stackRule).not.toContain('z-index:')
    expect(stackRule).not.toContain('opacity:')
    expect(map).toContain('const fanOutDestinationRefs = new Set(')
    expect(map).toContain('source.orderedDispatchAuthoring?.destinationWorkItemRefs')
    expect(map).not.toContain("item.inputMultiplicity === 'collection'")
    expect(map).toContain('employee-toolbox-card--fan-out')
    expect(map).not.toContain('employee-toolbox-card__stack-layer')
    expect(map).not.toContain('repair-feedback')
    expect(map).toContain('employee-toolbox-region--${lanes.length > 1')
    expect(map).toContain('<ResponsibilityLaneAxis />')
    expect(map).toContain("? '主泳道'")
    expect(map).toContain("? '职责泳道'")
    expect(styles).toContain(
      'grid-template-columns: var(--employee-lane-label-width) 20px minmax(0, 1fr)',
    )
    expect(styles).not.toContain(
      '.employee-toolbox-region--branching .employee-toolbox-lane__axis::before',
    )
    expect(styles).toContain('.employee-toolbox-review-branch__reviewed-flow')
    expect(styles).toContain('.employee-responsibility-flow-connector--sequence')
    expect(styles).not.toContain('+ .employee-toolbox-card::before')
    expect(styles).not.toContain('minmax(min(100%, 210px), 1fr)')
    expect(styles).toContain('var(--employee-tool-card-width)')
    const dutyNameRule = styles.match(/\.employee-toolbox-card strong \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(dutyNameRule).toContain('white-space: normal')
    expect(dutyNameRule).toContain('overflow: hidden')
    expect(dutyNameRule).toContain('-webkit-line-clamp: 2')
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

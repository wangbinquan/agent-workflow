import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

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
    expect(typePage).toContain('allowedToolKinds={')
    expect(typePage).toContain('() => props.allowedToolKinds')
    expect(typePage).not.toContain("? ['agent', 'workflow', 'program']")
    expect(typePage).toContain('parameterValues: parsedParameters')
    expect(typePage).toContain("search={{ view: 'toolbox', workItem:")
    expect(typePage).toContain("search: { ...search, view: 'toolbox', workItem }")
    expect(typePage).not.toContain('stageId')
    expect(graph).toContain('item.nextWorkItemRefs')
    expect(graph).toContain('employee-graph__edge--loop')
    expect(graph).not.toContain('onConnect')
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

  test('Event Center and global retry settings are visible without leaking runtime vocabulary', () => {
    const home = read('routes/digital-employees.tsx')
    const settings = read('routes/settings.tsx')

    expect(home).toContain("label: zh ? '事件中心' : 'Event Center'")
    expect(home).toContain('Subscriptions drive observers automatically')
    expect(settings).toContain("| 'digitalEmployee'")
    expect(settings).toContain('sameSceneAttempts')
    expect(settings).toContain('freshSceneAttempts')
    expect(settings).toContain('等待外部协作或审批最长时间')
  })
})

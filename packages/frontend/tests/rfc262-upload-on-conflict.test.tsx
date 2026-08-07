// RFC-262 — upload 输入的同名冲突策略在前端的两条链路：
//
//   1. **作者面**：画布 Input 节点 inspector 里的分段控件，改动落进
//      `definition.inputs[].onConflict`（缺省不写字段＝rename，存量定义原样往返）。
//   2. **启动面**：`findUploadDuplicate` 与后端 `validateUploadPlan` 共用同一个
//      shared 走查器——它一旦与后端分叉，向导就会放行一个服务端必然 422 的启动。
//
// 控件走公共 `<Segmented>`（role=radiogroup / radio），断言用 role 而非 DOM 结构：
// 角色契约是公共组件的一部分，换实现不该让这里变红。

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { NodeInspector } from '../src/components/canvas/NodeInspector'
import { findUploadDuplicate } from '../src/lib/task-wizard'

function makeDef(parts: Partial<WorkflowDefinition>): WorkflowDefinition {
  return { $schema_version: 1, inputs: [], nodes: [], edges: [], ...parts }
}

function Host({
  initial,
  onChangeSpy,
}: {
  initial: WorkflowDefinition
  onChangeSpy: (def: WorkflowDefinition) => void
}) {
  const [def, setDef] = useState(initial)
  return (
    <NodeInspector
      definition={def}
      selectedNodeId="i1"
      agents={[]}
      onChange={(next) => {
        setDef(next)
        onChangeSpy(next)
      }}
      onClose={() => {}}
    />
  )
}

function last(onChange: ReturnType<typeof vi.fn>): WorkflowDefinition {
  return onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as WorkflowDefinition
}

function uploadDef(extra: Record<string, unknown> = {}): WorkflowDefinition {
  return makeDef({
    inputs: [
      {
        kind: 'upload',
        key: 'spec',
        label: 'Spec',
        targetDir: 'spec',
        ...extra,
      } as WorkflowDefinition['inputs'][number],
    ],
    nodes: [{ id: 'i1', kind: 'input', inputKey: 'spec' } as WorkflowNode],
  })
}

afterEach(() => {
  cleanup()
})

describe('inspector: onConflict 分段控件（RFC-262 作者面）', () => {
  // 选项按 testid 定位、按 role 断言语义：文案随语言变（测试跑在 en-US），
  // 但 radiogroup/radio 契约与 aria-checked 是公共 Segmented 的稳定面。
  const rename = () => screen.getByTestId('upload-on-conflict-rename')
  const overwrite = () => screen.getByTestId('upload-on-conflict-overwrite')

  test('缺省定义渲染出两个选项，且 rename 为选中态', () => {
    render(<Host initial={uploadDef()} onChangeSpy={vi.fn()} />)
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(rename().getAttribute('aria-checked')).toBe('true')
    expect(overwrite().getAttribute('aria-checked')).toBe('false')
  })

  test('点「覆盖」写入 onConflict:"overwrite"，其余 upload 字段不动', () => {
    const spy = vi.fn()
    render(<Host initial={uploadDef({ accept: ['.yaml'] })} onChangeSpy={spy} />)
    fireEvent.click(overwrite())
    const input = last(spy).inputs[0] as Record<string, unknown>
    expect(input.onConflict).toBe('overwrite')
    expect(input.targetDir).toBe('spec')
    expect(input.accept).toEqual(['.yaml'])
    expect(input.kind).toBe('upload')
  })

  test('已存的 overwrite 回显为选中，可以切回 rename', () => {
    const spy = vi.fn()
    render(<Host initial={uploadDef({ onConflict: 'overwrite' })} onChangeSpy={spy} />)
    expect(overwrite().getAttribute('aria-checked')).toBe('true')
    fireEvent.click(rename())
    expect((last(spy).inputs[0] as Record<string, unknown>).onConflict).toBe('rename')
  })

  test('非 upload 输入不渲染该控件（字段只属于 upload）', () => {
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'spec', label: 'Spec' }],
      nodes: [{ id: 'i1', kind: 'input', inputKey: 'spec' } as WorkflowNode],
    })
    render(<Host initial={def} onChangeSpy={vi.fn()} />)
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.queryByTestId('upload-on-conflict-overwrite')).toBeNull()
  })
})

describe('launcher: findUploadDuplicate（RFC-262 启动面）', () => {
  const defs = [
    { kind: 'upload' as const, key: 'spec', label: 'Spec', targetDir: 'spec' },
    { kind: 'upload' as const, key: 'extra', label: 'Extra', targetDir: 'spec' },
    { kind: 'upload' as const, key: 'refs', label: 'Refs', targetDir: 'inputs' },
    { kind: 'text' as const, key: 'note', label: 'Note' },
  ]
  const file = (name: string) => new File(['x'], name)

  test('无重复 → null', () => {
    expect(findUploadDuplicate(defs, { spec: [file('a.yaml')], refs: [file('a.yaml')] })).toBeNull()
  })

  test('同一输入内同名 → 命中', () => {
    const dup = findUploadDuplicate(defs, { spec: [file('api.yaml'), file('api.yaml')] })
    expect(dup?.first.inputKey).toBe('spec')
    expect(dup?.second.filename).toBe('api.yaml')
  })

  test('两个输入共用 targetDir 且同名 → 命中（与后端同为全局判重）', () => {
    const dup = findUploadDuplicate(defs, { spec: [file('api.yaml')], extra: [file('api.yaml')] })
    expect(dup).not.toBeNull()
    expect(dup?.key).toBe('spec/api.yaml')
  })

  test('仅大小写不同 → 命中（能力影响清单 C2 方案 A）', () => {
    expect(findUploadDuplicate(defs, { spec: [file('API.yaml'), file('api.yaml')] })).not.toBeNull()
  })

  test('工作流不再声明的残留桶不参与判重', () => {
    // 服务端对未声明的 key 报 task-multipart-unknown-input，前端不能拿它去
    // 制造一条针对存活输入的假冲突。
    expect(
      findUploadDuplicate(defs, { gone: [file('api.yaml')], spec: [file('api.yaml')] }),
    ).toBeNull()
  })
})

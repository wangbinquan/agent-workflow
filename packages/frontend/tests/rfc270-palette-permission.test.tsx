// RFC-270 AC-9 / AC-10 — palette 里的「脚本」「集成」条目按权限置灰。
//
// 用户实报「普通用户可以创建脚本和代码平台调用节点」。判据与权限点都早就存在
// （`scripts:author` / `code-host-calls:author`，门在后端两个持久化原语上），
// 缺的是前台：`buildPalette` 没有 permission 形参，`WorkflowNodePickerCatalog`
// 虽然一直接受 `disabledReason`，却**没有任何调用方传过它**。
//
// ⚠ **两条创建路径都要测**。`aria-disabled` 只挡 click / Enter；侧边栏的抓手是
// `draggable` 的，是完全独立的第二条路。只测点击的话，置灰就只是视觉效果，用户
// 照样能把节点拖上画布、然后在保存时吃 403 —— 正是本 RFC 要消灭的那种体验。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { privilegedNodeAccessOf } from '../src/hooks/usePrivilegedNodes'
import { WorkflowNodePickerCatalog } from '../src/components/workflow-editor/WorkflowNodePicker'
import type { PaletteItem } from '../src/components/canvas/nodePalette'

afterEach(() => {
  cleanup()
  // 目录会把点过的条目写进 localStorage 的「最近使用」，于是同一个 testid 会在
  // 「最近」与本分区里各出现一次。不清的话，用例之间会互相污染出多元素错误。
  window.localStorage.clear()
})

/** 只回显 key + 参数，避免断言绑死在真实文案上。 */
const t = (key: string, options?: Record<string, unknown>): string =>
  options?.permission === undefined ? key : `${key}:${String(options.permission)}`

const NO_GRANTS = { canAuthorScripts: false, canAuthorCodeHost: false }
const ALL_GRANTS = { canAuthorScripts: true, canAuthorCodeHost: true }

function itemOf(kind: string): PaletteItem {
  return { kind } as PaletteItem
}

describe('RFC-270 · privilegedNodeAccessOf（纯判定）', () => {
  test('无权限：两类特权节点都给出带权限点名字的理由', () => {
    const access = privilegedNodeAccessOf(NO_GRANTS, t)
    expect(access.paletteDisabledReason(itemOf('script'))).toBe(
      'editor.nodePicker.requiresPermission:scripts:author',
    )
    expect(access.paletteDisabledReason(itemOf('code-host-call'))).toBe(
      'editor.nodePicker.requiresPermission:code-host-calls:author',
    )
  })

  test('两个点各管各的：只缺 scripts:author 时集成节点不受影响', () => {
    const access = privilegedNodeAccessOf({ canAuthorScripts: false, canAuthorCodeHost: true }, t)
    expect(access.paletteDisabledReason(itemOf('script'))).not.toBeNull()
    expect(access.paletteDisabledReason(itemOf('code-host-call'))).toBeNull()
  })

  test('有权限：一律 null（admin / manager 一切照旧）', () => {
    const access = privilegedNodeAccessOf(ALL_GRANTS, t)
    expect(access.paletteDisabledReason(itemOf('script'))).toBeNull()
    expect(access.paletteDisabledReason(itemOf('code-host-call'))).toBeNull()
  })

  test('非特权节点从不被置灰（收紧不许溢出到普通节点）', () => {
    const access = privilegedNodeAccessOf(NO_GRANTS, t)
    for (const kind of ['input', 'output', 'review', 'wrapper-loop', 'call-workflow']) {
      expect(access.paletteDisabledReason(itemOf(kind))).toBeNull()
    }
  })

  test('protectedNodeIds 只圈出无权限的那几类', () => {
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'a1', kind: 'agent-single' },
        { id: 's1', kind: 'script' },
        { id: 'c1', kind: 'code-host-call' },
      ],
      edges: [],
    } as never
    expect([...privilegedNodeAccessOf(NO_GRANTS, t).protectedNodeIds(definition)].sort()).toEqual([
      'c1',
      's1',
    ])
    expect([...privilegedNodeAccessOf(ALL_GRANTS, t).protectedNodeIds(definition)]).toEqual([])
    expect([
      ...privilegedNodeAccessOf(
        { canAuthorScripts: true, canAuthorCodeHost: false },
        t,
      ).protectedNodeIds(definition),
    ]).toEqual(['c1'])
  })
})

describe('RFC-270 AC-9 / AC-10 · 目录里的两条创建路径都被挡住', () => {
  function renderCatalog(grants: typeof NO_GRANTS) {
    const picked: PaletteItem[] = []
    const access = privilegedNodeAccessOf(grants, t)
    render(
      <WorkflowNodePickerCatalog
        agents={[]}
        onPick={(item) => picked.push(item)}
        showDragGrip
        disabledReason={access.paletteDisabledReason}
      />,
    )
    return picked
  }

  // 同一条目可能同时出现在「推荐 / 最近」与它自己的分区里 —— 断言取全部实例，
  // 免得「有一处没置灰」被首个元素掩盖。
  const rowsOf = (kind: string): HTMLElement[] =>
    screen.getAllByTestId(`workflow-node-picker-item-kind-${kind}`)
  const scriptRow = (): HTMLElement => rowsOf('script')[0] as HTMLElement
  const callRow = (): HTMLElement => rowsOf('code-host-call')[0] as HTMLElement

  test('分区仍然存在（用户拍板「显示但置灰」，不是隐藏）', () => {
    renderCatalog(NO_GRANTS)
    expect(scriptRow()).toBeTruthy()
    expect(callRow()).toBeTruthy()
  })

  test('无权限：两行 aria-disabled 且点击不产出节点', () => {
    const picked = renderCatalog(NO_GRANTS)
    for (const row of [...rowsOf('script'), ...rowsOf('code-host-call')]) {
      expect(row.getAttribute('aria-disabled')).toBe('true')
    }
    fireEvent.click(scriptRow())
    fireEvent.click(callRow())
    expect(picked).toEqual([])
  })

  test('无权限：抓手不可拖，且 dragstart 被阻止（第二条创建路径）', () => {
    renderCatalog(NO_GRANTS)
    const grip = scriptRow().querySelector('.workflow-node-picker__drag-grip')
    expect(grip).toBeTruthy()
    expect((grip as HTMLElement).getAttribute('draggable')).toBe('false')

    // 即便有人绕过 draggable 属性直接派发 dragstart，也不许写进 dataTransfer。
    const setData = vi.fn()
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        setData,
        get effectAllowed() {
          return 'none'
        },
        set effectAllowed(_v: string) {},
      },
    })
    fireEvent(grip as HTMLElement, event)
    expect(setData).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  test('有权限：可点击产出节点、抓手可拖', () => {
    const picked = renderCatalog(ALL_GRANTS)
    expect(scriptRow().getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(scriptRow())
    expect(picked).toEqual([{ kind: 'script' }])
    const grip = scriptRow().querySelector('.workflow-node-picker__drag-grip')
    expect((grip as HTMLElement).getAttribute('draggable')).toBe('true')
  })

  test('无权限时普通节点照常可用（收紧没有溢出）', () => {
    const picked = renderCatalog(NO_GRANTS)
    fireEvent.click(rowsOf('input')[0] as HTMLElement)
    expect(picked).toEqual([{ kind: 'input' }])
  })
})

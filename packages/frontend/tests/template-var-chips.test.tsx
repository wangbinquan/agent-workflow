// TemplateVarChips — webhook 触发器模板变量插入行的组件/纯函数层。
// 锁三条用户需求（源自「统一提示」改动）：
//   1) 变量集与保存期校验同源（availableVarsFor 交集），不再是手写清单——
//      旧 templateVarsHint 文案漏了 repo_http_url / repo_ssh_url；
//   2) event_json 置顶展示；
//   3) 点击插入到光标处（insertAtCursor 纯函数 + applyTemplateVarInsertion
//      的受控 commit + 焦点/光标恢复）。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  TemplateVarChips,
  applyTemplateVarInsertion,
  insertAtCursor,
  webhookVarsForDisplay,
} from '../src/components/TemplateVarChips'

afterEach(cleanup)

describe('insertAtCursor', () => {
  test('inserts at the caret position', () => {
    expect(insertAtCursor('fix bug', 3, 3, '{{x}}')).toEqual({
      next: 'fix{{x}} bug',
      caret: 8,
    })
  })

  test('replaces a selection range', () => {
    expect(insertAtCursor('abcdef', 1, 4, 'X')).toEqual({ next: 'aXef', caret: 2 })
  })

  test('appends to the end when no selection info is available', () => {
    expect(insertAtCursor('abc', null, null, 'Z')).toEqual({ next: 'abcZ', caret: 4 })
    expect(insertAtCursor('', null, null, 't')).toEqual({ next: 't', caret: 1 })
  })
})

describe('webhookVarsForDisplay', () => {
  test('empty event selection yields an empty list', () => {
    expect(webhookVarsForDisplay([])).toEqual([])
  })

  test('event_json comes first; the rest follow the intersection of selected events', () => {
    const vars = webhookVarsForDisplay(['push'])
    expect(vars[0]).toBe('event_json')
    // push = COMMON(6) + commit_sha；含旧 hint 文案里漏掉的两个 URL 变量。
    expect(vars).toHaveLength(7)
    expect(vars).toContain('commit_sha')
    expect(vars).toContain('repo_http_url')
    expect(vars).toContain('repo_ssh_url')
    expect(vars).not.toContain('mr_title')
  })

  test('multi-event selection intersects the per-event matrices', () => {
    const vars = webhookVarsForDisplay(['mr_opened', 'note'])
    expect(vars[0]).toBe('event_json')
    expect(vars).toContain('mr_title')
    // commit_sha 只在 mr_opened、comment_text 只在 note —— 交集都没有。
    expect(vars).not.toContain('commit_sha')
    expect(vars).not.toContain('comment_text')
  })
})

describe('applyTemplateVarInsertion', () => {
  test('commits the inserted value and restores focus + caret after the token', async () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.value = 'fix bug'
    input.setSelectionRange(3, 3)
    // 模拟受控组件的 commit → re-render 回写；不回写的话 setSelectionRange(8)
    // 会被旧 value 的长度（7）clamp，测的就不是恢复逻辑了。
    const commit = vi.fn((next: string) => {
      input.value = next
    })
    applyTemplateVarInsertion(input, 'fix bug', '{{x}}', commit)
    expect(commit).toHaveBeenCalledWith('fix{{x}} bug')
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(8)
    expect(input.selectionEnd).toBe(8)
    input.remove()
  })

  test('with no element it still commits, appending at the end', () => {
    const commit = vi.fn()
    applyTemplateVarInsertion(null, 'abc', '{{y}}', commit)
    expect(commit).toHaveBeenCalledWith('abc{{y}}')
  })
})

describe('TemplateVarChips', () => {
  test('renders one button per var with the full token as its name', () => {
    const onInsert = vi.fn()
    render(
      <TemplateVarChips
        vars={['event_json', 'branch']}
        label="Vars"
        onInsert={onInsert}
        testidPrefix="tv"
      />,
    )
    expect(screen.getByRole('group', { name: 'Vars' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '{{event_json}}' })).toBeTruthy()
    fireEvent.click(screen.getByTestId('tv-branch'))
    expect(onInsert).toHaveBeenCalledWith('{{branch}}')
  })

  test('renders nothing for an empty var list', () => {
    const { container } = render(<TemplateVarChips vars={[]} label="Vars" onInsert={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})

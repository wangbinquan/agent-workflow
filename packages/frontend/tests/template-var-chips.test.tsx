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
  webhookVarGroupsForDisplay,
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

// RFC-263 改判：返回值从扁平数组变成「事件上下文 / API 定位」两组（变量表 13→30，
// 一行 chips 会挤成一坨）。原「event_json 置顶 + 长度 7」的断言按新 COMMON 集改写，
// 「与保存期校验同源」这条原始需求继续锁住。
describe('webhookVarGroupsForDisplay', () => {
  const flatten = (groups: ReturnType<typeof webhookVarGroupsForDisplay>) =>
    groups.flatMap((g) => g.vars)

  test('empty event selection yields no groups', () => {
    expect(webhookVarGroupsForDisplay([])).toEqual([])
  })

  test('event_json leads its own group; both groups follow the selected events', () => {
    const groups = webhookVarGroupsForDisplay(['push'])
    expect(groups.map((g) => g.key)).toEqual(['context', 'api'])
    expect(groups[0]?.vars[0]).toBe('event_json')
    const vars = flatten(groups)
    // push = COMMON(14) + commit_sha + commit_before
    expect(vars).toHaveLength(16)
    expect(vars).toContain('commit_sha')
    expect(vars).toContain('commit_before')
    // 旧 hint 文案漏掉的两个 URL 变量仍在（原始需求 1）
    expect(vars).toContain('repo_http_url')
    expect(vars).toContain('repo_ssh_url')
    // RFC-263 的 API 定位组对每类事件都可用
    expect(groups[1]?.vars).toContain('project_id')
    expect(groups[1]?.vars).toContain('api_base_url')
    expect(vars).not.toContain('mr_title')
  })

  test('multi-event selection intersects the per-event matrices', () => {
    const vars = flatten(webhookVarGroupsForDisplay(['mr_opened', 'note']))
    expect(vars).toContain('mr_title')
    expect(vars).toContain('mr_url')
    // commit_sha 只在 mr_opened、comment_text 只在 note —— 交集都没有。
    expect(vars).not.toContain('commit_sha')
    expect(vars).not.toContain('comment_text')
    expect(vars).not.toContain('comment_thread_id')
  })

  test('note keeps the reply-to-thread variables together in the API group', () => {
    const groups = webhookVarGroupsForDisplay(['note'])
    const api = groups.find((g) => g.key === 'api')?.vars ?? []
    expect(api).toContain('comment_thread_id')
    expect(api).toContain('comment_id')
    expect(api).toContain('comment_position_json')
    expect(api).toContain('project_id')
    // 上下文类的仍在另一组，不混进来
    expect(api).not.toContain('comment_text')
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

  test('disabled mode keeps read-only consumers from offering a false insertion action', () => {
    const onInsert = vi.fn()
    render(
      <TemplateVarChips
        vars={['branch']}
        label="Vars"
        onInsert={onInsert}
        testidPrefix="tv"
        disabled
      />,
    )
    const chip = screen.getByTestId('tv-branch')
    expect((chip as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(chip)
    expect(onInsert).not.toHaveBeenCalled()
  })

  // RFC-263：分组呈现 + 每 chip 的说明 tooltip。
  test('grouped mode renders one labelled row per group, chips carry titles', () => {
    const onInsert = vi.fn()
    render(
      <TemplateVarChips
        groups={[
          { label: 'Event context', vars: ['event_json', 'branch'] },
          { label: 'API targets', vars: ['project_id', 'comment_thread_id'] },
        ]}
        label="Vars"
        onInsert={onInsert}
        testidPrefix="tv"
        titleOf={(name) => `explains ${name}`}
      />,
    )
    expect(screen.getByRole('group', { name: 'Vars' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Event context' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'API targets' })).toBeTruthy()
    expect(screen.getByTestId('tv-comment_thread_id').getAttribute('title')).toBe(
      'explains comment_thread_id',
    )
    fireEvent.click(screen.getByTestId('tv-project_id'))
    expect(onInsert).toHaveBeenCalledWith('{{project_id}}')
  })

  test('grouped mode drops empty groups and renders nothing when all are empty', () => {
    const { container, rerender } = render(
      <TemplateVarChips
        groups={[
          { label: 'Event context', vars: ['branch'] },
          { label: 'API targets', vars: [] },
        ]}
        label="Vars"
        onInsert={() => {}}
      />,
    )
    expect(screen.queryByRole('group', { name: 'API targets' })).toBeNull()
    rerender(
      <TemplateVarChips
        groups={[{ label: 'Event context', vars: [] }]}
        label="Vars"
        onInsert={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})

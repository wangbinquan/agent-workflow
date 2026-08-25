// LOCKS: RFC-325 —— Select 的搜索默认值契约。
//
// 「要不要搜索」以前是 128 个调用点各自的记性（`searchable` 是 opt-in，只有 25 处传了），
// RFC-325 把它收进共享原语：`props.searchable ?? options.length >= SELECT_SEARCH_THRESHOLD`。
// 这个文件锁住四件容易被后续改动误伤的事：
//
//   A1 阈值两侧的边界（7 项无框 / 8 项有框），以及阈值常量本身不许漂移。
//   A2 显式 `searchable` 双向覆盖仍然有效（长列表能关、短列表能开）。
//   A3/A4 匹配面（description / group）与归一化（全角、中文）。
//   A5 Esc 两段语义，且两段都不冒泡出去关掉外层 Dialog。
//   A6 **阈值以下的小枚举没被误伤**：首字母 typeahead 与空格选中照旧。
//      —— 这条是选 8 而不是更小值的全部理由，删了它这次改动就没有下界了。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Select, SELECT_SEARCH_THRESHOLD, type SelectOption } from '../src/components/Select'
import '../src/i18n'

afterEach(cleanup)

function listOf(count: number): ReadonlyArray<SelectOption<string>> {
  return Array.from({ length: count }, (_unused, index) => ({
    value: `opt-${index}`,
    label: `Option ${index}`,
  }))
}

function open(testid = 'sel'): void {
  fireEvent.click(screen.getByTestId(testid))
}

describe('A1 阈值边界（RFC-325）', () => {
  test('阈值常量为 8，且不许静默漂移', () => {
    expect(SELECT_SEARCH_THRESHOLD).toBe(8)
  })

  test('7 项（阈值以下）不渲染搜索框', () => {
    render(<Select value="opt-0" options={listOf(7)} onChange={() => {}} data-testid="sel" />)
    open()
    expect(screen.queryByTestId('sel-search')).toBeNull()
    expect(screen.getAllByRole('option')).toHaveLength(7)
  })

  test('8 项（达到阈值）自动渲染搜索框', () => {
    render(<Select value="opt-0" options={listOf(8)} onChange={() => {}} data-testid="sel" />)
    open()
    expect(screen.getByTestId('sel-search')).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(8)
  })

  test('阈值判据是原始 options.length —— 禁用项与占位行一起计数', () => {
    const withDisabled: ReadonlyArray<SelectOption<string>> = [
      { value: '', label: 'pick one' },
      ...listOf(5),
      { value: 'x', label: 'X', disabled: true },
      { value: 'y', label: 'Y', disabled: true },
    ]
    expect(withDisabled).toHaveLength(8)
    render(<Select value="opt-0" options={withDisabled} onChange={() => {}} data-testid="sel" />)
    open()
    expect(screen.getByTestId('sel-search')).toBeTruthy()
  })
})

describe('A2 显式 searchable 双向覆盖（RFC-325）', () => {
  test('长列表上 searchable={false} 强制关闭', () => {
    render(
      <Select
        value="opt-0"
        options={listOf(20)}
        onChange={() => {}}
        searchable={false}
        data-testid="sel"
      />,
    )
    open()
    expect(screen.queryByTestId('sel-search')).toBeNull()
  })

  test('短列表上 searchable 强制开启', () => {
    render(
      <Select value="opt-0" options={listOf(3)} onChange={() => {}} searchable data-testid="sel" />,
    )
    open()
    expect(screen.getByTestId('sel-search')).toBeTruthy()
  })
})

describe('A3/A4 匹配面与归一化（RFC-325）', () => {
  const RICH: ReadonlyArray<SelectOption<string>> = [
    { value: 'a/one', label: 'One', description: '审阅代码变更', group: 'anthropic' },
    { value: 'a/two', label: 'Two', description: 'writes tests', group: 'anthropic' },
    { value: 'o/three', label: 'gpt-4', description: 'general purpose', group: 'openai' },
    ...listOf(5),
  ]

  test('按 description 命中', () => {
    render(<Select value="a/one" options={RICH} onChange={() => {}} data-testid="sel" />)
    open()
    fireEvent.change(screen.getByTestId('sel-search'), { target: { value: 'writes' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Two/ })).toBeTruthy()
  })

  test('按 group（分组名）命中该组全部选项', () => {
    render(<Select value="a/one" options={RICH} onChange={() => {}} data-testid="sel" />)
    open()
    fireEvent.change(screen.getByTestId('sel-search'), { target: { value: 'anthropic' } })
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  test('中文子串命中中文描述', () => {
    render(<Select value="a/one" options={RICH} onChange={() => {}} data-testid="sel" />)
    open()
    fireEvent.change(screen.getByTestId('sel-search'), { target: { value: '审阅' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /One/ })).toBeTruthy()
  })

  test('全角查询命中半角标题（NFKC 归一）', () => {
    render(<Select value="a/one" options={RICH} onChange={() => {}} data-testid="sel" />)
    open()
    fireEvent.change(screen.getByTestId('sel-search'), { target: { value: 'ＧＰＴ－４' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /gpt-4/ })).toBeTruthy()
  })
})

describe('A5 Esc 两段语义（RFC-325）', () => {
  test('有词时第一次 Esc 只清词、下拉不关、列表复原全量', () => {
    const parentKeyDown = vi.fn()
    render(
      <div onKeyDown={parentKeyDown}>
        <Select value="opt-0" options={listOf(10)} onChange={() => {}} data-testid="sel" />
      </div>,
    )
    open()
    const search = screen.getByTestId('sel-search')
    fireEvent.change(search, { target: { value: 'Option 3' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)

    fireEvent.keyDown(search, { key: 'Escape' })

    expect((screen.getByTestId('sel-search') as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(10)
    expect(parentKeyDown).not.toHaveBeenCalled()
  })

  test('无词时 Esc 关闭下拉并把焦点还给 trigger，且不冒泡', () => {
    const parentKeyDown = vi.fn()
    render(
      <div onKeyDown={parentKeyDown}>
        <Select value="opt-0" options={listOf(10)} onChange={() => {}} data-testid="sel" />
      </div>,
    )
    open()
    fireEvent.keyDown(screen.getByTestId('sel-search'), { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('sel'))
    expect(parentKeyDown).not.toHaveBeenCalled()
  })

  test('清词后再按一次 Esc 才关闭（两段确实是两段）', () => {
    render(<Select value="opt-0" options={listOf(10)} onChange={() => {}} data-testid="sel" />)
    open()
    fireEvent.change(screen.getByTestId('sel-search'), { target: { value: 'zzz' } })
    fireEvent.keyDown(screen.getByTestId('sel-search'), { key: 'Escape' })
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(screen.getByTestId('sel-search'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  test('清空一个 0 命中的搜索后，高亮行被重新落回第一项（Enter 立刻可用）', () => {
    const onChange = vi.fn()
    render(<Select value="opt-0" options={listOf(10)} onChange={onChange} data-testid="sel" />)
    open()
    const search = screen.getByTestId('sel-search')
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    fireEvent.keyDown(search, { key: 'Escape' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('opt-0')
  })
})

describe('A6 阈值以下的小枚举没被误伤（RFC-325）', () => {
  const SMALL = [
    { value: 'asc', label: 'Ascending' },
    { value: 'desc', label: 'Descending' },
    { value: 'natural', label: 'Natural' },
  ] as const

  test('首字母 typeahead 照旧跳转', () => {
    const onChange = vi.fn()
    render(<Select value="asc" options={SMALL} onChange={onChange} data-testid="sel" />)
    open()
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'd' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('desc')
  })

  test('空格照旧选中当前高亮项', () => {
    const onChange = vi.fn()
    render(<Select value="asc" options={SMALL} onChange={onChange} data-testid="sel" />)
    open()
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: ' ' })
    expect(onChange).toHaveBeenCalledWith('desc')
  })

  test('7 项时（阈值下界）typeahead 仍然生效', () => {
    const onChange = vi.fn()
    const seven: ReadonlyArray<SelectOption<string>> = [
      ...listOf(6),
      { value: 'zulu', label: 'Zulu' },
    ]
    render(<Select value="opt-0" options={seven} onChange={onChange} data-testid="sel" />)
    open()
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'z' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('zulu')
  })
})

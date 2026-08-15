import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { CachedRepo } from '@agent-workflow/shared'
import { RepoBulkAddDialog, type RepoBulkAddItem } from '@/components/repos/RepoBulkAddDialog'

const repos = Array.from(
  { length: 20 },
  (_, index) =>
    ({
      id: `repo-${index}`,
      urlRedacted: `https://git.example/acme/repo-${index}.git`,
      defaultBranch: 'main',
    }) as CachedRepo,
)

describe('RepoBulkAddDialog', () => {
  test('20 仓平铺可一次全选并提交，不需要逐仓填写', () => {
    const onAdd = vi.fn((_items: RepoBulkAddItem[]) => true)
    render(
      <RepoBulkAddDialog
        open
        initialMode="repos"
        repos={repos}
        targetLabel="（任务根）"
        onClose={vi.fn()}
        onAdd={onAdd}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /20/ }))
    fireEvent.click(screen.getByTestId('repo-group-bulk-submit'))

    expect(onAdd).toHaveBeenCalledTimes(1)
    const submitted = onAdd.mock.calls[0]?.[0] ?? []
    expect(submitted).toHaveLength(20)
    expect(submitted[0]).toMatchObject({
      attachment: { kind: 'repo', cachedRepoId: 'repo-0', readonly: false },
    })
  })

  test('搜索后全选只选择当前结果', () => {
    const onAdd = vi.fn((_items: RepoBulkAddItem[]) => true)
    render(
      <RepoBulkAddDialog
        open
        initialMode="repos"
        repos={repos}
        targetLabel="apps"
        onClose={vi.fn()}
        onAdd={onAdd}
      />,
    )
    fireEvent.change(screen.getByTestId('repo-group-bulk-search'), {
      target: { value: 'repo-19.git' },
    })
    fireEvent.click(screen.getByRole('button', { name: /1/ }))
    fireEvent.click(screen.getByTestId('repo-group-bulk-submit'))
    expect(onAdd.mock.calls[0]?.[0]).toHaveLength(1)
  })

  test('URL 模式逐行报错并去重后一次提交', () => {
    const onAdd = vi.fn((_items: RepoBulkAddItem[]) => true)
    const onClose = vi.fn()
    render(
      <RepoBulkAddDialog
        open
        initialMode="urls"
        repos={repos}
        targetLabel="vendor"
        onClose={onClose}
        onAdd={onAdd}
      />,
    )

    const input = screen.getByTestId('repo-group-bulk-urls')
    fireEvent.change(input, { target: { value: 'not-a-url' } })
    expect(screen.getByRole('alert')).toBeTruthy()
    expect((screen.getByTestId('repo-group-bulk-submit') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, {
      target: {
        value:
          'https://git.example/acme/a.git\nhttps://git.example/acme/a.git\ngit@git.example:acme/b.git',
      },
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toMatch(/1/)
    fireEvent.click(screen.getByTestId('repo-group-bulk-submit'))

    expect(onAdd.mock.calls[0]?.[0]).toHaveLength(2)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('未应用的 URL 草稿在 × / Esc / 遮罩 / 取消前统一要求确认放弃', async () => {
    const onClose = vi.fn()
    const onDraftDirtyChange = vi.fn()
    render(
      <RepoBulkAddDialog
        open
        initialMode="urls"
        repos={repos}
        targetLabel="vendor"
        onClose={onClose}
        onAdd={vi.fn(() => true)}
        onDraftDirtyChange={onDraftDirtyChange}
      />,
    )

    fireEvent.change(screen.getByTestId('repo-group-bulk-urls'), {
      target: { value: 'https://git.example/acme/draft.git' },
    })
    // The router guard consumes this callback synchronously. A passive-effect
    // only publication lets an immediate WebKit Back escape with the draft.
    expect(onDraftDirtyChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Unsaved changes' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Stay on page' }))
    expect(screen.queryByRole('heading', { name: 'Unsaved changes' })).toBeNull()
    expect((screen.getByTestId('repo-group-bulk-urls') as HTMLTextAreaElement).value).toContain(
      'draft.git',
    )

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.getByRole('heading', { name: 'Unsaved changes' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onDraftDirtyChange).toHaveBeenLastCalledWith(false)
  })
})

import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  CachedRepo,
  PlannedDirectoryNode,
  PlannedRepo,
  RepoGroup,
  RepoGroupNodeInput,
} from '@agent-workflow/shared'
import { RepoTreeEditor } from '@/components/repos/RepoTreeEditor'

const nodes: RepoGroupNodeInput[] = [
  { path: '', attachment: null },
  { path: 'apps', attachment: null },
  {
    path: 'apps/web',
    attachment: {
      kind: 'repo',
      cachedRepoId: 'repo-web',
      ref: 'main',
      subdir: '',
      readonly: false,
    },
  },
  {
    path: 'vendor',
    attachment: { kind: 'group', childGroupId: 'group-sdk', readonly: true },
  },
]

const repo = {
  id: 'repo-web',
  urlRedacted: 'https://git.example/acme/web.git',
  defaultBranch: 'main',
} as CachedRepo

const childGroup = {
  id: 'group-sdk',
  name: 'SDK 集合',
} as RepoGroup

const previewNodes: PlannedDirectoryNode[] = [
  { path: '', origins: [] },
  { path: 'apps', origins: [] },
  { path: 'apps/web', origins: [] },
  { path: 'vendor', origins: [] },
  {
    path: 'vendor/docs',
    origins: [
      {
        groupId: 'child',
        groupName: 'SDK 集合',
        viaGroups: [
          { id: 'draft', name: '当前组' },
          { id: 'child', name: 'SDK 集合' },
        ],
      },
    ],
  },
]

const previewRepos: PlannedRepo[] = [
  {
    cachedRepoId: 'repo-docs',
    repoUrlRedacted: 'https://git.example/acme/docs.git',
    ref: '',
    subdir: '',
    mountPath: 'vendor/docs',
    readonly: true,
    viaGroups: [
      { id: 'draft', name: '当前组' },
      { id: 'child', name: 'SDK 集合' },
    ],
  },
]

function Harness({ onMove = vi.fn() }: { onMove?: (path: string, parent: string) => void }) {
  const [selectedPath, setSelectedPath] = useState('apps/web')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  return (
    <RepoTreeEditor
      nodes={nodes}
      selectedPath={selectedPath}
      checked={checked}
      repoById={new Map([[repo.id, repo]])}
      groupById={new Map([[childGroup.id, childGroup]])}
      previewNodes={previewNodes}
      previewRepos={previewRepos}
      nodeError={{ path: 'apps/web', message: 'ref 不存在' }}
      onSelect={setSelectedPath}
      onCheck={(path, value) =>
        setChecked((current) => {
          const next = new Set(current)
          if (value) next.add(path)
          else next.delete(path)
          return next
        })
      }
      onMove={onMove}
      renderSettings={(node) => <label data-testid="settings-content">设置 {node.path}</label>}
    />
  )
}

describe('RepoTreeEditor', () => {
  test('只在选中行下展开设置，并在键盘切换后把焦点带到新行', async () => {
    render(<Harness />)
    expect(screen.getAllByTestId('settings-content')).toHaveLength(1)
    expect(screen.getByTestId('settings-content').textContent).toContain('apps/web')

    const web = screen.getByTestId('repo-group-node-select-apps/web')
    web.focus()
    fireEvent.keyDown(web, { key: 'ArrowUp' })

    expect(screen.getByTestId('settings-content').textContent).toContain('apps')
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('repo-group-node-select-apps'))
    })
  })

  test('树暴露多选语义、节点错误与只读子组 ghost，但 ghost 不可编辑', () => {
    render(<Harness />)
    expect(screen.getByTestId('repo-group-nodes').getAttribute('aria-multiselectable')).toBe('true')
    expect(
      screen
        .getByTestId('repo-group-node-apps/web')
        .closest('[role="treeitem"]')
        ?.getAttribute('aria-invalid'),
    ).toBe('true')

    const ghost = screen.getByTestId('repo-group-ghost-vendor/docs')
    expect(ghost.getAttribute('aria-disabled')).toBe('true')
    expect(ghost.textContent).toContain('https://git.example/acme/docs.git')
    expect(ghost.querySelector('button')).toBeNull()
    expect(ghost.querySelector('input')).toBeNull()
  })

  test('复选进入多选态，拖放调用同一 move 回调', () => {
    const onMove = vi.fn()
    render(<Harness onMove={onMove} />)

    const appsRow = screen.getByTestId('repo-group-node-apps')
    const checkbox = appsRow.querySelector('input[type="checkbox"]')
    expect(checkbox).not.toBeNull()
    fireEvent.click(checkbox!)
    expect((checkbox as HTMLInputElement).checked).toBe(true)

    let draggedPath = ''
    const transfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData(_type: string, value: string) {
        draggedPath = value
      },
      getData() {
        return draggedPath
      },
    }
    fireEvent.dragStart(appsRow, { dataTransfer: transfer })
    fireEvent.drop(screen.getByTestId('repo-group-node-vendor'), { dataTransfer: transfer })
    expect(onMove).toHaveBeenCalledWith('apps', 'vendor')
  })
})

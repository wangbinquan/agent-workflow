// RFC-249 —— 显式目录树的纯函数回归锁。

import { describe, expect, test } from 'bun:test'
import {
  RepoGroupLayoutError,
  allocateRepoNodePath,
  attachAtNode,
  compareRepoNodePath,
  deleteNodeSubtree,
  detachAtNode,
  flattenRepoGroup,
  moveNodeSubtree,
  renameNodeSubtree,
  validateRepoGroupNodes,
  type FlattenableGroup,
  type RepoGroupNodeInput,
} from '../src/index'

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof RepoGroupLayoutError) return error.code
    return `unexpected:${String(error)}`
  }
  return 'no-throw'
}

const repoAttachment = (cachedRepoId: string) => ({
  kind: 'repo' as const,
  cachedRepoId,
  ref: '',
  subdir: '',
  readonly: false,
})

const persistedRepoAttachment = (cachedRepoId: string) => ({
  ...repoAttachment(cachedRepoId),
  repoUrlRedacted: `https://git.example/${cachedRepoId}.git`,
})

describe('RFC-249 explicit directory tree', () => {
  test('根、父节点与大小写碰撞是树级硬约束', () => {
    expect(codeOf(() => validateRepoGroupNodes([{ path: 'apps', attachment: null }]))).toBe(
      'repo-group-root-missing',
    )
    expect(
      codeOf(() =>
        validateRepoGroupNodes([
          { path: '', attachment: null },
          { path: 'apps/web', attachment: null },
        ]),
      ),
    ).toBe('repo-group-parent-missing')
    expect(
      codeOf(() =>
        validateRepoGroupNodes([
          { path: '', attachment: null },
          { path: 'Apps', attachment: null },
          { path: 'apps', attachment: null },
        ]),
      ),
    ).toBe('mount-path-duplicate')
  })

  test('重命名和移动原子改写整棵子树', () => {
    const nodes: RepoGroupNodeInput[] = [
      { path: '', attachment: null },
      { path: 'services', attachment: null },
      { path: 'services/api', attachment: repoAttachment('api') },
      { path: 'services/api/docs', attachment: null },
      { path: 'archive', attachment: null },
    ]
    const renamed = renameNodeSubtree(nodes, 'services/api', 'gateway')
    expect(renamed.map((node) => node.path)).toContain('services/gateway/docs')
    expect(renamed.map((node) => node.path)).not.toContain('services/api')

    const moved = moveNodeSubtree(renamed, 'services/gateway', 'archive')
    expect(moved.map((node) => node.path)).toContain('archive/gateway/docs')
    expect(moved.find((node) => node.path === 'archive/gateway')?.attachment).toMatchObject({
      cachedRepoId: 'api',
    })
    expect(codeOf(() => moveNodeSubtree(moved, 'archive', 'archive/gateway'))).toBe(
      'mount-path-traversal',
    )
  })

  test('删除目录级联删子树，挂载可单独脱离而保留目录', () => {
    const nodes: RepoGroupNodeInput[] = [
      { path: '', attachment: null },
      { path: 'apps', attachment: null },
      { path: 'apps/web', attachment: null },
      { path: 'apps/web/tests', attachment: null },
      { path: 'docs', attachment: null },
    ]
    const attached = attachAtNode(nodes, 'apps/web', repoAttachment('web'))
    expect(attached.find((node) => node.path === 'apps/web')?.attachment).not.toBeNull()
    const detached = detachAtNode(attached, 'apps/web')
    expect(detached.find((node) => node.path === 'apps/web')?.attachment).toBeNull()
    expect(deleteNodeSubtree(detached, 'apps').map((node) => node.path)).toEqual(['', 'docs'])
    expect(codeOf(() => deleteNodeSubtree(nodes, ''))).toBe('mount-path-traversal')
  })

  test('批量仓库名从 URL 推导，并在同目录下稳定避让', () => {
    const occupied = ['', 'sdk', 'sdk-2', 'tools']
    expect(allocateRepoNodePath('', 'git@github.com:org/sdk.git', occupied)).toBe('sdk-3')
    expect(allocateRepoNodePath('tools', 'https://example.com/org/my repo.git', occupied)).toBe(
      'tools/my-repo',
    )
  })

  test('展平保留纯目录，且目录挂子组不引入主仓语义', () => {
    const child: FlattenableGroup = {
      id: 'child',
      name: 'backend',
      nodes: [
        { path: '', attachment: persistedRepoAttachment('api') },
        { path: 'docs', attachment: null },
      ],
    }
    const root: FlattenableGroup = {
      id: 'root',
      name: 'workspace',
      nodes: [
        { path: '', attachment: null },
        { path: 'notes', attachment: null },
        {
          path: 'services',
          attachment: { kind: 'group', childGroupId: 'child', readonly: false },
        },
      ],
    }
    const byId = new Map([root, child].map((group) => [group.id, group]))
    const layout = flattenRepoGroup('root', (id) => byId.get(id))
    expect(layout.repos.map((repo) => repo.mountPath)).toEqual(['services'])
    expect(layout.nodes.map((node) => node.path).sort(compareRepoNodePath)).toEqual([
      '',
      'notes',
      'services',
      'services/docs',
    ])
  })

  test('两条展平路径在同节点挂两个仓时报 attachment conflict', () => {
    const child: FlattenableGroup = {
      id: 'child',
      name: 'child',
      nodes: [
        { path: '', attachment: null },
        { path: 'api', attachment: persistedRepoAttachment('child-api') },
      ],
    }
    const root: FlattenableGroup = {
      id: 'root',
      name: 'root',
      nodes: [
        { path: '', attachment: null },
        {
          path: 'services',
          attachment: { kind: 'group', childGroupId: 'child', readonly: false },
        },
        { path: 'services/api', attachment: persistedRepoAttachment('root-api') },
      ],
    }
    const byId = new Map([root, child].map((group) => [group.id, group]))
    expect(codeOf(() => flattenRepoGroup('root', (id) => byId.get(id)))).toBe(
      'repo-group-attachment-conflict',
    )
  })

  test('节点顺序按路径段稳定排列，父节点在子节点前', () => {
    const paths = ['z', 'a/b', 'Aardvark', '', 'a', 'a/b/c']
    expect(paths.sort(compareRepoNodePath)).toEqual(['', 'a', 'a/b', 'a/b/c', 'Aardvark', 'z'])

    const normalized = validateRepoGroupNodes([
      { path: 'z', attachment: null },
      { path: 'a/b', attachment: null },
      { path: '', attachment: null },
      { path: 'a', attachment: null },
    ])
    expect(normalized.map((node) => node.path)).toEqual(['', 'a', 'a/b', 'z'])
  })
})

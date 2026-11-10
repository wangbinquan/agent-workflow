// RFC-447 — 仓库组用例归 source-control（RFC-294 W4 B / D 第十三步）。
//
// 锁四件事：
// ① 位置与引用：`services/repoGroup.ts` 不存在，源码里没有文件 import 它（census 的 AST 提取，别名与相对路径都认，带负对照）；
//    用例在 `application/repositoryGroups.ts`，只依赖共享合同与同模块端口；路由对 source-control 只经 `public/types`、
//    不再收系统配置 / 仓库存储 / mirrors；legacy 的 `services/task.ts` 经 `public/queries` 取展平函数。
// ② 两个只转手存储的导出不随迁。
// ③ URL 现场登记由装配层按部署形态选择：托管走远端登记，单机每次写入取一次等待上限、走镜像缓存；不给导入函数时拒绝。
// ④ 合同的七个操作分别落到对应用例。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { CreateRepoGroup } from '@agent-workflow/shared'
import * as application from '@/modules/source-control/application/repositoryGroups'
import { composeRepositoryGroups } from '@/modules/source-control/composition'
import type {
  RepositoryGroupNodeRecord,
  RepositoryGroupRecord,
  RepositoryWorkspaceStore,
} from '@/modules/source-control/public/operations'
import type { RepositoryMirrors } from '@/modules/source-control/public/types'
import { mountRepoGroupRoutes } from '@/routes/repoGroups'
import { DomainError } from '@/util/errors'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const OLD_PATH = 'services/repoGroup'
const SC = 'modules/source-control'
const APPLICATION = `${SC}/application/repositoryGroups`

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** 文件的全部模块说明符（静态 / 类型 / 动态 import、export-from、require），去重；与 R1 账本同一口径。 */
function specifiersOf(path: string): string[] {
  const rel = relative(REPO_ROOT, path).split('\\').join('/')
  const unit = sourceUnit(rel, readFileSync(path, 'utf8'))
  return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
}

/** 说明符解析到 `src/` 下的路径（不带扩展名）；包名等非本地说明符返回 null。 */
function targetOf(from: string, specifier: string): string | null {
  let target: string
  if (specifier.startsWith('@/')) target = specifier.slice(2)
  else if (specifier.startsWith('.')) {
    target = relative(SRC, resolve(from, '..', specifier))
      .split('\\')
      .join('/')
  } else return null
  return target.replace(/\.[cm]?tsx?$/, '')
}

function targetsOf(rel: string): string[] {
  const path = join(SRC, rel)
  return specifiersOf(path).flatMap((specifier) => targetOf(path, specifier) ?? [])
}

function srcRelative(path: string): string {
  return relative(SRC, path).split('\\').join('/')
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  throw new Error('expected a DomainError')
}

/** 内存里的仓库组存储：只实现新建与读取用到的两个方法。 */
function memoryStore(registered: readonly string[] = []): {
  store: RepositoryWorkspaceStore
  nodes: RepositoryGroupNodeRecord[]
} {
  const groups: RepositoryGroupRecord[] = []
  const nodes: RepositoryGroupNodeRecord[] = []
  const repoUrls = new Map<string, string | null>(
    registered.map((id) => [id, `https://example.test/${id}.git`]),
  )
  const store = {
    readRepositoryGroupSnapshot: async () => ({
      groups,
      nodes,
      repoUrls,
      boundMemoryCounts: new Map<string, number>(),
      schedules: [],
    }),
    createRepositoryGroup: async (
      group: RepositoryGroupRecord,
      groupNodes: readonly RepositoryGroupNodeRecord[],
    ) => {
      groups.push(group)
      nodes.push(...groupNodes)
      for (const node of groupNodes)
        if (node.cachedRepoId !== null && !repoUrls.has(node.cachedRepoId))
          repoUrls.set(node.cachedRepoId, `https://example.test/${node.cachedRepoId}.git`)
      return 'created' as const
    },
  }
  return { store: store as unknown as RepositoryWorkspaceStore, nodes }
}

function urlGroup(url: string): CreateRepoGroup {
  return {
    name: 'grouped',
    description: '',
    nodes: [
      { path: '', attachment: null },
      {
        path: 'app',
        attachment: { kind: 'repo', repoUrl: url, ref: '', subdir: '', readonly: false },
      },
    ],
  }
}

const standaloneMirrors: RepositoryMirrors = {
  refs: async () => {
    throw new Error('unused')
  },
  files: async () => {
    throw new Error('unused')
  },
}

describe('RFC-447 —— 位置与引用', () => {
  test('旧文件不存在，用例、合同与装配各在新位置', () => {
    expect(existsSync(join(SRC, `${OLD_PATH}.ts`))).toBe(false)
    for (const file of [
      `${APPLICATION}.ts`,
      `${SC}/application/ports/repositoryGroups.ts`,
      `${SC}/composition/repositoryGroups.ts`,
    ])
      expect(existsSync(join(SRC, file))).toBe(true)
  })

  test('源码里没有文件 import 旧路径；用例文件的引用方都在 source-control 内', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(500)
    const offenders: string[] = []
    const importers: string[] = []
    for (const path of files) {
      for (const specifier of specifiersOf(path)) {
        const target = targetOf(path, specifier)
        if (target === OLD_PATH) offenders.push(`${srcRelative(path)} -> ${specifier}`)
        if (target === APPLICATION) importers.push(srcRelative(path))
      }
    }
    expect(offenders).toEqual([])
    // 非空对照：判据认得出新文件的全部引用方（装配与展平的三个模块内消费者）。RFC-478 撤掉了
    // public/queries 的转出——它模块外唯一的读者 services/task.ts 已退役。
    expect(importers.sort()).toEqual([
      `${SC}/composition/repositoryGroups.ts`,
      `${SC}/composition/repositoryPreparation.ts`,
      `${SC}/infrastructure/legacyWorkspaceRecovery.ts`,
      `${SC}/infrastructure/workspaceMaterializer.ts`,
    ])
  }, 60_000)

  test('负对照：同一判据认得出别名与相对路径两种写法，且不把路由文件当成旧路径', () => {
    const probe = join(SRC, 'routes', 'probe.ts')
    expect(targetOf(probe, '@/services/repoGroup')).toBe(OLD_PATH)
    expect(targetOf(probe, '../services/repoGroup.ts')).toBe(OLD_PATH)
    expect(targetOf(probe, './repoGroups')).not.toBe(OLD_PATH)
    expect(targetOf(probe, '@agent-workflow/shared')).toBeNull()
  })

  test('路由不 import services/，对 source-control 只经 public/types，也不再收配置、存储与 mirrors', () => {
    const targets = targetsOf('routes/repoGroups.ts')
    expect(targets.filter((target) => target.startsWith('services/'))).toEqual([])
    expect(targets.filter((target) => target.startsWith(`${SC}/`))).toEqual([`${SC}/public/types`])
    expect(targets.filter((target) => target.startsWith('modules/system-operations/'))).toEqual([])
    expect(mountRepoGroupRoutes.length).toBe(2)
  })

  test('用例文件只依赖共享合同与同模块端口；task-execution 的延后准备不直接取 source-control', () => {
    const targets = targetsOf(`${APPLICATION}.ts`)
    expect(targets.length).toBeGreaterThan(1)
    for (const target of targets)
      expect([
        `${SC}/ports/repositoryWorkspaceStore`,
        `${SC}/application/ports/repositoryGroups`,
        'util/errors',
      ]).toContain(target)
    // RFC-478: services/task.ts (which took the flatten function through `public/queries`) is gone; the deferred
    // repository preparation that inherited the call resolves group members through task's own preparation binding.
    expect(
      targetsOf('modules/task-execution/infrastructure/deferredRepositoryPreparation.ts').filter(
        (target) => target.startsWith(`${SC}/`),
      ),
    ).toEqual([])
  })
})

describe('RFC-447 —— 死转手', () => {
  test('只转手存储的两个导出不随迁；其余运行时导出不变', () => {
    expect(Object.keys(application).sort()).toEqual([
      'RepoGroupHasReferencesError',
      'createRepoGroup',
      'deleteRepoGroup',
      'getRepoGroup',
      'getRepoGroupLayoutResponse',
      'listRepoGroups',
      'previewRepoGroupLayout',
      'resolveRepoGroupLayout',
      'updateRepoGroup',
    ])
  })
})

describe('RFC-447 —— URL 现场登记的装配', () => {
  test('托管：URL 节点交给远端登记并用它返回的 id，不读等待上限', async () => {
    const { store, nodes } = memoryStore()
    const registered: string[] = []
    let budgetReads = 0
    const groups = composeRepositoryGroups({
      store,
      mirrors: {
        ...standaloneMirrors,
        remoteRegistration: {
          register: async (url) => {
            registered.push(url)
            return { cachedRepoId: 'cr-hosted', created: true }
          },
          refresh: async () => {
            throw new Error('unused')
          },
        },
      },
      cloneTimeoutMs: async () => {
        budgetReads += 1
        return 1_000
      },
    })
    const group = await groups.create(urlGroup('https://example.test/acme/app.git'), 'user-1')
    expect(registered).toEqual(['https://example.test/acme/app.git'])
    expect(nodes.map((node) => node.cachedRepoId)).toEqual([null, 'cr-hosted'])
    expect(group.nodes.find((node) => node.path === 'app')?.attachment).toMatchObject({
      kind: 'repo',
      cachedRepoId: 'cr-hosted',
    })
    expect(budgetReads).toBe(0)
  })

  test('单机：每次写入取一次等待上限，导入走镜像缓存（非法 URL 由镜像缓存以 repo-url-invalid 拒绝）', async () => {
    const { store } = memoryStore()
    let budgetReads = 0
    const groups = composeRepositoryGroups({
      store,
      mirrors: standaloneMirrors,
      cloneTimeoutMs: async () => {
        budgetReads += 1
        return undefined
      },
    })
    expect(await codeOf(() => groups.create(urlGroup('not a git url'), null))).toBe(
      'repo-url-invalid',
    )
    expect(budgetReads).toBe(1)
  })

  test('不给导入函数时，只带 URL 的节点以 repo-group-url-import-unavailable 拒绝', async () => {
    const { store } = memoryStore()
    expect(
      await codeOf(() =>
        application.createRepoGroup({ store }, urlGroup('https://example.test/x.git'), null),
      ),
    ).toBe('repo-group-url-import-unavailable')
  })

  test('节点已带 cachedRepoId 时不调用导入函数', async () => {
    const { store, nodes } = memoryStore(['cr-known'])
    let imports = 0
    await application.createRepoGroup(
      {
        store,
        importRepositoryUrl: async () => {
          imports += 1
          return 'unused'
        },
      },
      {
        name: 'known',
        description: '',
        nodes: [
          { path: '', attachment: null },
          {
            path: 'app',
            attachment: {
              kind: 'repo',
              cachedRepoId: 'cr-known',
              ref: '',
              subdir: '',
              readonly: false,
            },
          },
        ],
      },
      null,
    )
    expect(imports).toBe(0)
    expect(nodes.map((node) => node.cachedRepoId)).toEqual([null, 'cr-known'])
  })
})

describe('RFC-447 —— 合同转发', () => {
  test('七个操作分别落到对应用例：expectedVersion 与 force 原样传到存储', async () => {
    const calls: string[] = []
    const group: RepositoryGroupRecord = {
      id: 'g-1',
      name: 'one',
      description: '',
      version: 3,
      createdByUserId: null,
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 2,
    }
    const root: RepositoryGroupNodeRecord = {
      groupId: 'g-1',
      path: '',
      attachmentKind: null,
      cachedRepoId: null,
      ref: '',
      subdir: '',
      childGroupId: null,
      readonly: false,
    }
    const node: RepositoryGroupNodeRecord = {
      groupId: 'g-1',
      path: 'app',
      attachmentKind: 'repo',
      cachedRepoId: 'cr-1',
      ref: '',
      subdir: '',
      childGroupId: null,
      readonly: false,
    }
    const store = {
      readRepositoryGroupSnapshot: async () => ({
        groups: [group],
        nodes: [root, node],
        repoUrls: new Map([['cr-1', 'https://example.test/cr-1.git']]),
        boundMemoryCounts: new Map([['g-1', 2]]),
        schedules: [],
      }),
      updateRepositoryGroup: async (input: { readonly expectedVersion?: number }) => {
        calls.push(`update:${input.expectedVersion}`)
        return { status: 'missing' as const }
      },
      deleteRepositoryGroup: async (input: { readonly id: string }) => {
        calls.push(`delete:${input.id}`)
        return {
          status: 'ok' as const,
          archivedMemories: 2,
          detachedReferences: 0,
          disabledSchedules: 0,
        }
      },
    } as unknown as RepositoryWorkspaceStore
    const groups = composeRepositoryGroups({
      store,
      mirrors: standaloneMirrors,
      cloneTimeoutMs: async () => undefined,
    })
    const known = {
      kind: 'repo' as const,
      cachedRepoId: 'cr-1',
      ref: '',
      subdir: '',
      readonly: false,
    }
    expect((await groups.list()).map((item) => item.id)).toEqual(['g-1'])
    expect(await groups.get('g-1')).toMatchObject({ id: 'g-1', flatRepoCount: 1, boundMemories: 2 })
    expect(await groups.layout('g-1')).toMatchObject({ groupId: 'g-1', totalRepos: 1 })
    expect(
      await groups.preview({
        nodes: [
          { path: '', attachment: null },
          { path: 'docs', attachment: known },
        ],
      }),
    ).toMatchObject({
      groupId: '__draft__',
      totalRepos: 1,
      pendingImports: 0,
    })
    // 替换：存储回 missing 时转成 404；在那之前 expectedVersion 已原样传到存储。
    expect(
      await codeOf(() =>
        groups.update(
          'g-1',
          {
            name: 'one',
            description: '',
            nodes: [
              { path: '', attachment: null },
              { path: 'app', attachment: known },
            ],
          },
          7,
        ),
      ),
    ).toBe('repo-group-not-found')
    expect(await groups.remove('g-1', { force: true })).toEqual({
      archivedMemories: 2,
      detachedReferences: 0,
      disabledSchedules: 0,
    })
    expect(calls).toEqual(['update:7', 'delete:g-1'])
  })
})

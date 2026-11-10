// RFC-453 — workspace-insight 一族归新模块 workspace-insight（RFC-294 W4 B / D 第十八步、E5）。
//
// 锁五件事：
// ① 旧文件（`services/` 下 32 + 2 个、code-capability 的产物存储 7 个）已删除，`src/` 下零引用（census AST，别名与相对路径
//    都认，带负对照）；`routes/` 下零个文件 import `services/`（W4 B / D 的路由退出条件）；source-control 不 import workspace-insight。
// ② 分析引擎的语法表与 shared 的扩展名表逐项相等，source-control 类索引遍历的判定 `langIdForPath(extname(name))` 与原来的
//    `resolveLang(name) !== null` 逐例等价（点文件、多点名、大小写、无扩展名）；resolveLang 落在 domain、不用 `node:path`，
//    取扩展名与原来的 posix `extname` 逐例相同。
// ③ `composeTaskWorkspaceInsight` 只接必填参数（缺依赖在类型层不可表达），结果冻结；合同的方法落到装配时给的那批对象上。
// ④ 深度索引端口每次现取索引缓存单例（清空后拿到新实例，与用例原来自己取单例同语义）。
// ⑤ 叙述的成员门在路由里、配置读取之后紧挨触发调用；时间线比较器经 task-execution `public/queries`、repo key 经 shared 可用。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, posix, relative, resolve } from 'node:path'
import {
  canonicalRepoKeys,
  canonicalRepoKeysWire,
  LANG_ID_BY_EXTENSION,
  langIdForPath,
  type ChangeNarrative,
  type StructuralDiff,
} from '@agent-workflow/shared'
import {
  composeStructuralDeepIndexing,
  composeTaskWorkspaceInsight,
} from '@/modules/workspace-insight/composition'
import { EXT_RESOLUTION, resolveLang } from '@/modules/workspace-insight/domain/lang/languages'
import {
  resetScipIndexCache,
  scipIndexCache,
} from '@/modules/workspace-insight/infrastructure/deep/scipIndexCache'
import type { CodeReviewArtifactStore } from '@/modules/workspace-insight/public/types'
import { resetChangeNarrativeStateForTests } from '@/modules/workspace-insight/application/changeNarrative'
import { compareNodeRunsForTimeline } from '@/modules/task-execution/public/queries'
import { compareNodeRunsForTimeline as declared } from '@/modules/task-execution/application/reviewRoundTiming'
import type {
  TaskCallGraphWorkspaceReadModel,
  TaskCodeWorkspaceQueries,
} from '@/modules/task-execution/public/types'
import type { TaskWorktreeLocator } from '@/modules/task-execution/public/queries'
import type { RepositoryRevisionContentFactory } from '@/modules/source-control/public/participants'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const SD = 'services/structuralDiff/'
const CC = 'modules/code-capability/'
const REMOVED = [
  ...[
    'assemble',
    'baseline',
    'bodyDelta',
    'callGraph/classIndex',
    'callGraph/expandService',
    'callGraph/extractCalls',
    'callGraph/service',
    'classGraph',
    'deep/deepImpact',
    'deep/indexCache',
    'deep/indexers',
    'deep/runner',
    'deep/scip',
    'deep/service',
    'deps/diff',
    'deps/manifests',
    'digest',
    'gitBackend',
    'impact',
    'lang/extract',
    'lang/grammars',
    'lang/mask',
    'lang/parser',
    'lang/queries',
    'refSelect',
    'service',
    'store',
  ].map((file) => SD + file),
  'services/codeIntel/codeIntel',
  'services/codeIntel/fileSymbols',
  'services/codeIntel/snapshot',
  'services/changeNarrative',
  'services/worktreeFileContent',
  'services/repoLabels',
  'services/reviewRoundStart',
  CC + 'application/ports/codeReviewArtifacts',
  CC + 'infrastructure/local/fileCodeReviewArtifacts',
  CC + 'infrastructure/crewstation/objectCodeReviewArtifacts',
  CC + 'infrastructure/crewstation/codeReviewObjectSweep',
  CC + 'composition/codeReviewArtifacts',
  CC + 'composition/crewstationCodeReviewArtifacts',
  CC + 'public/participants',
]

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
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

function importsMatching(files: readonly string[], matches: (target: string) => boolean): string[] {
  return files.flatMap((path) => {
    const rel = relative(REPO_ROOT, path).split('\\').join('/')
    const unit = sourceUnit(rel, readFileSync(path, 'utf8'))
    return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
      .filter((specifier) => matches(targetOf(path, specifier) ?? ''))
      .map((specifier) => `${relative(SRC, path)} -> ${specifier}`)
  })
}

const isRemoved = (target: string) => REMOVED.includes(target)
const isLegacy = (target: string) => target.startsWith('services/')
const isWorkspaceInsight = (target: string) => target.startsWith('modules/workspace-insight/')

describe('RFC-453 —— 引用', () => {
  test('旧文件已删除，src/ 下零引用', () => {
    for (const file of REMOVED) expect(existsSync(join(SRC, `${file}.ts`)), file).toBe(false)
    expect(importsMatching(walk(SRC), isRemoved)).toEqual([])
  }, 60_000)

  test('routes/ 下零个文件 import services/（W4 B / D 路由退出条件）', () => {
    expect(importsMatching(walk(join(SRC, 'routes')), isLegacy)).toEqual([])
  })

  test('source-control 不 import workspace-insight（只有 workspace-insight → source-control 是给出的边）', () => {
    expect(
      importsMatching(walk(join(SRC, 'modules', 'source-control')), isWorkspaceInsight),
    ).toEqual([])
  })

  test('负对照：判据认得出别名与相对路径，也不误伤同前缀的文件', () => {
    const probe = join(SRC, 'routes', 'probe.ts')
    expect(isRemoved(targetOf(probe, '@/services/structuralDiff/service') ?? '')).toBe(true)
    expect(isRemoved(targetOf(probe, '../services/codeIntel/snapshot.ts') ?? '')).toBe(true)
    expect(isRemoved(targetOf(probe, '@/services/structuralDiff/serviceExtra') ?? '')).toBe(false)
    expect(isLegacy(targetOf(probe, '../services/legacyProbe') ?? '')).toBe(true)
    expect(isLegacy(targetOf(probe, '@/modules/task-execution/public/queries') ?? '')).toBe(false)
    const scProbe = join(SRC, 'modules', 'source-control', 'infrastructure', 'probe.ts')
    expect(
      isWorkspaceInsight(targetOf(scProbe, '../../workspace-insight/public/types') ?? ''),
    ).toBe(true)
  })
})

describe('RFC-453 —— 语言判定', () => {
  test('分析引擎的语法表与 shared 的扩展名表逐项相等', () => {
    expect(Object.keys(EXT_RESOLUTION).sort()).toEqual(Object.keys(LANG_ID_BY_EXTENSION).sort())
    for (const [ext, resolution] of Object.entries(EXT_RESOLUTION))
      expect([ext, resolution.lang as string]).toEqual([
        ext,
        LANG_ID_BY_EXTENSION[ext] ?? 'missing',
      ])
  })

  test('source-control 的判定与原来的 resolveLang 逐例等价', () => {
    const names = [
      'a.ts',
      'a.TS',
      'b.tsx',
      '.ts',
      '.py',
      '.foo.ts',
      'x.y.go',
      'Makefile',
      'a.',
      '...',
      'v.h',
      'w.hpp',
      'z.sc',
      'README.md',
      'archive.tar.gz',
    ]
    for (const name of names) {
      const before = resolveLang(name)
      const after = langIdForPath(extname(name))
      expect([name, after !== null]).toEqual([name, before !== null])
      if (before !== null) expect([name, after]).toEqual([name, before.lang])
    }
  })

  // 集中验证 R2 账本抓到 domain 文件 import `node:path`（domain 禁宿主路径模块）：resolveLang 改用纯字符串取扩展名，
  // 这里锁它与原来的 `posix.extname` 取法逐例相同（目录名带点、子目录点文件、尾随斜杠、`..`、大小写、多点名）。
  test('resolveLang 不用 node:path，取扩展名与原来的 posix extname 逐例相同', () => {
    const paths = [
      'src/a.ts',
      'src/A.TSX',
      'a.b/c',
      'dir.ts/README',
      'dir/.ts',
      '.cc',
      '..ts',
      'pkg/..',
      '..',
      '...',
      'x/a.',
      'src/a.ts/',
      'src/a.ts//',
      '/',
      '',
      'a/b.c.d.py',
      'lib/.foo.go',
      'v1.2/main',
      'Makefile',
    ]
    for (const path of paths)
      expect([path, resolveLang(path)]).toEqual([
        path,
        EXT_RESOLUTION[posix.extname(path).toLowerCase()] ?? null,
      ])
    // 负对照：至少一半用例真的解析到语言，另一半解析不到——两侧都有预言力。
    expect(paths.filter((path) => resolveLang(path) !== null).length).toBeGreaterThanOrEqual(6)
    expect(paths.filter((path) => resolveLang(path) === null).length).toBeGreaterThanOrEqual(6)
  })
})

function fakeInputs() {
  const calls: string[] = []
  const narrative = { inputDigest: 'd1' } as unknown as ChangeNarrative
  const workspace: TaskCodeWorkspaceQueries = {
    async findTask(taskId) {
      calls.push(`workspace.findTask:${taskId}`)
      return null
    },
    async listNodeRuns() {
      return []
    },
    async findNodeRun() {
      return null
    },
  }
  const artifacts: CodeReviewArtifactStore = {
    async readStructuralDiff(): Promise<StructuralDiff | null> {
      return null
    },
    async writeStructuralDiff() {},
    async readNarrative(taskId) {
      calls.push(`artifacts.readNarrative:${taskId}`)
      return narrative
    },
    async writeNarrative() {},
    async removeTask() {},
  }
  const worktrees: TaskWorktreeLocator = {
    async find(taskId) {
      calls.push(`worktrees.find:${taskId}`)
      return null
    },
  }
  const callGraphWorkspace: TaskCallGraphWorkspaceReadModel = {
    async find(taskId) {
      calls.push(`callGraph.find:${taskId}`)
      return null
    },
  }
  const content = {
    bind() {
      throw new Error('content is not reached for an unknown task')
    },
  } as unknown as RepositoryRevisionContentFactory
  const narrativeDeps = {
    async resolveRuntime(): Promise<never> {
      throw new Error('runtime is not reached for an unknown task')
    },
    systemAgents: {} as never,
  }
  return {
    calls,
    narrative,
    input: {
      workspace,
      content,
      artifacts,
      worktrees,
      callGraphWorkspace,
      narrative: narrativeDeps,
    },
  }
}

describe('RFC-453 —— 合同装配', () => {
  test('缺依赖在类型层不可表达（RFC-359 W1-T1），结果冻结', () => {
    const { input } = fakeInputs()
    const complete: Parameters<typeof composeTaskWorkspaceInsight>[0] = input
    const { artifacts: _artifacts, ...withoutArtifacts } = complete
    const { callGraphWorkspace: _callGraph, ...withoutCallGraph } = complete
    // @ts-expect-error the artifact store is required
    const missingArtifacts: Parameters<typeof composeTaskWorkspaceInsight>[0] = withoutArtifacts
    // @ts-expect-error the call-graph read model is required
    const missingCallGraph: Parameters<typeof composeTaskWorkspaceInsight>[0] = withoutCallGraph
    expect([missingArtifacts, missingCallGraph].map((value) => 'workspace' in value)).toEqual([
      true,
      true,
    ])
    expect(Object.isFrozen(composeTaskWorkspaceInsight(complete))).toBe(true)
  })

  test('合同的方法落到装配时给的那批对象上', async () => {
    const { calls, narrative, input } = fakeInputs()
    const insight = composeTaskWorkspaceInsight(input)
    resetChangeNarrativeStateForTests()
    expect(await insight.changeNarrativeStatus('t-status')).toEqual({ status: 'ready', narrative })
    await expect(
      insight.structuralDiff('t-diff', 'task', undefined, { mode: 'baseline' }),
    ).rejects.toMatchObject({ code: 'task-not-found' })
    await expect(
      insight.fileContent('t-content', { path: 'a.ts', side: 'worktree' }),
    ).rejects.toMatchObject({ code: 'task-not-found' })
    await expect(
      insight.fileSymbols('t-symbols', { path: 'a.ts', side: 'worktree' }),
    ).rejects.toMatchObject({ code: 'task-not-found' })
    await expect(
      insight.codeIntel('t-intel', {
        path: 'a.ts',
        side: 'worktree',
        line: 1,
        col: 1,
        name: 'a',
        mode: 'baseline',
      }),
    ).rejects.toMatchObject({ code: 'task-not-found' })
    await expect(insight.callTargets('t-calls', 'a.ts#A.run')).rejects.toMatchObject({
      code: 'task-not-found',
    })
    expect(calls).toEqual([
      'artifacts.readNarrative:t-status',
      'workspace.findTask:t-diff',
      'worktrees.find:t-content',
      'workspace.findTask:t-symbols',
      'workspace.findTask:t-intel',
      'callGraph.find:t-calls',
    ])
  })
})

describe('RFC-453 —— 深度索引端口', () => {
  test('每次现取索引缓存单例；清空后拿到新实例', () => {
    resetScipIndexCache()
    const deep = composeStructuralDeepIndexing()
    const first = deep.indexCache()
    expect(first).toBe(scipIndexCache())
    expect(deep.indexCache()).toBe(first)
    resetScipIndexCache()
    const second = deep.indexCache()
    expect(second).not.toBe(first)
    expect(second).toBe(scipIndexCache())
    resetScipIndexCache()
  })
})

describe('RFC-453 —— 路由与新入口', () => {
  test('叙述的成员门在配置读取之后、紧挨触发调用', () => {
    const route = readFileSync(join(SRC, 'routes', 'tasks.ts'), 'utf8')
    expect(route).toMatch(
      /const narrativeCfg = await deps\.configuration\.read\(\)\n\s*await changeNarrativeAccess\.requireMember\(actorOf\(c\), task\.id\)\n\s*const state = await workspaceInsight\.triggerChangeNarrative\(task, \{/,
    )
    expect(route).not.toContain('@/services/')
  })

  test('时间线比较器经 task-execution public/queries；repo key 经 shared', () => {
    expect(compareNodeRunsForTimeline).toBe(declared)
    const a = { id: 'a', seq: 2, startedAt: 10 }
    const b = { id: 'b', seq: 1, startedAt: 5, reviewRoundStartedAt: 20 }
    expect([b, a].sort(compareNodeRunsForTimeline).map((run) => run.id)).toEqual(['a', 'b'])
    const repos = [{ mountPath: '' }, { mountPath: 'apps/web' }]
    expect(canonicalRepoKeys(repos)).toEqual(['', 'apps/web'])
    expect(canonicalRepoKeysWire(repos)).toEqual(['.', 'apps/web'])
  })
})

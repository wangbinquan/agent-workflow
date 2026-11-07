// RFC-460 — 调用目标选择、运行期引用解析与信封 nonce 出 `services/`（RFC-294 W9-D 第七步）。
//
// 锁四件事：
// ① `services/execution/callRefTarget.ts` 与 `services/ref/runtimeRef.ts` 已删除，新位置都在；`src/`、用例、仓库根 `tests/` 与脚本
//    零 import 旧路径（census AST，带负对照）。
// ② 调用目标选择与运行期引用解析在后端与 shared 的源码里只有 shared `ref/` 一处定义，shared 入口导出的就是它。
// ③ 信封 nonce 只有 `platform/contracts/envelopeNonce.ts` 一处实现（task-execution 的旧名不在了），仍是 16 位小写 hex、每次不同。
// ④ intent 的 dump / 会话 / turn 与 memory 的调度不再取 `services/`，memory 蒸馏只剩 `services/runtime/types`（随运行时驱动一族）；
//    dump 的 seed 文件就是 intent 端口命名的那个形状。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import * as shared from '@agent-workflow/shared'
import * as callTarget from '../../shared/src/ref/callTarget'
import * as runtimeRef from '../../shared/src/ref/runtime'
import { generateEnvelopeNonce } from '@/platform/contracts/envelopeNonce'
import type {
  IntentSystemAgentRunRequest,
  IntentSystemSeedFile,
} from '@/modules/intent/application/ports/intentSystemAgent'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const SHARED_SRC = resolve(REPO_ROOT, 'packages', 'shared', 'src')
const TESTS = resolve(import.meta.dir)
const DELETED = ['services/execution/callRefTarget', 'services/ref/runtimeRef']
const RUNTIME_REF_FUNCTIONS = [
  'agentRefOfNode',
  'resolveNodeAgentRef',
  'fanoutInnerAgentRefKey',
  'agentSkillRef',
  'runtimeIdRef',
  'runtimeRefKey',
] as const

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

const slash = (path: string) => path.split('\\').join('/')

/** 说明符解析到 `src/` 下的路径（不带扩展名）；包名等非本地说明符返回 null。 */
function targetOf(from: string, specifier: string): string | null {
  let target: string
  if (specifier.startsWith('@/')) target = specifier.slice(2)
  else if (specifier.startsWith('.')) target = slash(relative(SRC, resolve(from, '..', specifier)))
  else return null
  return target.replace(/\.[cm]?tsx?$/, '')
}

function specifiersOf(path: string): string[] {
  const unit = sourceUnit(slash(relative(REPO_ROOT, path)), readFileSync(path, 'utf8'))
  return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
}

function importsOfDeleted(files: readonly string[]): string[] {
  return files.flatMap((path) =>
    specifiersOf(path)
      .map((specifier) => targetOf(path, specifier))
      .filter((target): target is string => target !== null && DELETED.includes(target))
      .map((target) => `${slash(relative(REPO_ROOT, path))} -> ${target}`),
  )
}

const servicesImportsOf = (path: string) =>
  specifiersOf(join(SRC, path))
    .filter((specifier) => specifier.startsWith('@/services/'))
    .sort()

describe('RFC-460 —— 两个文件迁出 services/', () => {
  test('旧文件不在了，新位置都在', () => {
    for (const from of DELETED)
      expect([from, existsSync(join(SRC, `${from}.ts`))]).toEqual([from, false])
    expect(existsSync(join(SHARED_SRC, 'ref', 'callTarget.ts'))).toBe(true)
    expect(existsSync(join(SHARED_SRC, 'ref', 'runtime.ts'))).toBe(true)
    expect(existsSync(join(SRC, 'platform', 'contracts', 'envelopeNonce.ts'))).toBe(true)
  })

  test('src/、用例、仓库根 tests/ 与脚本里零 import 旧路径', () => {
    expect(importsOfDeleted(walk(SRC))).toEqual([])
    expect(importsOfDeleted(walk(TESTS))).toEqual([])
    expect(importsOfDeleted(walk(join(REPO_ROOT, 'tests')))).toEqual([])
    expect(importsOfDeleted(walk(join(REPO_ROOT, 'scripts')))).toEqual([])
  }, 60_000)

  test('负对照：判据认得出别名与相对路径', () => {
    const probe = join(SRC, 'services', 'execution', 'probe.ts')
    expect(DELETED.includes(targetOf(probe, '@/services/ref/runtimeRef') ?? '')).toBe(true)
    expect(DELETED.includes(targetOf(probe, './callRefTarget') ?? '')).toBe(true)
    expect(DELETED.includes(targetOf(probe, './callRefTargetExtra') ?? '')).toBe(false)
  })
})

describe('RFC-460 —— 两件纯件只在 shared 的 ref/', () => {
  const corpus = [...walk(SRC), ...walk(SHARED_SRC)].map((path) => ({
    path: slash(relative(REPO_ROOT, path)),
    text: readFileSync(path, 'utf8'),
  }))
  const definers = (name: string) =>
    corpus
      .filter((file) => new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(file.text))
      .map((file) => file.path)

  test('每个函数在后端与 shared 源码里只有一处定义', () => {
    expect(definers('pickCallTarget')).toEqual(['packages/shared/src/ref/callTarget.ts'])
    for (const name of RUNTIME_REF_FUNCTIONS)
      expect([name, definers(name)]).toEqual([name, ['packages/shared/src/ref/runtime.ts']])
  })

  test('shared 入口导出的就是 ref/ 里那一份', () => {
    expect(shared.pickCallTarget).toBe(callTarget.pickCallTarget)
    for (const name of RUNTIME_REF_FUNCTIONS)
      expect([name, shared[name] === runtimeRef[name]]).toEqual([name, true])
  })

  test('调用目标选择的判据不变：id 缓存只在仍同名时生效，否则同名里最老的 ULID', () => {
    const rows = [
      { id: '01B', name: 'w' },
      { id: '01A', name: 'w' },
      { id: '01C', name: 'renamed' },
    ]
    expect(shared.pickCallTarget({ authoritativeName: 'w', idHint: '01B' }, rows)?.id).toBe('01B')
    expect(shared.pickCallTarget({ authoritativeName: 'w', idHint: '01C' }, rows)?.id).toBe('01A')
    expect(shared.pickCallTarget({ authoritativeName: 'w' }, rows)?.id).toBe('01A')
    expect(shared.pickCallTarget({ authoritativeName: 'missing' }, rows)).toBeUndefined()
  })
})

describe('RFC-460 —— 信封 nonce 只有一处实现', () => {
  test('platform/contracts 定义它，task-execution 的旧名不在了', () => {
    const corpus = walk(SRC).map((path) => ({
      path: slash(relative(SRC, path)),
      text: readFileSync(path, 'utf8'),
    }))
    expect(
      corpus
        .filter((file) => /export\s+function\s+generateEnvelopeNonce\b/.test(file.text))
        .map((file) => file.path),
    ).toEqual(['platform/contracts/envelopeNonce.ts'])
    expect(
      corpus.filter((file) => /function\s+generateNodeRunEnvelopeNonce\b/.test(file.text)),
    ).toEqual([])
  }, 30_000)

  test('仍是 64 位随机的小写 hex，每次不同', () => {
    const a = generateEnvelopeNonce()
    const b = generateEnvelopeNonce()
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(b).toMatch(/^[0-9a-f]{16}$/)
    expect(a).not.toBe(b)
  })
})

describe('RFC-460 —— intent 与 memory 的这几处不再经 services/ 转手', () => {
  test('intent dump / 会话 / turn、memory 调度零取 services/；memory 蒸馏只剩运行时类型', () => {
    expect(servicesImportsOf('modules/intent/application/dumpBuilder.ts')).toEqual([])
    expect(servicesImportsOf('modules/intent/application/session.ts')).toEqual([])
    expect(servicesImportsOf('modules/intent/application/turnEngine.ts')).toEqual([])
    expect(
      servicesImportsOf('modules/intent/infrastructure/intentSqlPersistence.ts'),
    ).not.toContain('@/services/nodeRunMint')
    expect(servicesImportsOf('modules/memory/application/distill/schedule.ts')).toEqual([])
    expect(servicesImportsOf('modules/memory/application/distill/memoryDistiller.ts')).toEqual([
      '@/services/runtime/types',
    ])
  })

  test('dump 的 seed 文件就是 intent 端口命名的形状', () => {
    expect(specifiersOf(join(SRC, 'modules/intent/application/dumpBuilder.ts'))).toContain(
      './ports/intentSystemAgent',
    )
    const files: IntentSystemSeedFile[] = [{ path: 'inventory/runtimes.md', content: '' }]
    const request: Pick<IntentSystemAgentRunRequest, 'seedFiles'> = { seedFiles: files }
    expect(request.seedFiles).toBe(files)
  })
})

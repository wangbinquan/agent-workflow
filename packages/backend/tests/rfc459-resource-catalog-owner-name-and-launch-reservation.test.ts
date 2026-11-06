// RFC-459 — owner 作用域名与代理启动保留归 resource-catalog（RFC-294 W9-D 第六步）。
//
// 锁四件事：
// ① 三个 `services/` 文件与 identity-access 的两份 owner 名实现都不在了，新位置都在；`src/`、用例、仓库根 `tests/` 与脚本零 import
//    旧路径（census AST，带负对照）。
// ② owner 名的谓词、冲突判定与两个兼容名只在 resource-catalog 定义一份；identity-access 不再从 composition / public 再导出它们。
// ③ 代理启动保留只有一张进程内表：resource-catalog `public/participants` 给 task-execution 的 acquire / release 就是 application 那一份，
//    删除守卫读到的是同一张表；task-execution 只经 public 取它。
// ④ 只剩用例在用的身份门面住在用例 helper 里，生产代码不再有它。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import * as rcParticipants from '@/modules/resource-catalog/public/participants'
import * as reservation from '@/modules/resource-catalog/application/agents/agentLaunchReservation'
import * as iaOperations from '@/modules/identity-access/public/operations'
import * as iaProviderOperations from '@/modules/identity-access/composition/providerOperations'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RC = 'modules/resource-catalog/'
const IA = 'modules/identity-access/'
const DELETED = [
  'services/ownerScopedName',
  'services/agentLaunchReservation',
  'services/userIdentities',
  IA + 'infrastructure/ownerScopedName',
  IA + 'application/ownerScopedName',
]
const PRESENT = [
  `src/${RC}infrastructure/ownerScopedName.ts`,
  `src/${RC}application/ownerScopedName.ts`,
  `src/${RC}application/agents/agentLaunchReservation.ts`,
  'tests/helpers/userIdentities.ts',
]

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

function importsMatching(files: readonly string[], matches: (target: string) => boolean): string[] {
  return files.flatMap((path) => {
    const unit = sourceUnit(slash(relative(REPO_ROOT, path)), readFileSync(path, 'utf8'))
    return [...new Set(importEdges(unit).map((edge) => targetOf(path, edge.specifier)))]
      .filter((target): target is string => target !== null && matches(target))
      .map((target) => `${slash(relative(REPO_ROOT, path))} -> ${target}`)
  })
}

const isDeleted = (target: string) => DELETED.includes(target)

describe('RFC-459 —— 旧位置清空、新位置就位', () => {
  test('旧文件都不在了，新位置都在', () => {
    for (const from of DELETED)
      expect([from, existsSync(join(SRC, `${from}.ts`))]).toEqual([from, false])
    for (const to of PRESENT)
      expect([to, existsSync(resolve(import.meta.dir, '..', to))]).toEqual([to, true])
  })

  test('src/、用例、仓库根 tests/ 与脚本里零 import 旧路径', () => {
    expect(importsMatching(walk(SRC), isDeleted)).toEqual([])
    expect(importsMatching(walk(TESTS), isDeleted)).toEqual([])
    expect(importsMatching(walk(join(REPO_ROOT, 'tests')), isDeleted)).toEqual([])
    expect(importsMatching(walk(join(REPO_ROOT, 'scripts')), isDeleted)).toEqual([])
  }, 60_000)

  test('负对照：判据认得出别名与相对路径', () => {
    const probe = join(SRC, 'services', 'probe.ts')
    expect(isDeleted(targetOf(probe, '@/services/ownerScopedName') ?? '')).toBe(true)
    expect(
      isDeleted(targetOf(probe, '../modules/identity-access/application/ownerScopedName') ?? ''),
    ).toBe(true)
    expect(isDeleted(targetOf(probe, './agentLaunchReservationExtra') ?? '')).toBe(false)
  })
})

describe('RFC-459 —— owner 作用域名只在 resource-catalog', () => {
  test('谓词、冲突判定与两个兼容名在后端源码里只有 resource-catalog 一处定义', () => {
    const corpus = walk(SRC).map((path) => ({
      path: slash(relative(SRC, path)),
      text: readFileSync(path, 'utf8'),
    }))
    const definers = (name: string) =>
      corpus
        .filter((file) => new RegExp(`export\\s+function\\s+${name}\\b`).test(file.text))
        .map((file) => file.path)
    expect(definers('ownerScopedNameCondition')).toEqual([`${RC}infrastructure/ownerScopedName.ts`])
    expect(definers('ownerScopedNameWhere')).toEqual([`${RC}infrastructure/ownerScopedName.ts`])
    expect(definers('isOwnerNameUniqueViolation')).toEqual([
      `${RC}infrastructure/ownerScopedName.ts`,
    ])
    expect(definers('isOwnerScopedNameConflict')).toEqual([`${RC}application/ownerScopedName.ts`])
  }, 30_000)

  test('identity-access 不再再导出它们', () => {
    expect('isOwnerScopedNameConflict' in iaOperations).toBe(false)
    expect('ownerScopedNameCondition' in iaProviderOperations).toBe(false)
  })
})

describe('RFC-459 —— 代理启动保留只有一张进程内表', () => {
  test('public/participants 给出的就是 application 那一份', () => {
    expect(rcParticipants.acquireAgentLaunch).toBe(reservation.acquireAgentLaunch)
    expect(rcParticipants.releaseAgentLaunch).toBe(reservation.releaseAgentLaunch)
  })

  test('经 public 持有的启动，删除守卫读得到；引用计数到 0 才放开', () => {
    const agentId = 'rfc459-reservation-probe'
    expect(reservation.isAgentLaunching(agentId)).toBe(false)
    rcParticipants.acquireAgentLaunch(agentId)
    rcParticipants.acquireAgentLaunch(agentId)
    expect(reservation.isAgentLaunching(agentId)).toBe(true)
    rcParticipants.releaseAgentLaunch(agentId)
    expect(reservation.isAgentLaunching(agentId)).toBe(true)
    rcParticipants.releaseAgentLaunch(agentId)
    expect(reservation.isAgentLaunching(agentId)).toBe(false)
    rcParticipants.releaseAgentLaunch(agentId)
    expect(reservation.isAgentLaunching(agentId)).toBe(false)
  })

  test('task-execution 只经 resource-catalog public 取保留表', () => {
    const te = walk(join(SRC, 'modules', 'task-execution'))
    expect(
      importsMatching(te, (t) => t === `${RC}application/agents/agentLaunchReservation`),
    ).toEqual([])
    expect(
      importsMatching(
        [join(SRC, 'modules/task-execution/infrastructure/taskRouteLaunchOperations.ts')],
        (t) => t === `${RC}public/participants`,
      ),
    ).toEqual([
      `packages/backend/src/modules/task-execution/infrastructure/taskRouteLaunchOperations.ts -> ${RC}public/participants`,
    ])
  })
})

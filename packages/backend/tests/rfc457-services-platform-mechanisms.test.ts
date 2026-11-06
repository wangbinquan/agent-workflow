// RFC-457 — `services/` 的平台机制归 `platform`（RFC-294 W9-D 第四步）。
//
// 锁四件事：
// ① 8 个文件迁入 platform、启动器兼容入口删除；`src/`、用例与脚本零 import 旧路径（census AST，别名与相对路径都认，带负对照）。
// ② 8 个新文件只取 util / shared / node 与 platform，不取 `modules/`、`services/`；`platform/` 取 `services/` 的边恰好只剩
//    source-control 一族的 3 条（`gitSubmodule` ×2、`mergeAgent`），不会悄悄长回来。
// ③ 备份 VACUUM Worker 是发布二进制的额外入口：构建脚本的 `WORKER_ENTRIES`、架构门的 `BINARY_ENTRIES` 与 `systemProviderBackup.ts`
//    的编译态 / 源码态路径指向同一个存在的文件（RFC-311 实现门 P0-1：路径对不上时发布版里 Worker ModuleNotFound，备份退回主线程）。
// ④ `main.ts` 直取平台的启动器模块，不再经 `services/`。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { BINARY_ENTRIES } from './architecture/rfc294Gates'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const SCRIPTS = [join(REPO_ROOT, 'scripts'), resolve(import.meta.dir, '..', 'scripts')]

const MOVED: Readonly<Record<string, string>> = {
  'services/daemonCadence': 'platform/background/daemonCadence',
  'services/maintenanceTicker': 'platform/background/maintenanceTicker',
  'services/rawDbSnapshot': 'platform/persistence/sqlite/rawDbSnapshot',
  'services/backupVacuumWorker': 'platform/persistence/sqlite/backupVacuumWorker',
  'services/portableBackupArchive': 'platform/persistence/portableBackupArchive',
  'services/worktreeBackup': 'platform/persistence/worktreeBackup',
  'services/gitVersion': 'platform/workspace/local/gitVersion',
  'services/configAppliedListeners': 'platform/configuration/configAppliedListeners',
}
const DELETED = [...Object.keys(MOVED), 'services/execution/managedProcessLauncher']

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

/** `file -> target` for every import / re-export whose target satisfies `matches`. */
function importsMatching(files: readonly string[], matches: (target: string) => boolean): string[] {
  return files.flatMap((path) => {
    const unit = sourceUnit(slash(relative(REPO_ROOT, path)), readFileSync(path, 'utf8'))
    return [...new Set(importEdges(unit).map((edge) => targetOf(path, edge.specifier)))]
      .filter((target): target is string => target !== null && matches(target))
      .map((target) => `${slash(relative(SRC, path))} -> ${target}`)
  })
}

const isDeleted = (target: string) => DELETED.includes(target)
const srcFile = (rel: string) => join(SRC, rel)

describe('RFC-457 —— 平台机制迁出 services/', () => {
  test('9 个旧文件都不在了，8 个新位置都在', () => {
    for (const from of DELETED)
      expect([from, existsSync(srcFile(`${from}.ts`))]).toEqual([from, false])
    for (const to of Object.values(MOVED))
      expect([to, existsSync(srcFile(`${to}.ts`))]).toEqual([to, true])
  })

  test('src/、用例与脚本里零 import 旧路径', () => {
    expect(importsMatching(walk(SRC), isDeleted)).toEqual([])
    expect(importsMatching(walk(TESTS), isDeleted)).toEqual([])
    expect(importsMatching(SCRIPTS.flatMap(walk), isDeleted)).toEqual([])
  }, 60_000)

  test('负对照：判据认得出别名与相对路径，也不误伤同前缀的文件', () => {
    const probe = srcFile('services/probe.ts')
    expect(isDeleted(targetOf(probe, '@/services/gitVersion') ?? '')).toBe(true)
    expect(isDeleted(targetOf(probe, './execution/managedProcessLauncher.ts') ?? '')).toBe(true)
    expect(isDeleted(targetOf(probe, './gitVersionExtra') ?? '')).toBe(false)
    expect(
      importsMatching([srcFile('main.ts')], (t) => t.includes('managedProcessLauncher')),
    ).toEqual(['main.ts -> platform/execution/local/managedProcessLauncher'])
  })
})

describe('RFC-457 —— 平台不取 legacy 与模块', () => {
  const movedFiles = Object.values(MOVED).map((to) => srcFile(`${to}.ts`))

  test('8 个新文件不取 modules/ 与 services/', () => {
    expect(
      importsMatching(movedFiles, (t) => t.startsWith('modules/') || t.startsWith('services/')),
    ).toEqual([])
  })

  test('platform/ 取 services/ 的边只剩 source-control 一族的 3 条', () => {
    expect(
      importsMatching(walk(join(SRC, 'platform')), (t) => t.startsWith('services/')).sort(),
    ).toEqual([
      'platform/workspace/local/isolation.ts -> services/gitSubmodule',
      'platform/workspace/local/isolation.ts -> services/mergeAgent',
      'platform/workspace/local/submoduleParams.ts -> services/gitSubmodule',
    ])
  }, 30_000)

  test('负对照：判据认得出平台文件取 legacy', () => {
    const probe = srcFile('platform/background/probe.ts')
    expect(targetOf(probe, '@/services/daemonCadence')).toBe('services/daemonCadence')
    expect(targetOf(probe, '../../services/maintenanceTicker')).toBe('services/maintenanceTicker')
    expect(targetOf(probe, './daemonCadence')).toBe('platform/background/daemonCadence')
  })
})

describe('RFC-457 —— 备份 VACUUM Worker 的三处入口路径', () => {
  const WORKER = 'platform/persistence/sqlite/backupVacuumWorker.ts'

  test('构建脚本、架构门与 systemProviderBackup 指向同一个存在的文件', () => {
    expect(existsSync(srcFile(WORKER))).toBe(true)

    const build = readFileSync(join(REPO_ROOT, 'scripts', 'build-binary.ts'), 'utf8')
    const workerList = build.slice(build.indexOf('const WORKER_ENTRIES = ['))
    const entries = [
      ...workerList.slice(0, workerList.indexOf(']')).matchAll(/join\(backendSrc, ([^)]*)\)/g),
    ].map((match) => [...match[1]!.matchAll(/'([^']+)'/g)].map((part) => part[1]).join('/'))
    expect(entries).toContain(WORKER)
    expect(entries.every((entry) => existsSync(srcFile(entry)))).toBe(true)

    expect(BINARY_ENTRIES).toContain(`packages/backend/src/${WORKER}`)

    const backupFile = srcFile('platform/persistence/sqlite/systemProviderBackup.ts')
    const backup = readFileSync(backupFile, 'utf8')
    // 编译态：`$bunfs` 里按入口共同根 `src/` 的相对路径
    expect(backup).toContain(`? './${WORKER}'`)
    // 源码态：相对 systemProviderBackup.ts 解析
    const devUrl = backup.match(/: new URL\('([^']+)', import\.meta\.url\)\.href/)?.[1]
    expect(devUrl).toBeDefined()
    expect(slash(relative(SRC, resolve(dirname(backupFile), devUrl!)))).toBe(WORKER)
  })

  test('负对照：路径解析认得出指错的位置', () => {
    const backupDir = dirname(srcFile('platform/persistence/sqlite/systemProviderBackup.ts'))
    expect(
      slash(relative(SRC, resolve(backupDir, '../../../services/backupVacuumWorker.ts'))),
    ).toBe('services/backupVacuumWorker.ts')
    expect(existsSync(srcFile('services/backupVacuumWorker.ts'))).toBe(false)
  })
})

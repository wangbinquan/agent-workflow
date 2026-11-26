// RFC-612 — source-control 组合层里余下的两份实现归 infrastructure（RFC-294 S10 余项：composition 只装配）。
//
// 为什么存在：source-control 的 `composition/` 里有两处不是装配期选择、而是每次调用都走的实现：
// - 缓存仓库操作（`CachedRepositoryOperations` 端口的实现）：刷新时远端登记走镜像、本机镜像缓存去 fetch，批量导入读当时的设置；
// - 仓库组写入的 URL 导入：托管登记已验证的远端，单机克隆（或复用）镜像并按克隆预算等待。
// 两者都取决于所选镜像的实现，属于 infrastructure；现在前者原样在 `infrastructure/cachedRepositoryOperations.ts`，后者的选择在
// `infrastructure/repositoryUrlImport.ts`，组合层只把用例绑到存储与 URL 导入上。锁三件事：
// ① 落位：组合层没有 `cachedRepositoryOperations.ts`；`composition/repositoryGroups.ts` 没有分支、不再 import 本机镜像缓存；
//    模块根照旧转出两个名字（取自 infrastructure）。
// ② 行为：远端登记时 URL 导入走 `register`、不读克隆预算；本机镜像缓存时每次写入读一次克隆预算。
// ③ 范围：候选与提交两个绑定（装配期选择）之外，source-control 的组合层没有控制流（写成“范围之外为空”，后继收掉那几行时不用改这里）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import type { RepositoryMirrors } from '@/modules/source-control/application/ports/repositoryMirrors'
import { repositoryUrlImportFor } from '@/modules/source-control/infrastructure/repositoryUrlImport'
import type { RepositoryWorkspaceStore } from '@/modules/source-control/ports/repositoryWorkspaceStore'
import { compositionControlFlowSets, createGateCorpus } from './architecture/rfc294Gates'
import { sourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SC = 'packages/backend/src/modules/source-control/'
const read = (path: string) => readFileSync(join(REPO, path), 'utf8')

function controlFlowLines(path: string): string[] {
  return (
    compositionControlFlowSets(createGateCorpus([sourceUnit(path, read(path))]))[
      'composition-control-flow-source-control'
    ] ?? []
  )
}

function specifiers(path: string): string[] {
  const unit = sourceUnit(path, read(path))
  return unit.source.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  )
}

const unusedStore = new Proxy({} as RepositoryWorkspaceStore, {
  get(_target, member) {
    throw new Error(`store.${String(member)} is not used by this test`)
  },
})

describe('RFC-612 —— source-control 组合层里的两份实现归 infrastructure', () => {
  test('组合层没有缓存仓库操作的实现，仓库组的装配没有分支', () => {
    expect(existsSync(join(REPO, SC + 'composition/cachedRepositoryOperations.ts'))).toBe(false)
    expect(existsSync(join(REPO, SC + 'infrastructure/cachedRepositoryOperations.ts'))).toBe(true)
    const groups = SC + 'composition/repositoryGroups.ts'
    expect(controlFlowLines(groups)).toEqual([])
    expect(specifiers(groups)).toContain('../infrastructure/repositoryUrlImport')
    expect(specifiers(groups)).not.toContain('../infrastructure/local/repositoryMirrorCache')
    const root = specifiers(SC + 'composition.ts')
    expect(root).toContain('./infrastructure/cachedRepositoryOperations')
    expect(root).toContain('./infrastructure/repositoryUrlImport')
    expect(root).not.toContain('./composition/cachedRepositoryOperations')
  })

  test('负对照：判据认得出组合层里的一个分支', () => {
    const path = SC + 'composition/probe.ts'
    expect(
      compositionControlFlowSets(
        createGateCorpus([
          sourceUnit(
            path,
            'export function pick(remote: boolean) {\n  if (remote) return 1\n  return 0\n}\n',
          ),
        ]),
      )['composition-control-flow-source-control'],
    ).toEqual([`${path}:2:branch`])
  })

  test('远端登记时 URL 导入走 register、不读克隆预算', async () => {
    const registered: string[] = []
    let budgetReads = 0
    const mirrors = {
      registration: {
        kind: 'remote',
        async register(url: string) {
          registered.push(url)
          return { cachedRepoId: `repo:${url}` }
        },
      },
    } as unknown as RepositoryMirrors
    const urlImport = repositoryUrlImportFor({
      store: unusedStore,
      mirrors,
      cloneTimeoutMs: async () => {
        budgetReads += 1
        return 5_000
      },
    })
    const importer = await urlImport()
    expect(await importer('https://example.test/a.git')).toBe('repo:https://example.test/a.git')
    expect(registered).toEqual(['https://example.test/a.git'])
    expect(budgetReads).toBe(0)
  })

  test('本机镜像缓存时每次写入读一次克隆预算', async () => {
    let budgetReads = 0
    const mirrors = { registration: { kind: 'mirror-cache' } } as unknown as RepositoryMirrors
    const urlImport = repositoryUrlImportFor({
      store: unusedStore,
      mirrors,
      cloneTimeoutMs: async () => {
        budgetReads += 1
        return undefined
      },
    })
    expect(typeof (await urlImport())).toBe('function')
    expect(typeof (await urlImport())).toBe('function')
    expect(budgetReads).toBe(2)
  })

  test('source-control 的组合层没有控制流（RFC-622 起候选与提交两个绑定也迁入 application）', () => {
    const dir = join(REPO, SC + 'composition')
    const files = [
      SC + 'composition.ts',
      ...readdirSync(dir, { recursive: true })
        .map(String)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => SC + 'composition/' + name),
    ]
    expect(files.length).toBeGreaterThan(10)
    const lines =
      compositionControlFlowSets(
        createGateCorpus(files.map((path) => sourceUnit(path, read(path)))),
      )['composition-control-flow-source-control'] ?? []
    expect(lines).toEqual([])
  })
})

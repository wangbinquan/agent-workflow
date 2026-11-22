// RFC-531 — 部署选择合同的槽位改为语义类型、镜像与子仓刷新由 profile 选择（RFC-294 S12 第十二步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① `bootstrap/deploymentProfile.ts` 里没有类型查询（`typeof`）——合同的槽位都是拥有方模块的具名选择类型。
// ② 托管一族的文件（路径含 `crewstation`）与 `bootstrap/daemon*.ts` 不按本地 / 文件 / 原生工厂的签名定型
//    （没有 `typeof compose|create|select|bind` + `Local|File|Native` 的类型查询）（语料下限 3,000）。
// ③ daemon 不读已删去的 `repositoryRemote`；合同有必填的 `repositoryMirrors` 与 `repositoryMirrorRefresh`，两个 profile 都给出。
// ④ 托管的镜像刷新什么都不做（行为）。负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'
import { idleRepositoryMirrorRefresh } from '@/modules/source-control/composition'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const PROFILE = SRC + 'bootstrap/deploymentProfile.ts'
const STANDALONE = SRC + 'bootstrap/standalone.ts'
const HOSTED = SRC + 'bootstrap/crewstation.ts'
const CORPUS_TIMEOUT = 30_000
const LOCAL_FACTORY = /^(compose|create|select|bind)(Local|File|Native)[A-Z]/
const NEW_SELECTIONS = ['repositoryMirrors', 'repositoryMirrorRefresh'] as const

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

function leftmost(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : leftmost(name.left)
}

const daemonFile = (path: string) =>
  /^packages\/backend\/src\/bootstrap\/daemon[A-Za-z]*\.ts$/.test(path)
const hostedFile = (path: string) => path.startsWith(SRC) && /crewstation/i.test(path)

function statedKeys(unit: SourceUnit, holder: string): Set<string> {
  const keys = new Set<string>()
  walk(unit.source, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(unit.source) === holder &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      for (const property of node.initializer.properties)
        if (property.name !== undefined) keys.add(property.name.getText(unit.source))
  })
  return keys
}

export function deploymentSelectionViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const profile = byPath.get(PROFILE)
  if (profile === undefined) errors.add('missing source: ' + PROFILE)
  else {
    walk(profile.source, (node) => {
      if (ts.isTypeQueryNode(node))
        errors.add(`type query in the contract:${leftmost(node.exprName)}`)
    })
    const contract = profile.source.statements.find(
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === 'DeploymentSelections',
    )
    const members = new Set(contract?.members.map((member) => member.name?.getText(profile.source)))
    if (members.has('repositoryRemote')) errors.add('contract keeps repositoryRemote')
    for (const name of NEW_SELECTIONS)
      if (!members.has(name)) errors.add('contract missing:' + name)
  }
  for (const unit of units) {
    if (!daemonFile(unit.path) && !hostedFile(unit.path)) continue
    walk(unit.source, (node) => {
      if (ts.isTypeQueryNode(node) && LOCAL_FACTORY.test(leftmost(node.exprName)))
        errors.add(`typed by a local factory:${unit.path}:${leftmost(node.exprName)}`)
      if (daemonFile(unit.path) && ts.isIdentifier(node) && node.text === 'repositoryRemote')
        errors.add(`daemon reads repositoryRemote:${unit.path}`)
    })
  }
  for (const [path, holder] of [
    [STANDALONE, 'selections'],
    [HOSTED, 'selections'],
  ] as const) {
    const unit = byPath.get(path)
    if (unit === undefined) {
      errors.add('missing source: ' + path)
      continue
    }
    // The standalone builder returns its literal; the hosted profile states it under `selections`.
    const keys = path === STANDALONE ? returnedKeys(unit) : statedKeys(unit, holder)
    for (const name of NEW_SELECTIONS)
      if (!keys.has(name)) errors.add(`${path} does not state ${name}`)
  }
  return [...errors].sort()
}

function returnedKeys(unit: SourceUnit): Set<string> {
  const keys = new Set<string>()
  const builder = unit.source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'standaloneSelections',
  )
  if (builder === undefined) return keys
  walk(builder, (node) => {
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isObjectLiteralExpression(node.expression)
    )
      for (const property of node.expression.properties)
        if (property.name !== undefined) keys.add(property.name.getText(unit.source))
  })
  return keys
}

describe('RFC-531 ①～③ 合同的槽位是语义类型；镜像与刷新由 profile 选择', () => {
  test(
    '真实语料：合同里没有类型查询，托管一族与 daemon 不按本地工厂签名定型，daemon 不读 repositoryRemote，两个 profile 都给出两个新选择',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(deploymentSelectionViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-531 ④ 托管的镜像刷新什么都不做', () => {
  test('停止什么都不做，重读配置不改变计划，空闲立即完成', async () => {
    expect(Object.isFrozen(idleRepositoryMirrorRefresh)).toBe(true)
    expect(idleRepositoryMirrorRefresh.stop()).toBeUndefined()
    expect(await idleRepositoryMirrorRefresh.reconfigure()).toBe(false)
    expect(await idleRepositoryMirrorRefresh.awaitIdle()).toBeUndefined()
  })
})

describe('RFC-531 负对照', () => {
  const profile = (members: string) =>
    sourceUnit(
      PROFILE,
      `export interface DeploymentSelections {\n${members}\n  readonly repositoryMirrors: A\n  readonly repositoryMirrorRefresh: B\n}`,
    )
  const standalone = sourceUnit(
    STANDALONE,
    'export function standaloneSelections() { return { repositoryMirrors: a, repositoryMirrorRefresh: b } }',
  )
  const hosted = sourceUnit(
    HOSTED,
    'export function profile() { return { selections: { repositoryMirrors: () => a, repositoryMirrorRefresh: async () => b } } }',
  )
  const clean = [profile('  readonly x: X'), standalone, hosted]

  test('伪造的干净语料没有违例', () => {
    expect(deploymentSelectionViolations(clean)).toEqual([])
  })

  test('合同里的类型查询、托管一族与 daemon 按本地工厂定型、daemon 读 repositoryRemote、profile 漏给都会被认出', () => {
    expect(
      deploymentSelectionViolations([
        profile('  readonly runtimeManagement: typeof composeLocalRuntimeManagementSelection'),
        standalone,
        hosted,
      ]),
    ).toEqual(['type query in the contract:composeLocalRuntimeManagementSelection'])
    expect(
      deploymentSelectionViolations([
        profile('  readonly repositoryRemote: RepositoryRemoteEffects | null'),
        standalone,
        hosted,
      ]),
    ).toEqual(['contract keeps repositoryRemote'])
    expect(
      deploymentSelectionViolations([
        ...clean,
        sourceUnit(
          SRC + 'modules/x/composition/crewstationThing.ts',
          'export function f(): typeof composeLocalThing { return g }',
        ),
        sourceUnit(
          SRC + 'bootstrap/daemonThing.ts',
          'type R = ReturnType<typeof createFileThing>\nconst r = input.repositoryRemote',
        ),
      ]),
    ).toEqual([
      'daemon reads repositoryRemote:packages/backend/src/bootstrap/daemonThing.ts',
      'typed by a local factory:packages/backend/src/bootstrap/daemonThing.ts:createFileThing',
      'typed by a local factory:packages/backend/src/modules/x/composition/crewstationThing.ts:composeLocalThing',
    ])
    expect(
      deploymentSelectionViolations([
        profile('  readonly x: X'),
        sourceUnit(
          STANDALONE,
          'export function standaloneSelections() { return { repositoryMirrors: a } }',
        ),
        sourceUnit(
          HOSTED,
          'export function profile() { return { selections: { repositoryMirrorRefresh: b } } }',
        ),
      ]),
    ).toEqual([
      `${HOSTED} does not state repositoryMirrors`,
      `${STANDALONE} does not state repositoryMirrorRefresh`,
    ])
  })

  test('不在托管一族与 daemon 的文件里按本地工厂定型不算（本地配对文件照旧可以）', () => {
    expect(
      deploymentSelectionViolations([
        ...clean,
        sourceUnit(
          SRC + 'bootstrap/runFamilyProviders.ts',
          'type B = ReturnType<typeof createLocalSystemAgentRuntimeBindings>',
        ),
      ]),
    ).toEqual([])
  })
})

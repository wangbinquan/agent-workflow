// RFC-532 — 数据库安装由部署选择给出（RFC-294 S12 第十三步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① `bootstrap/daemon*.ts` 不拿 `databaseInstallation` 与 `null` / `undefined` 比较，不导入本机 epoch 路径的函数、升级子进程与
//    `prepareDaemonDatabaseProviderForBoot`——这些只在两种安装里（语料下限 3,000）。
// ② 合同的 `databaseInstallation` 不可空，类型是 `DaemonDatabaseInstallation`。
// ③ 单机以 `composeLocalDaemonDatabaseInstallation`（交入 `runAutoUpgradeChild`）、托管以
//    `composeSelectedDaemonDatabaseInstallation(system.databaseInstallation)` 给出。
// ④ 行为：托管的 `admit` 不碰安装端口；单机的 `admit` 在全新的家目录上什么都不起，在 epoch-1 安装上按配置给出指引，或起升级
//    子进程、重读配置并核对结果。负对照只喂伪造的源码，不碰真实语料。
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import {
  composeLocalDaemonDatabaseInstallation,
  composeSelectedDaemonDatabaseInstallation,
} from '@/modules/system-operations/composition/daemonDatabaseInstallation'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const PROFILE = SRC + 'bootstrap/deploymentProfile.ts'
const STANDALONE = SRC + 'bootstrap/standalone.ts'
const HOSTED = SRC + 'bootstrap/crewstation.ts'
const CORPUS_TIMEOUT = 30_000
/** The local epoch path and its preparation: only the two installations take these. */
const LOCAL_PATH = new Set([
  'runAutoUpgradeChild',
  'readEpochBootFacts',
  'readEpochBootFactsForConfig',
  'classifyEpochInstallation',
  'autoUpgradeTrigger',
  'epochInstallationGuidance',
  'applyLocalEpoch2PendingRestore',
  'prepareDaemonDatabaseProviderForBoot',
])
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

const daemonFile = (path: string) =>
  /^packages\/backend\/src\/bootstrap\/daemon[A-Za-z]*\.ts$/.test(path)
const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
    ? unwrap(node.expression)
    : node
const namesInstallation = (node: ts.Expression) => {
  const inner = unwrap(node)
  return (
    (ts.isIdentifier(inner) && inner.text === 'databaseInstallation') ||
    (ts.isPropertyAccessExpression(inner) && inner.name.text === 'databaseInstallation')
  )
}
const absence = (node: ts.Expression): string | undefined => {
  const inner = unwrap(node)
  if (inner.kind === ts.SyntaxKind.NullKeyword) return 'null'
  if (ts.isIdentifier(inner) && inner.text === 'undefined') return 'undefined'
  return undefined
}

/** The initializer of `key` in the object literal held by the property `holder` (or returned by `builder`). */
function statedValue(
  unit: SourceUnit,
  key: string,
  where: { holder: string } | { builder: string },
): ts.Expression | undefined {
  let found: ts.Expression | undefined
  const scan = (literal: ts.ObjectLiteralExpression) => {
    for (const property of literal.properties)
      if (ts.isPropertyAssignment(property) && property.name.getText(unit.source) === key)
        found ??= property.initializer
  }
  walk(unit.source, (node) => {
    if (
      'holder' in where &&
      ts.isPropertyAssignment(node) &&
      node.name.getText(unit.source) === where.holder &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      scan(node.initializer)
    if ('builder' in where && ts.isFunctionDeclaration(node) && node.name?.text === where.builder)
      walk(node, (inner) => {
        if (
          ts.isReturnStatement(inner) &&
          inner.expression !== undefined &&
          ts.isObjectLiteralExpression(inner.expression)
        )
          scan(inner.expression)
      })
  })
  return found
}

const compact = (unit: SourceUnit, node: ts.Node) => node.getText(unit.source).replace(/\s+/g, '')

export function installationSelectionViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const profile = byPath.get(PROFILE)
  if (profile === undefined) errors.add('missing source: ' + PROFILE)
  else {
    const contract = profile.source.statements.find(
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === 'DeploymentSelections',
    )
    const member = contract?.members.find(
      (node): node is ts.PropertySignature =>
        ts.isPropertySignature(node) &&
        node.name.getText(profile.source) === 'databaseInstallation',
    )
    if (member === undefined) errors.add('contract missing databaseInstallation')
    else if (member.questionToken !== undefined || member.type === undefined)
      errors.add('contract makes databaseInstallation optional')
    else if (member.type.getText(profile.source) !== 'DaemonDatabaseInstallation')
      errors.add('contract types databaseInstallation as ' + member.type.getText(profile.source))
  }
  for (const unit of units) {
    if (!daemonFile(unit.path)) continue
    walk(unit.source, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        node.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(node.importClause.namedBindings)
      )
        for (const element of node.importClause.namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text
          if (LOCAL_PATH.has(imported)) errors.add(`daemon imports ${imported}:${unit.path}`)
        }
      if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
        const compared = namesInstallation(node.left)
          ? absence(node.right)
          : namesInstallation(node.right)
            ? absence(node.left)
            : undefined
        if (compared !== undefined)
          errors.add(`daemon compares databaseInstallation with ${compared}:${unit.path}`)
      }
    })
  }
  const standalone = byPath.get(STANDALONE)
  if (standalone === undefined) errors.add('missing source: ' + STANDALONE)
  else {
    const value = statedValue(standalone, 'databaseInstallation', {
      builder: 'standaloneSelections',
    })
    if (
      value === undefined ||
      !ts.isCallExpression(value) ||
      compact(standalone, value.expression) !== 'composeLocalDaemonDatabaseInstallation' ||
      !compact(standalone, value).includes('runAutoUpgrade:runAutoUpgradeChild')
    )
      errors.add(`${STANDALONE} does not state the local installation`)
  }
  const hosted = byPath.get(HOSTED)
  if (hosted === undefined) errors.add('missing source: ' + HOSTED)
  else {
    const value = statedValue(hosted, 'databaseInstallation', { holder: 'selections' })
    if (
      value === undefined ||
      !ts.isCallExpression(value) ||
      compact(hosted, value) !==
        'composeSelectedDaemonDatabaseInstallation(system.databaseInstallation)'
    )
      errors.add(`${HOSTED} does not state the selected installation`)
  }
  return [...errors].sort()
}

describe('RFC-532 ①～③ 安装由部署选择给出，daemon 不分支', () => {
  test(
    '真实语料：合同的安装槽位必填，daemon 不按 null 分支、不取本机 epoch 路径，两个 profile 各给一份',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(installationSelectionViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-532 ④ 两种安装的 admit', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  const home = () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc532-installation-'))
    roots.push(root)
    return root
  }
  /** An epoch-1 standalone installation: a legacy `db.sqlite` with tables and no generation pointer. */
  const epoch1Home = () => {
    const root = home()
    const db = new Database(join(root, 'db.sqlite'))
    db.run('CREATE TABLE legacy_rows (id TEXT PRIMARY KEY)')
    db.close()
    return root
  }
  const admission = (autoEpochMigration: boolean) => {
    const config = { database: DEFAULT_CONFIG.database, autoEpochMigration }
    const read = mock(async () => config)
    return { input: { config, configuration: { read }, contract: logicalSchemaContract }, read }
  }

  test('托管：admit 什么都不做，不碰安装端口', async () => {
    const port = new Proxy(
      {},
      {
        get(_target, name) {
          throw new Error(
            `rfc532: the hosted admit touched the installation port (${String(name)})`,
          )
        },
      },
    ) as Parameters<typeof composeSelectedDaemonDatabaseInstallation>[0]
    const installation = composeSelectedDaemonDatabaseInstallation(port)
    expect(Object.isFrozen(installation)).toBe(true)
    expect(await installation.admit(admission(true).input)).toBeUndefined()
  })

  test('单机：全新的家目录上不起升级子进程、不重读配置', async () => {
    const runAutoUpgrade = mock(async () => undefined)
    const installation = composeLocalDaemonDatabaseInstallation({ appHome: home(), runAutoUpgrade })
    const { input, read } = admission(true)
    expect(await installation.admit(input)).toBeUndefined()
    expect(runAutoUpgrade).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  test('单机：epoch-1 安装关了自动升级时给出指引，不起升级子进程', async () => {
    const runAutoUpgrade = mock(async () => undefined)
    const installation = composeLocalDaemonDatabaseInstallation({
      appHome: epoch1Home(),
      runAutoUpgrade,
    })
    await expect(installation.admit(admission(false).input)).rejects.toThrow(
      'This is an epoch-1 installation; autoEpochMigration is false.',
    )
    expect(runAutoUpgrade).not.toHaveBeenCalled()
  })

  test('单机：epoch-1 安装起升级子进程、重读配置，子进程没把安装升到 epoch-2 时拒绝', async () => {
    const runAutoUpgrade = mock(async () => undefined)
    const installation = composeLocalDaemonDatabaseInstallation({
      appHome: epoch1Home(),
      runAutoUpgrade,
    })
    const { input, read } = admission(true)
    await expect(installation.admit(input)).rejects.toThrow(
      'Automatic upgrade exited without a verified epoch-2 installation and completed session.',
    )
    expect(runAutoUpgrade).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('RFC-532 负对照', () => {
  const profile = (member: string) =>
    sourceUnit(PROFILE, `export interface DeploymentSelections {\n  readonly x: X\n${member}\n}`)
  const standalone = (value: string) =>
    sourceUnit(
      STANDALONE,
      `export function standaloneSelections() { return { crewStationEvents: null, databaseInstallation: ${value} } }`,
    )
  const hosted = (value: string) =>
    sourceUnit(
      HOSTED,
      `export function profile() { return { selections: { databaseInstallation: ${value} } } }`,
    )
  const clean = [
    profile('  readonly databaseInstallation: DaemonDatabaseInstallation'),
    standalone(
      'composeLocalDaemonDatabaseInstallation({ appHome, runAutoUpgrade: runAutoUpgradeChild })',
    ),
    hosted('composeSelectedDaemonDatabaseInstallation(system.databaseInstallation)'),
  ]

  test('伪造的干净语料没有违例', () => {
    expect(installationSelectionViolations(clean)).toEqual([])
  })

  test('可空或可选的槽位、daemon 按 null 分支或取本机 epoch 路径、profile 漏给都会被认出', () => {
    expect(
      installationSelectionViolations([
        profile('  readonly databaseInstallation: DaemonDatabaseInstallationPort | null'),
        ...clean.slice(1),
      ]),
    ).toEqual(['contract types databaseInstallation as DaemonDatabaseInstallationPort | null'])
    expect(
      installationSelectionViolations([
        profile('  readonly databaseInstallation?: DaemonDatabaseInstallation'),
        ...clean.slice(1),
      ]),
    ).toEqual(['contract makes databaseInstallation optional'])
    expect(
      installationSelectionViolations([
        ...clean,
        sourceUnit(
          SRC + 'bootstrap/daemonThing.ts',
          [
            "import { runAutoUpgradeChild } from './autoUpgradeChild'",
            "import { readEpochBootFactsForConfig as facts } from '@/modules/system-operations/composition/epochBootAdmission'",
            'if (profile.selections.databaseInstallation === null) await runAutoUpgradeChild()',
            'const local = undefined !== databaseInstallation',
          ].join('\n'),
        ),
      ]),
    ).toEqual([
      'daemon compares databaseInstallation with null:packages/backend/src/bootstrap/daemonThing.ts',
      'daemon compares databaseInstallation with undefined:packages/backend/src/bootstrap/daemonThing.ts',
      'daemon imports readEpochBootFactsForConfig:packages/backend/src/bootstrap/daemonThing.ts',
      'daemon imports runAutoUpgradeChild:packages/backend/src/bootstrap/daemonThing.ts',
    ])
    expect(
      installationSelectionViolations([
        clean[0]!,
        standalone('null'),
        hosted('system.databaseInstallation'),
      ]),
    ).toEqual([
      `${HOSTED} does not state the selected installation`,
      `${STANDALONE} does not state the local installation`,
    ])
    expect(
      installationSelectionViolations([
        clean[0]!,
        standalone(
          'composeLocalDaemonDatabaseInstallation({ appHome, runAutoUpgrade: async () => {} })',
        ),
        clean[2]!,
      ]),
    ).toEqual([`${STANDALONE} does not state the local installation`])
  })

  test('不在 daemon 文件里取本机 epoch 路径不算（两种安装与 CLI 的迁移命令照旧可以）', () => {
    expect(
      installationSelectionViolations([
        ...clean,
        sourceUnit(
          SRC + 'bootstrap/migrate.ts',
          "import { readEpochBootFactsForConfig } from '@/modules/system-operations/composition/epochBootAdmission'",
        ),
      ]),
    ).toEqual([])
  })
})

// RFC-519 — 托管实现迁出组合层（二）：拆开余下 4 个文件的装配与实现（RFC-294 S10 第二十六步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件、用例与 e2e 里只在各自的新位置声明；五个新文件恰好声明、交出清单列的名字；4 个组合文件导出的名字与 HEAD
//    相同，转出的与新位置的是同一个对象。
// ② 4 个组合文件没有循环、switch、`try`、`throw` 与错误的构造；RFC-515 门的例外清单为空。
// ③ 五个新文件不取组合层（带负对照）。
// ④ 行为：托管技能工件的引用校验与旧工件拒绝；没拿到围栏的备用实例跳过收敛；写入围栏在执行权失效时抛错、在手时交出租约。
//
// 覆盖范围（C12）：① 读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e；② ③ 读 4 个组合文件与新位置。迁走的
// effect 工厂、部署环境与数据库准备的其余行为由既有的 RFC-370 用例覆盖（它们经组合文件取同一批名字）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { createHostedIntentArtifactContent } from '@/modules/intent/infrastructure/crewstation/intentArtifactContent'
import { reconcileWhenFenceHeld } from '@/modules/resource-catalog/infrastructure/crewstation/mcpDiagnosticsEffects'
import { createHostedMutationFence } from '@/modules/system-operations/infrastructure/crewstation/deploymentDatabase'
import {
  HostedExecutionLeaseLostError,
  hostedLeaseOf,
} from '@/modules/system-operations/infrastructure/hostedExecutionControl'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

/** design §3: the five new files with the names each declares (in order) and offers. */
const NEW_FILES: Readonly<
  Record<string, { declared: readonly string[]; offered: readonly string[] }>
> = {
  'modules/intent/infrastructure/crewstation/intentArtifactContent': {
    declared: ['createHostedIntentArtifactContent'],
    offered: ['createHostedIntentArtifactContent'],
  },
  'modules/resource-catalog/infrastructure/crewstation/mcpDiagnosticsEffects': {
    declared: [
      'LocalMcpDiagnosticsEffectInput',
      'HostedInput',
      'reconcileWhenFenceHeld',
      'createCrewStationMcpDiagnosticsEffects',
    ],
    offered: ['HostedInput', 'reconcileWhenFenceHeld', 'createCrewStationMcpDiagnosticsEffects'],
  },
  'modules/runtime-management/infrastructure/crewstation/runtimeManagementEffects': {
    declared: [
      'HostedRuntimeCapabilitiesSchema',
      'HostedRuntimeProfileMapping',
      'createCrewStationRuntimeManagementEffects',
    ],
    offered: [
      'HostedRuntimeCapabilitiesSchema',
      'HostedRuntimeCapabilities',
      'HostedRuntimeProfileMapping',
      'createCrewStationRuntimeManagementEffects',
    ],
  },
  'modules/system-operations/infrastructure/crewstation/deploymentEnvironment': {
    declared: [
      'CREWSTATION_DATABASE_URL_ENV',
      'HOSTED_TASK_CONTRACT_VERSION',
      'CrewStationDeploymentEnvironment',
      'CrewStationEnvironmentError',
      'SUBJECT_PREFIX',
      'parseAdminSubjects',
      'requiredReader',
      'readCrewStationDatabaseEnvironment',
      'readCrewStationEnvironment',
    ],
    offered: [
      'CREWSTATION_DATABASE_URL_ENV',
      'HOSTED_TASK_CONTRACT_VERSION',
      'CrewStationDeploymentEnvironment',
      'CrewStationEnvironmentError',
      'readCrewStationDatabaseEnvironment',
      'readCrewStationEnvironment',
    ],
  },
  'modules/system-operations/infrastructure/crewstation/deploymentDatabase': {
    declared: [
      'HOSTED_DATABASE_POOL_MAX',
      'crewStationDatabaseConfig',
      'prepareCrewStationDatabase',
      'prepareCrewStationMigrationInstallation',
      'crewStationControlClient',
      'createHostedMutationFence',
    ],
    offered: [
      'crewStationDatabaseConfig',
      'prepareCrewStationDatabase',
      'prepareCrewStationMigrationInstallation',
      'crewStationControlClient',
      'createHostedMutationFence',
    ],
  },
}
/** design §3: every declared name with the one file that declares it. */
const LISTED: readonly (readonly [string, string])[] = Object.entries(NEW_FILES).flatMap(
  ([location, { declared }]) => declared.map((name) => [location, name] as const),
)
/** design D2: the four composition files export exactly what they exported at HEAD. */
const COMPOSITION_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  'modules/intent/composition/crewstationArtifacts': [
    'composeCrewStationIntentArtifacts',
    'composeCrewStationIntentPluginRetention',
  ],
  'modules/resource-catalog/composition/crewstationMcpDiagnostics': [
    'createCrewStationMcpDiagnostics',
    'createCrewStationMcpDiagnosticsEffects',
  ],
  'modules/runtime-management/composition/crewstationRuntimeManagement': [
    'HostedRuntimeCapabilities',
    'HostedRuntimeCapabilitiesSchema',
    'HostedRuntimeProfileMapping',
    'composeCrewStationRuntimeManagement',
    'createCrewStationRuntimeManagementEffects',
  ],
  'modules/system-operations/composition/crewstationDeployment': [
    'CREWSTATION_DATABASE_URL_ENV',
    'CrewStationDeploymentEnvironment',
    'CrewStationEnvironmentError',
    'CrewStationSystemSelections',
    'HOSTED_TASK_CONTRACT_VERSION',
    'composeCrewStationDatabaseWriteBarrier',
    'composeCrewStationMigrationInstallation',
    'composeCrewStationSystemSelections',
    'composeCrewStationWorkerFence',
    'crewStationControlClient',
    'crewStationDatabaseConfig',
    'prepareCrewStationDatabase',
    'readCrewStationDatabaseEnvironment',
    'readCrewStationEnvironment',
  ],
}
/** design D2: the moved values each composition file hands on, with the file they come from. */
const REEXPORTS: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  'modules/resource-catalog/composition/crewstationMcpDiagnostics': [
    'modules/resource-catalog/infrastructure/crewstation/mcpDiagnosticsEffects',
    ['createCrewStationMcpDiagnosticsEffects'],
  ],
  'modules/runtime-management/composition/crewstationRuntimeManagement': [
    'modules/runtime-management/infrastructure/crewstation/runtimeManagementEffects',
    ['HostedRuntimeCapabilitiesSchema', 'createCrewStationRuntimeManagementEffects'],
  ],
  'modules/system-operations/composition/crewstationDeployment#env': [
    'modules/system-operations/infrastructure/crewstation/deploymentEnvironment',
    [
      'CREWSTATION_DATABASE_URL_ENV',
      'CrewStationEnvironmentError',
      'HOSTED_TASK_CONTRACT_VERSION',
      'readCrewStationDatabaseEnvironment',
      'readCrewStationEnvironment',
    ],
  ],
  'modules/system-operations/composition/crewstationDeployment#db': [
    'modules/system-operations/infrastructure/crewstation/deploymentDatabase',
    ['crewStationControlClient', 'crewStationDatabaseConfig', 'prepareCrewStationDatabase'],
  ],
}
const MODULE_LOADERS: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {
  'modules/resource-catalog/composition/crewstationMcpDiagnostics': () =>
    import('@/modules/resource-catalog/composition/crewstationMcpDiagnostics'),
  'modules/resource-catalog/infrastructure/crewstation/mcpDiagnosticsEffects': () =>
    import('@/modules/resource-catalog/infrastructure/crewstation/mcpDiagnosticsEffects'),
  'modules/runtime-management/composition/crewstationRuntimeManagement': () =>
    import('@/modules/runtime-management/composition/crewstationRuntimeManagement'),
  'modules/runtime-management/infrastructure/crewstation/runtimeManagementEffects': () =>
    import('@/modules/runtime-management/infrastructure/crewstation/runtimeManagementEffects'),
  'modules/system-operations/composition/crewstationDeployment': () =>
    import('@/modules/system-operations/composition/crewstationDeployment'),
  'modules/system-operations/infrastructure/crewstation/deploymentDatabase': () =>
    import('@/modules/system-operations/infrastructure/crewstation/deploymentDatabase'),
  'modules/system-operations/infrastructure/crewstation/deploymentEnvironment': () =>
    import('@/modules/system-operations/infrastructure/crewstation/deploymentEnvironment'),
}

/** The tests below read every production file, test and e2e file; the first pays the cold read. */
const CORPUS_TIMEOUT = 30_000

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}
const PRODUCTION = walk(SRC)
const TEST_FILES = walk(join(BACKEND, 'tests'))
const E2E_FILES = walk(join(REPO, 'e2e'))
const TEXTS = new Map<string, string>()
const text = (path: string) => {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = readFileSync(path, 'utf8')))
  return content
}
const srcPath = (abs: string) => slash(relative(SRC, abs)).replace(/\.tsx?$/, '')
const corpusPath = (abs: string) => slash(relative(REPO, abs))
const sourceOf = (location: string) => join(SRC, `${location}.ts`)
/** `@/…` and relative specifiers as a path under `src` without extension; packages yield null. */
const resolveSpecifier = (file: string, specifier: string) =>
  specifier.startsWith('@/')
    ? srcPath(join(SRC, specifier.slice(2)))
    : specifier.startsWith('.')
      ? srcPath(resolve(dirname(file), specifier))
      : null

function declaredNames(path: string, source: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, source).statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    )
      names.push(statement.name.text)
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
  }
  return names
}

function offeredNames(path: string, source: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, source).statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (exported) names.push(...declaredNames(path, statement.getFullText()))
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements) names.push(element.name.text)
  }
  return names
}

const CONTROL_FLOW = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.IfStatement, 'if'],
  [ts.SyntaxKind.ForStatement, 'for'],
  [ts.SyntaxKind.ForInStatement, 'for-in'],
  [ts.SyntaxKind.ForOfStatement, 'for-of'],
  [ts.SyntaxKind.WhileStatement, 'while'],
  [ts.SyntaxKind.DoStatement, 'do'],
  [ts.SyntaxKind.SwitchStatement, 'switch'],
  [ts.SyntaxKind.TryStatement, 'try'],
  [ts.SyntaxKind.ThrowStatement, 'throw'],
])
/** Production files that call `name`, each with its call count. */

/** Control-flow statements anywhere in the file and every `new …Error(…)` (design §4 ②). */
function checkShapes(path: string, source: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    const kind = CONTROL_FLOW.get(node.kind)
    if (kind !== undefined) out.push(kind)
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text.endsWith('Error')
    )
      out.push(node.expression.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return out
}

/** What design §3 forbids in the three module roots (branches stay: they are assembly-time selections). */
const forbidden = (path: string) => checkShapes(path, text(path)).filter((shape) => shape !== 'if')

/** Imports of the file that resolve into any composition file, with their kind (read from the syntax tree). */
function compositionImports(file: string, source: string): string[] {
  const out: string[] = []
  for (const statement of parse(file, source).statements) {
    if (
      !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    const resolved = resolveSpecifier(file, statement.moduleSpecifier.text)
    if (resolved === null || !/^modules\/[^/]+\/composition(\/|$)/.test(resolved)) continue
    const typeOnly = ts.isImportDeclaration(statement)
      ? statement.importClause?.isTypeOnly === true
      : statement.isTypeOnly
    out.push(`${srcPath(file)} -> ${resolved} (${typeOnly ? 'type' : 'value'})`)
  }
  return out
}

describe('RFC-519 ① 清单里的名字只在新位置声明', () => {
  test(
    '全部生产文件、用例与 e2e 里每个清单名字只在它的新位置声明（语料下限 3,000 / 2,500）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      expect(TEST_FILES.length).toBeGreaterThanOrEqual(2500)
      expect(E2E_FILES.length).toBeGreaterThan(0)
      const declaring = (name: string) =>
        [...PRODUCTION, ...TEST_FILES, ...E2E_FILES]
          .filter(
            (path) =>
              new RegExp(`\\b${name}\\b`).test(text(path)) &&
              declaredNames(path, text(path)).includes(name),
          )
          .map(corpusPath)
          .sort()
      expect(LISTED.length).toBeGreaterThanOrEqual(20)
      for (const [location, name] of LISTED)
        expect([name, declaring(name)]).toEqual([name, [`packages/backend/src/${location}.ts`]])
    },
    CORPUS_TIMEOUT,
  )

  test('五个新文件恰好声明、交出清单列的名字；4 个组合文件导出的名字与 HEAD 相同', () => {
    for (const [location, { declared, offered }] of Object.entries(NEW_FILES)) {
      const path = sourceOf(location)
      expect([location, declaredNames(path, text(path))]).toEqual([location, [...declared]])
      expect([location, offeredNames(path, text(path))]).toEqual([location, [...offered]])
    }
    for (const [location, names] of Object.entries(COMPOSITION_EXPORTS)) {
      const path = sourceOf(location)
      expect([location, offeredNames(path, text(path)).sort()]).toEqual([location, [...names]])
    }
  })

  test(
    '组合文件转出的迁走名字与新位置导出的是同一个对象',
    async () => {
      for (const [key, [source, names]] of Object.entries(REEXPORTS)) {
        const composition = await MODULE_LOADERS[key.split('#')[0]!]!()
        const origin = await MODULE_LOADERS[source]!()
        for (const name of names) {
          expect([key, name, typeof origin[name]]).not.toEqual([key, name, 'undefined'])
          expect([key, name, composition[name] === origin[name]]).toEqual([key, name, true])
        }
      }
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-519 ② 组合层只装配', () => {
  test('4 个组合文件没有循环、switch、try、throw 与错误的构造；RFC-515 门的例外清单为空', () => {
    expect(
      Object.keys(COMPOSITION_EXPORTS).flatMap((location) =>
        forbidden(sourceOf(location)).map((shape) => `${location}: ${shape}`),
      ),
    ).toEqual([])
    const gate = text(
      join(BACKEND, 'tests', 'architecture', 'rfc515-composition-assembly-only.test.ts'),
    )
    expect([...gate.matchAll(/\[MODULES \+ '([^']+)'\]/g)].map((match) => match[1])).toEqual([])
  })
})

describe('RFC-519 ③ 新位置不取组合层', () => {
  test('五个新文件没有任何组合层 import', () => {
    expect(
      Object.keys(NEW_FILES).flatMap((location) =>
        compositionImports(sourceOf(location), text(sourceOf(location))),
      ),
    ).toEqual([])
  })

  test('负对照：取组合文件与取 required-ports 都会被认出', () => {
    const file = sourceOf('modules/system-operations/infrastructure/crewstation/probe')
    const source = [
      `import { composeApplicationConfigurationBinding } from '../../composition/applicationConfiguration'`,
      `import type { Port } from '../../composition/required-ports'`,
      `import { selectApplicationConfiguration } from '../../application/applicationConfiguration'`,
    ].join('\n')
    expect(compositionImports(file, source)).toEqual([
      'modules/system-operations/infrastructure/crewstation/probe -> modules/system-operations/composition/applicationConfiguration (value)',
      'modules/system-operations/infrastructure/crewstation/probe -> modules/system-operations/composition/required-ports (type)',
    ])
  })
})

describe('RFC-519 ④ 行为', () => {
  test('托管技能工件：暂存引用相符才交给工件属主，不符抛原错误；旧工件要先迁移；插件读写照传', async () => {
    const calls: unknown[] = []
    const resources = {
      pluginArtifacts: 'plugins',
      skillArtifacts: 'skills',
      stageSkillReference: (value: { skillId: string; operationId: string; version: number }) =>
        `stage:${value.skillId}:${value.operationId}:${value.version}`,
      pluginExists: async (reference: string) => (calls.push(['exists', reference]), true),
      discardPlugin: async (reference: string) => void calls.push(['discardPlugin', reference]),
      publishSkill: async (value: unknown) => void calls.push(['publishSkill', value]),
      discardSkill: async (value: unknown) => void calls.push(['discardSkill', value]),
    }
    const content = createHostedIntentArtifactContent(resources as never)
    const staged = {
      kind: 'skill-stage',
      skillId: 's1',
      operationId: 'op1',
      version: 1,
      stagingDirectory: 'stage:s1:op1:1',
    }
    await content.publishSkill({ artifact: staged, version: 1 } as never)
    await content.discardSkill({ artifact: staged, version: 1 } as never)
    expect(await content.pluginExists('plugin-1' as never)).toBe(true)
    await content.discardPlugin('plugin-2' as never)
    expect(calls).toEqual([
      ['publishSkill', { skillId: 's1', operationId: 'op1', version: 1 }],
      ['discardSkill', { skillId: 's1', operationId: 'op1', version: 1 }],
      ['exists', 'plugin-1'],
      ['discardPlugin', 'plugin-2'],
    ])
    await expect(
      content.publishSkill({
        artifact: { ...staged, stagingDirectory: 'elsewhere' },
        version: 1,
      } as never),
    ).rejects.toThrow('hosted-intent-skill-reference-mismatch')
    await expect(content.discardSkill({ artifact: staged, version: 2 } as never)).rejects.toThrow(
      'hosted-intent-skill-reference-mismatch',
    )
    expect(() => (content.discardLegacy as (...args: never[]) => unknown)()).toThrow(
      'hosted-intent-legacy-artifact-requires-migration',
    )
    expect(calls).toHaveLength(4)
  })

  test('没拿到围栏的备用实例跳过持久意图收敛，拿到后照常收敛', async () => {
    let held = false
    const calls: string[] = []
    const fence = {
      current() {
        if (!held) throw new Error('standby')
        return 'lease'
      },
    }
    const reconcile = reconcileWhenFenceHeld(
      fence as never,
      async () => void calls.push('reconcile'),
    )
    await reconcile()
    expect(calls).toEqual([])
    held = true
    await reconcile()
    expect(calls).toEqual(['reconcile'])
  })

  test('写入围栏：执行权不在手时抛原错误，在手时交出租约；持有校验照传', () => {
    let state: { kind: string; fence?: { epoch: number; token: string } } = { kind: 'standby' }
    const asserted: unknown[] = []
    const fence = createHostedMutationFence(
      { current: () => state } as never,
      { assertHeld: (tx: unknown, lease: unknown) => void asserted.push([tx, lease]) } as never,
    )
    expect(() => fence.current()).toThrow(HostedExecutionLeaseLostError)
    expect(() => fence.current()).toThrow('(standby)')
    state = { kind: 'active', fence: { epoch: 3, token: 'holder/lease' } }
    expect(fence.current()).toEqual(hostedLeaseOf(state.fence as never))
    fence.assertHeld('tx' as never, 'lease' as never)
    expect(asserted).toEqual([['tx', 'lease']])
  })
})

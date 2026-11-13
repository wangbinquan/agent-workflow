// RFC-492 — 运行时驱动一族整族迁入 runtime-management infrastructure（RFC-294 §4.7 运行时驱动一族第五步）。
//
// 锁六件事：
// ① 一族不在 `services/`：`services/runtime/`、`services/execution/` 没有文件，`services/driverLease.ts` 不存在；一族在
//    runtime-management 的 `infrastructure/drivers/`；RFC-108 的驱动租约兼容夹具在 `tests/helpers/`。
// ② 全部生产文件里 import `infrastructure/drivers/**` 的只有 runtime-management 自己的文件（bootstrap 经 composition）。相对路径、
//    `@/` 别名、re-export、动态 import 与 type-only 都认，带负对照。
// ③ 生产文件不再有指向旧位置的 import；`infrastructure/drivers/**` 不取本模块的 `public/participants`（取声明处）。
// ④ 只供一族的 14 个出口不再从 `public/participants` 交出，各在声明处只声明一次。
// ⑤ bootstrap：`composition/runtimeDrivers.ts` 只做转出；启动自检取它；资源策略束 3 个字段，与 runtime-management 和 shared 的函数
//    引用相等，`daemonModules/taskExecution.ts` 取 bootstrap 的策略束。
// ⑥ 构建与配置：单二进制的插件目录指向新位置且目录里有库存插件，插件入口取 `@/embed.generated`；eslint 围栏与三份 workflow 的路径
//    过滤登记新位置、不再出现旧位置；发布登记（`scripts/release-upgrade/registry.ts`）的布局表在这棵树上找到新位置的 OpenCode
//    探测与驱动，已登记 tag 的位置照旧认得。
//
// 覆盖范围（C12）：② ③ 读全部生产文件（语料下限 3,000）；① ④ ⑤ ⑥ 读指定文件与全部生产文件里的同名声明；⑤ 另有单元对拍；⑥ 的发布
// 登记一条另扫全仓的探测文件名（跳过 .git、node_modules、dist）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { pickCallTarget } from '@agent-workflow/shared'
import { taskExecutionResourceDependencies } from '@/bootstrap/taskExecutionResourceDependencies'
import * as runtimeDrivers from '@/modules/runtime-management/composition/runtimeDrivers'
import {
  getRuntimeDriver,
  RUNTIME_KINDS,
} from '@/modules/runtime-management/infrastructure/drivers'
import {
  findManagedInjectionNameConflict,
  formatManagedInjectionNameConflict,
} from '@/modules/runtime-management/infrastructure/drivers/injectionIdentity'
import { assertRuntimeDeclarations } from '@/modules/runtime-management/infrastructure/drivers/selfCheck'
import {
  OPENCODE_PROBE_SUFFIXES,
  opencodeDriverPath,
  opencodeProbePath,
} from '../../../scripts/release-upgrade/lib/model'

const SRC = resolve(import.meta.dir, '..', 'src')
const REPO_ROOT = resolve(SRC, '..', '..', '..')
const RM = 'modules/runtime-management'
const DRIVERS = `${RM}/infrastructure/drivers`
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

function walk(dir: string, pattern = /\.[cm]?tsx?$/): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path, pattern) : pattern.test(name) ? [path] : []
  })
}
const filesOf = (dir: string, pattern?: RegExp) =>
  walk(join(SRC, dir), pattern).map((path) => slash(relative(SRC, path)))

const TEXTS = new Map<string, string>()
function sourceText(path: string): string {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = read(path)))
  return content
}

/** Static and dynamic module specifiers of a file (type-only included), resolved to `src`-relative paths. */
function specifiers(path: string, text: string): string[] {
  const out: string[] = []
  const add = (specifier: string) =>
    out.push(
      specifier.startsWith('.')
        ? slash(relative(SRC, resolve(dirname(join(SRC, path)), specifier)))
        : specifier.startsWith('@/')
          ? specifier.slice(2)
          : specifier,
    )
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, text))
  return out
}

const bare = (target: string) => target.replace(/\.[cm]?tsx?$/, '').replace(/\/index$/, '')
const intoDrivers = (target: string) =>
  bare(target) === DRIVERS || bare(target).startsWith(DRIVERS + '/')
/** The retired spellings: the family's old services/ paths and the driver-lease fixture's. */
const RETIRED_FILES = new Set([
  'services/execution/agentInjection',
  'services/execution/workspaceBoundary',
  'services/execution/taskExecutionResourceDependencies',
  'services/driverLease',
])
const intoRetired = (target: string) =>
  bare(target) === 'services/runtime' ||
  bare(target).startsWith('services/runtime/') ||
  RETIRED_FILES.has(bare(target))

const driverEdges = (path: string, targets: readonly string[]) =>
  targets.filter(intoDrivers).map((target) => `${path} -> ${target}`)
const driverImports = (path: string, text: string) => driverEdges(path, specifiers(path, text))

const SPECIFIERS = new Map<string, string[]>()
/** `specifiers` of a real `src` file, parsed once per run: ② and ③ walk the same corpus. */
function fileSpecifiers(path: string): string[] {
  let found = SPECIFIERS.get(path)
  if (found === undefined) SPECIFIERS.set(path, (found = specifiers(path, sourceText(path))))
  return found
}
/**
 * The tests that read every production file (≥3,000; ② ③ ④). Whichever runs first under `--randomize` pays the cold
 * read and parse: 4.1 s against the 5 s default under heavy local load.
 */
const CORPUS_TIMEOUT = 30_000

const PRODUCTION = filesOf('.')
const FAMILY = filesOf(DRIVERS)

describe('RFC-492 ① 一族不在 services/', () => {
  test('services/runtime、services/execution 没有文件，驱动租约夹具不在 src', () => {
    expect(walk(join(SRC, 'services/runtime'), /.*/)).toEqual([])
    expect(walk(join(SRC, 'services/execution'), /.*/)).toEqual([])
    expect(existsSync(join(SRC, 'services/driverLease.ts'))).toBe(false)
    expect(existsSync(join(import.meta.dir, 'helpers', 'driverLease.ts'))).toBe(true)
  })

  test('一族在 runtime-management 的 infrastructure/drivers（不少于 38 个文件，含库存插件）', () => {
    const all = filesOf(DRIVERS, /.*/)
    expect(all.length).toBeGreaterThanOrEqual(38)
    for (const path of [
      `${DRIVERS}/index.ts`,
      `${DRIVERS}/types.ts`,
      `${DRIVERS}/selfCheck.ts`,
      `${DRIVERS}/injectionIdentity.ts`,
      `${DRIVERS}/agentInjection.ts`,
      `${DRIVERS}/workspaceBoundary.ts`,
      `${DRIVERS}/opencode/driver.ts`,
      `${DRIVERS}/claudeCode/driver.ts`,
      `${DRIVERS}/opencode/plugin/aw-inventory-dump.mjs`,
    ])
      expect([path, all.includes(path)]).toEqual([path, true])
  })
})

describe('RFC-492 ② 只有 runtime-management 自己 import 一族', () => {
  test(
    '全部生产文件里取 infrastructure/drivers 的都在 runtime-management（语料下限 3,000）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      expect(
        PRODUCTION.filter((path) => !path.startsWith(RM + '/')).flatMap((path) =>
          driverEdges(path, fileSpecifiers(path)),
        ),
      ).toEqual([])
      // Positive control: the module itself does read the family (the registry and both material implementations).
      const inside = PRODUCTION.filter(
        (path) => path.startsWith(RM + '/') && !path.startsWith(DRIVERS + '/'),
      ).filter((path) => driverEdges(path, fileSpecifiers(path)).length > 0)
      expect(inside).toContain(`${RM}/composition/runtimeDrivers.ts`)
      expect(inside).toContain(`${RM}/infrastructure/local/opencodeAgentMaterial.ts`)
      expect(inside.length).toBeGreaterThanOrEqual(16)
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：相对路径、别名、re-export、动态 import 与 type-only 都会被认出，注册表之外的本模块路径不算', () => {
    const path = 'modules/task-execution/infrastructure/local/probe.ts'
    const text = [
      "import { getRuntimeDriver } from '../../../runtime-management/infrastructure/drivers'",
      "import type { SpawnPlan } from '@/modules/runtime-management/infrastructure/drivers/types'",
      "export { buildInlineConfig } from '@/modules/runtime-management/infrastructure/drivers/opencode/inlineConfig'",
      "const lazy = () => import('@/modules/runtime-management/infrastructure/drivers/selfCheck')",
      "import { isKnownRuntimeKind } from '@/modules/runtime-management/public/queries'",
      "import { composeLocalRuntimeManagement } from '@/modules/runtime-management/composition/localRuntimeManagement'",
    ].join('\n')
    expect(driverImports(path, text)).toEqual([
      `${path} -> ${DRIVERS}`,
      `${path} -> ${DRIVERS}/types`,
      `${path} -> ${DRIVERS}/opencode/inlineConfig`,
      `${path} -> ${DRIVERS}/selfCheck`,
    ])
  })
})

describe('RFC-492 ③ 旧位置不再被 import；一族取本模块的声明处', () => {
  test(
    '生产文件没有指向旧位置的 import',
    () => {
      expect(
        PRODUCTION.flatMap((path) =>
          fileSpecifiers(path)
            .filter(intoRetired)
            .map((target) => `${path} -> ${target}`),
        ),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：旧的别名与相对写法都会被认出', () => {
    const path = 'modules/runtime-management/infrastructure/local/probe.ts'
    const found = specifiers(
      path,
      [
        "import { getRuntimeDriver } from '@/services/runtime'",
        "import type { RuntimePlugin } from '../../../../services/execution/agentInjection'",
        "import { withDriverLease } from '@/services/driverLease'",
        "import { x } from '@/services/runtime/opencode/spawn'",
      ].join('\n'),
    ).filter(intoRetired)
    expect(found).toEqual([
      'services/runtime',
      'services/execution/agentInjection',
      'services/driverLease',
      'services/runtime/opencode/spawn',
    ])
  })

  test('一族不取本模块的 public/participants', () => {
    expect(FAMILY.length).toBeGreaterThanOrEqual(35)
    expect(
      FAMILY.flatMap((path) =>
        fileSpecifiers(path)
          .filter((target) => bare(target) === `${RM}/public/participants`)
          .map((target) => `${path} -> ${target}`),
      ),
    ).toEqual([])
  })
})

const RETRACTED = {
  'application/ports/agentProtocol.ts': ['DeclarationFace'],
  'application/ports/agentMaterialEvidence.ts': [
    'AgentSessionCaptureRequest',
    'SystemAgentSessionSweepOutcome',
    'SystemAgentSessionSweepRequest',
  ],
  'application/ports/runtimeSessionCapturePersistence.ts': ['RuntimeSessionCaptureEvent'],
  'application/ports/agentObservations.ts': [
    'DeclaredRuntimeCapabilities',
    'NormalizedEventData',
    'NormalizedEventKind',
    'TerminalResultObservation',
  ],
  'domain/usageMeter.ts': [
    'RuntimeUsageMeterInput',
    'RuntimeUsageModel',
    'UsageAccumulator',
    'modelKey',
    'tokenCount',
  ],
} as const

/** Names a file offers through `export … from` / `export { … }` declarations. */
function exportedNames(path: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, sourceText(path)).statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements) names.push(element.name.text)
  }
  return names
}

/** Production files declaring `name` (function, class, interface, type alias or const). */
function declarationsOf(name: string): string[] {
  return PRODUCTION.filter((path) => {
    const text = sourceText(path)
    return (
      text.includes(name) &&
      parse(path, text).statements.some(
        (statement) =>
          ((ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)) &&
            statement.name?.text === name) ||
          (ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
              (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
            )),
      )
    )
  })
}

describe('RFC-492 ④ 只供一族的 14 个出口撤出 public', () => {
  test(
    'public/participants 不再交出它们，各在声明处只声明一次',
    () => {
      const offered = new Set(exportedNames(`${RM}/public/participants.ts`))
      const names = Object.values(RETRACTED).flat()
      expect(names.length).toBe(14)
      for (const [file, declared] of Object.entries(RETRACTED))
        for (const name of declared) {
          expect([name, offered.has(name)]).toEqual([name, false])
          expect([name, declarationsOf(name)]).toEqual([name, [`${RM}/${file}`]])
        }
    },
    CORPUS_TIMEOUT,
  )

  test('仍有模块外读者的同组成员照旧交出（正向对照）', () => {
    const offered = new Set(exportedNames(`${RM}/public/participants.ts`))
    for (const name of [
      'RuntimeDriverCapabilities',
      'RuntimeSessionCapturePersistence',
      'NormalizedEvent',
      'SystemEventObservation',
      'RuntimeUsageMeter',
      'RuntimeUsageSnapshot',
      'objectOf',
    ])
      expect([name, offered.has(name)]).toEqual([name, true])
  })
})

describe('RFC-492 ⑤ bootstrap 经 composition 取一族', () => {
  test('composition/runtimeDrivers 只做转出', () => {
    const path = `${RM}/composition/runtimeDrivers.ts`
    const statements = parse(path, sourceText(path)).statements
    expect(statements.length).toBeGreaterThan(0)
    expect(
      statements.every(
        (statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined,
      ),
    ).toBe(true)
    expect(exportedNames(path).sort()).toEqual([
      'RUNTIME_KINDS',
      'assertRuntimeDeclarations',
      'findManagedInjectionNameConflict',
      'formatManagedInjectionNameConflict',
      'getRuntimeDriver',
    ])
  })

  test('转出的就是一族的同一组函数，策略束三个字段与之引用相等', () => {
    expect(runtimeDrivers.getRuntimeDriver).toBe(getRuntimeDriver)
    expect(runtimeDrivers.RUNTIME_KINDS).toBe(RUNTIME_KINDS)
    expect(runtimeDrivers.assertRuntimeDeclarations).toBe(assertRuntimeDeclarations)
    expect(runtimeDrivers.findManagedInjectionNameConflict).toBe(findManagedInjectionNameConflict)
    expect(runtimeDrivers.formatManagedInjectionNameConflict).toBe(
      formatManagedInjectionNameConflict,
    )
    expect(Object.isFrozen(taskExecutionResourceDependencies)).toBe(true)
    expect(Object.keys(taskExecutionResourceDependencies).sort()).toEqual([
      'findManagedInjectionNameConflict',
      'formatManagedInjectionNameConflict',
      'pickCallTarget',
    ])
    expect(taskExecutionResourceDependencies.findManagedInjectionNameConflict).toBe(
      findManagedInjectionNameConflict,
    )
    expect(taskExecutionResourceDependencies.formatManagedInjectionNameConflict).toBe(
      formatManagedInjectionNameConflict,
    )
    expect(taskExecutionResourceDependencies.pickCallTarget).toBe(pickCallTarget)
  })

  test('启动自检与策略束的取处', () => {
    const application = specifiers(
      'bootstrap/daemonApplication.ts',
      sourceText('bootstrap/daemonApplication.ts'),
    )
    expect(application).toContain(`${RM}/composition/runtimeDrivers`)
    expect(sourceText('bootstrap/daemonApplication.ts')).toContain(
      'assertRuntimeDeclarations(RUNTIME_KINDS.map(getRuntimeDriver))',
    )
    expect(
      specifiers(
        'bootstrap/taskExecutionResourceDependencies.ts',
        sourceText('bootstrap/taskExecutionResourceDependencies.ts'),
      ).filter((target) => target.startsWith('modules/')),
    ).toEqual([`${RM}/composition/runtimeDrivers`])
    expect(
      specifiers(
        'bootstrap/daemonModules/taskExecution.ts',
        sourceText('bootstrap/daemonModules/taskExecution.ts'),
      ),
    ).toContain('bootstrap/taskExecutionResourceDependencies')
  })

  test('启动自检对注册的全部驱动给出同样结论', () => {
    const { notModeled } = runtimeDrivers.assertRuntimeDeclarations(
      runtimeDrivers.RUNTIME_KINDS.map(runtimeDrivers.getRuntimeDriver),
    )
    expect(notModeled).toEqual(
      assertRuntimeDeclarations(RUNTIME_KINDS.map(getRuntimeDriver)).notModeled,
    )
  })
})

describe('RFC-492 ⑥ 构建与配置跟随新位置', () => {
  const OLD = /services\/runtime\b|services\/execution\/(?:agentInjection|workspaceBoundary)\b/
  /** Code only: history comments may still name the old location. */
  const code = (text: string) => text.replace(/^\s*(?:\/\/|#).*$/gm, '')

  test('单二进制从新位置嵌入库存插件，插件入口取 @/embed.generated', () => {
    const build = readFileSync(join(REPO_ROOT, 'scripts', 'build-binary.ts'), 'utf8')
    const source = parse('scripts/build-binary.ts', build)
    let parts: string[] | undefined
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'pluginsDir' &&
        node.initializer !== undefined &&
        ts.isCallExpression(node.initializer)
      )
        parts = node.initializer.arguments
          .slice(1)
          .map((argument) => (ts.isStringLiteral(argument) ? argument.text : '?'))
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(parts).toEqual([
      'modules',
      'runtime-management',
      'infrastructure',
      'drivers',
      'opencode',
      'plugin',
    ])
    expect(existsSync(join(SRC, ...parts!, 'aw-inventory-dump.mjs'))).toBe(true)
    expect(code(build)).not.toMatch(OLD)
    expect(
      specifiers(
        `${DRIVERS}/opencode/plugin/index.ts`,
        sourceText(`${DRIVERS}/opencode/plugin/index.ts`),
      ),
    ).toContain('embed.generated')
  })

  test('eslint 围栏指向新位置、不再出现旧位置', () => {
    const config = readFileSync(join(REPO_ROOT, 'eslint.config.js'), 'utf8')
    for (const pattern of [
      `'@/${DRIVERS}/opencode/*'`,
      `'@/${DRIVERS}/claudeCode/*'`,
      "'../drivers/opencode/*'",
      "'../infrastructure/drivers/claudeCode/*'",
    ])
      expect([pattern, config.includes(pattern)]).toEqual([pattern, true])
    expect(code(config)).not.toMatch(OLD)
  })

  test('三份 workflow 的路径过滤登记新位置、不再出现旧位置', () => {
    const listed = (name: string) => {
      const text = readFileSync(join(REPO_ROOT, '.github', 'workflows', name), 'utf8')
      expect([name, OLD.test(code(text))]).toEqual([name, false])
      return [...text.matchAll(/^\s*- '([^']+)'\s*$/gm)].map((match) => match[1]!)
    }
    const at = (path: string) => `packages/backend/src/${DRIVERS}/${path}`
    const count = (entries: string[], path: string) =>
      entries.filter((entry) => entry === path).length
    const opencode = listed('integration-opencode.yml')
    for (const path of [at('opencode/**'), at('agentInjection.ts'), at('workspaceBoundary.ts')])
      expect([path, count(opencode, path)]).toEqual([path, 2])
    const windows = listed('windows-platform.yml')
    for (const path of [
      at('claudeCode/driver.ts'),
      at('opencode/driver.ts'),
      at('opencode/subagentLiveCapture.ts'),
      at('index.ts'),
      at('opencode/usage.ts'),
      at('opencode/nativeUsage.ts'),
      at('claudeCode/usage.ts'),
    ])
      expect([path, count(windows, path)]).toEqual([path, 2])
    const visual = listed('visual-regression-nightly.yml')
    expect(count(visual, at('opencode/util.ts'))).toBe(2)
  })

  test('发布登记在新位置找到 OpenCode 探测与驱动，已登记的位置照旧认得', () => {
    // 下一个 tag 从这棵树切出。发布登记在 tag 的全部文件里按布局表找 OpenCode 探测，找不到就拒绝登记；能命中布局表后缀的只有
    // 这几个文件名，所以全仓只收它们（跳过 .git、node_modules、dist）。
    const names = new Set(
      OPENCODE_PROBE_SUFFIXES.map((suffix) => suffix.slice(suffix.lastIndexOf('/') + 1)),
    )
    const candidates: string[] = []
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!['.git', 'node_modules', 'dist'].includes(entry.name)) visit(join(dir, entry.name))
        } else if (names.has(entry.name))
          candidates.push(slash(relative(REPO_ROOT, join(dir, entry.name))))
      }
    }
    visit(REPO_ROOT)
    expect(opencodeProbePath(candidates)).toBe(`packages/backend/src/${DRIVERS}/opencode/util.ts`)
    expect(opencodeDriverPath((path) => existsSync(join(REPO_ROOT, path)))).toBe(
      `packages/backend/src/${DRIVERS}/opencode/driver.ts`,
    )
    // 已登记 tag 的探测位置逐个照旧认得；布局表之外的位置仍拒绝登记；旧布局的 tag 仍读旧位置的驱动。
    const registry = JSON.parse(
      readFileSync(join(import.meta.dir, 'fixtures', 'release-upgrade', 'releases.json'), 'utf8'),
    ) as { releases: { runtime: { source: string } }[] }
    const recorded = [...new Set(registry.releases.map((release) => release.runtime.source))]
    expect(recorded).toContain('packages/backend/src/services/runtime/opencode/util.ts')
    for (const source of recorded)
      expect([source, opencodeProbePath([source])]).toEqual([source, source])
    expect(opencodeProbePath([`packages/backend/src/${DRIVERS}/opencode/probe.ts`])).toBeUndefined()
    const old = 'packages/backend/src/services/runtime/opencode/driver.ts'
    expect(opencodeDriverPath((path) => path === old)).toBe(old)
    expect(opencodeDriverPath(() => false)).toBeUndefined()
  })
})

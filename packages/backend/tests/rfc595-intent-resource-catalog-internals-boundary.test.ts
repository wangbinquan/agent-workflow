// RFC-595 — intent 不再取 resource-catalog 的内部（RFC-294 S9 余项：跨 context 内部文件对 6 → 4）。
//
// 为什么存在：intent 的装配文件自己造 resource-catalog 的本机工件属主、技能工件补偿与技能内容定位查询，apply 引擎驱动的资源会话类型取自
// resource-catalog 的 infrastructure。现在三个装配函数收入参、由 bootstrap 从 resource-catalog 的装配根取来交入（本机一族照托管一族的形状），
// 资源会话用 intent 自己的端口形状。锁五件事：
// ① intent 全部源码里解析到 resource-catalog 的说明符都落在它的 `public/`（判据带负对照）。
// ② resource-catalog 的 `composition/intentApply` 在生产代码里（resource-catalog 之外）只被 bootstrap 取（判据带负对照）。
// ③ intent 的装配文件不再调那四个构造（判据带负对照）。
// ④ 编译期：resource-catalog 的会话满足 intent 的端口；`composeLocalIntentResourceArtifacts` 的结果满足 `LocalIntentResourceArtifacts`。
// ⑤ 本机一族的 resource-catalog 一半与原来是同样的三个构造，standalone 的会话工厂把两半拼在一起。
//
// 覆盖范围（C12）：① 覆盖 intent 的全部源码；② 覆盖 backend `src` 的全部生产文件；③ ⑤ 只读三个文件；④ 由 typecheck 执行。行为由既有用例覆盖
// （`rfc432` 的会话工厂、`rfc384` 的守护进程 intent 装配、`rfc370-intent-artifact-content` 的工件生命周期、intent apply 一族）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import type { IntentApplyResourceSession } from '@/modules/intent/application/ports/intentApplyResourceSession'
import type { LocalIntentResourceArtifacts } from '@/modules/intent/composition/apply'
import type { composeLocalIntentResourceArtifacts } from '@/modules/resource-catalog/composition/intentApply'
import type { IntentApplyResourceSession as ResourceCatalogIntentApplyResourceSession } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourceParticipants'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

const INTENT = 'modules/intent/'
const RC = 'modules/resource-catalog/'
const RC_INTENT_APPLY = 'modules/resource-catalog/composition/intentApply'
const INTENT_APPLY = 'modules/intent/composition/apply'
const STANDALONE = 'bootstrap/standalone'
const CONSTRUCTIONS = [
  'composePostgresqlSkillArtifactCompensation',
  'createFileIntentPluginArtifactOwner',
  'createFileIntentSkillArtifactOwner',
  'createSkillContentLocationQuery',
]
const read = (file: string) => readFileSync(join(SRC, `${file}.ts`), 'utf8')

// ④ Compile-time: the provider's session and standalone half fit the consumer's shapes (the bootstrap binding relies on it).
const sessionFits = (
  session: ResourceCatalogIntentApplyResourceSession,
): IntentApplyResourceSession => session
const familyFits = (
  family: ReturnType<typeof composeLocalIntentResourceArtifacts>,
): LocalIntentResourceArtifacts => family

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
    const path = join(dir, name)
    return statSync(path).isDirectory()
      ? walk(path)
      : /\.(?:[cm]?tsx?|mjs)$/.test(name)
        ? [path]
        : []
  })
}

/**
 * Every module specifier a file names — imports, re-exports, `import('…')` (types and calls), `require('…')` and
 * `mock.module('…')` — resolved to a path below `src` without its extension (null when it leaves `src` or is a package).
 */
function resolvedSpecifiers(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const add = (specifier: string) => {
    const bare = specifier.replace(/\.(?:[cm]?tsx?|[cm]?js)$/, '')
    const target = bare.startsWith('@/')
      ? join(SRC, bare.slice(2))
      : bare.startsWith('.')
        ? resolve(dirname(path), bare)
        : null
    if (target === null) return
    const below = slash(relative(SRC, target))
    if (!below.startsWith('..')) out.push(below)
  }
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text)
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      add(node.argument.literal.text)
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source)
      const first = node.arguments[0]
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          callee === 'require' ||
          callee === 'mock.module' ||
          callee === 'import.meta.resolve') &&
        first !== undefined &&
        ts.isStringLiteralLike(first)
      )
        add(first.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** Resource Catalog targets that leave its exact public entries. */
const internalTargets = (targets: readonly string[]) =>
  targets.filter((target) => target.startsWith(RC) && !target.startsWith(`${RC}public/`))

/** Each call to `name` in a file, its arguments squashed (no whitespace, no trailing commas). */
function callArguments(path: string, text: string, name: string): string[][] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const calls: string[][] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      calls.push(
        node.arguments.map((argument) =>
          argument
            .getText(source)
            .replace(/\s+/g, '')
            .replace(/,(?=[)\]}])/g, ''),
        ),
      )
    ts.forEachChild(node, visit)
  }
  visit(source)
  return calls
}

/** Names of the plain identifiers a file calls. */
function calledNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
      names.push(node.expression.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

describe('RFC-595 —— intent 不再取 resource-catalog 的内部', () => {
  test('intent 全部源码只经 resource-catalog 的 public 取它', () => {
    const files = walk(join(SRC, INTENT))
    expect(files.length).toBeGreaterThanOrEqual(90)
    expect(
      files.flatMap((path) =>
        internalTargets(resolvedSpecifiers(path, readFileSync(path, 'utf8'))).map(
          (target) => `${slash(relative(SRC, path))} -> ${target}`,
        ),
      ),
    ).toEqual([])
  })

  test('负对照：装配根、infrastructure、domain 与 application 都会被认出，public 不算', () => {
    const probe = join(SRC, INTENT, 'composition', 'probe.ts')
    expect(
      internalTargets(
        resolvedSpecifiers(
          probe,
          `import { composeLegacyIntentSkillArtifactCompat } from '@/${RC_INTENT_APPLY}'\n` +
            "import type { IntentApplyResourceSession } from '../../resource-catalog/infrastructure/aggregateAdapters/intentApplyResourceParticipants'\n" +
            `export type Kind = import('@/${RC}domain/resourceKinds').CatalogSelectorKind\n` +
            `import type { IntentApplyArtifact } from '@/${RC}application/intent/artifactOwners'\n` +
            `import type { ResourceRequestContext } from '@/${RC}public/participants'\n`,
        ),
      ),
    ).toEqual([
      RC_INTENT_APPLY,
      `${RC}infrastructure/aggregateAdapters/intentApplyResourceParticipants`,
      `${RC}domain/resourceKinds`,
      `${RC}application/intent/artifactOwners`,
    ])
  })

  test('resource-catalog 的 intent 装配根在生产代码里只被 bootstrap 取；负对照：intent 的装配文件取它会被认出', () => {
    const files = walk(SRC).filter((path) => !slash(relative(SRC, path)).startsWith(RC))
    expect(files.length).toBeGreaterThanOrEqual(2000)
    const importers = files
      .filter((path) =>
        resolvedSpecifiers(path, readFileSync(path, 'utf8')).includes(RC_INTENT_APPLY),
      )
      .map((path) => slash(relative(SRC, path)))
    expect(importers.length).toBeGreaterThanOrEqual(4)
    expect(importers.filter((path) => !path.startsWith('bootstrap/'))).toEqual([])
    expect(
      resolvedSpecifiers(
        join(SRC, `${INTENT_APPLY}.ts`),
        `import { createSkillContentLocationQuery } from '@/${RC_INTENT_APPLY}'\n`,
      ),
    ).toEqual([RC_INTENT_APPLY])
  })

  test('intent 的装配文件不再调那四个构造；负对照：任一调用都会被认出', () => {
    expect(
      calledNames(`${INTENT_APPLY}.ts`, read(INTENT_APPLY)).filter((name) =>
        CONSTRUCTIONS.includes(name),
      ),
    ).toEqual([])
    expect(
      calledNames(
        'probe.ts',
        'const content = createFileIntentArtifactContent({ skillArtifacts: composePostgresqlSkillArtifactCompensation() })\n' +
          'const locations = createSkillContentLocationQuery(db)\n',
      ).filter((name) => CONSTRUCTIONS.includes(name)),
    ).toEqual(['composePostgresqlSkillArtifactCompensation', 'createSkillContentLocationQuery'])
  })

  test('编译期断言存在（typecheck 执行）', () => {
    expect([typeof sessionFits, typeof familyFits]).toEqual(['function', 'function'])
  })

  test('本机一族的 resource-catalog 一半是原来的三个构造；standalone 的会话工厂把两半拼在一起', () => {
    const rc = read(RC_INTENT_APPLY)
    expect(
      callArguments(`${RC_INTENT_APPLY}.ts`, rc, 'createFileIntentPluginArtifactOwner'),
    ).toEqual([["{pluginsDir:join(input.appHome,'plugins')}"]])
    expect(
      callArguments(`${RC_INTENT_APPLY}.ts`, rc, 'createFileIntentSkillArtifactOwner'),
    ).toEqual([['{appHome:input.appHome,db:input.db}']])
    expect(
      callArguments(`${RC_INTENT_APPLY}.ts`, rc, 'composePostgresqlSkillArtifactCompensation'),
    ).toEqual([[]])
    const standalone = read(STANDALONE)
    expect(callArguments(`${STANDALONE}.ts`, standalone, 'composeLocalIntentArtifacts')).toEqual([
      [
        '{appHome:session.appHome,resources:composeLocalIntentResourceArtifacts({db:session.db,appHome:session.appHome})}',
      ],
    ])
    const intentApply = read(INTENT_APPLY)
    expect(
      callArguments(`${INTENT_APPLY}.ts`, intentApply, 'composeLocalIntentArtifactContent'),
    ).toEqual([
      [
        "{appHome:input.appHome,pluginsDir:join(input.appHome,'plugins'),skillArtifacts:input.resources.skillArtifactCompensation}",
      ],
    ])
  })
})

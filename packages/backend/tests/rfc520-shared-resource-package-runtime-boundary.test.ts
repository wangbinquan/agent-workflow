// RFC-520 — 资源包装配共用一个模块工厂（RFC-294 S12 第一步）。
//
// 锁两件事（design §3 的清单即退出门）：
// ① 全部生产文件里四个资源包工厂（provider、catalog、执行适配器、原子 apply）只在 resource-catalog 内被调用；CLI 包命令与 daemon 的资源包绑定
//    各调一次 `composeResourcePackageRuntime`；`foreign-resource-package-authority` 只出自 application 的授权登记与变更会话自己的行为人核对
//    （带负对照）。
//    模块工厂里原子 apply 只构造一次，交给执行适配器的就是交出的那一个（实参钉住）。
// ② 行为：未登记的授权以原错误拒绝，登记过的授权解析出登记的行为人，两个登记互不相通；模块工厂把登记接进 provider 的变更会话工厂。
//
// 覆盖范围（C12）：① 读全部生产文件（语料下限 3,000）。资源包 apply 的端到端行为由既有的 RFC-349 / RFC-359 用例覆盖。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { createResourceAuthorityRegistry } from '@/modules/resource-catalog/application/participants/resourceAuthorityRegistry'
import { composeResourcePackageRuntime } from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const RUNTIME = 'modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
const REGISTRY = 'modules/resource-catalog/application/participants/resourceAuthorityRegistry'
/** design §3: the four resource-package factories and the one production file allowed to call each. */
const FACTORIES: Readonly<Record<string, readonly string[]>> = {
  composePostgresqlResourcePackageProvider: [`${RUNTIME} x1`],
  composePostgresqlResourcePackageCatalog: [`${RUNTIME} x1`],
  createPostgresqlResourcePackageExecutionAdapter: [`${RUNTIME} x1`],
  createResourcePackageAtomicApplyOperations: [`${RUNTIME} x1`],
}
const SHARED_CALLERS = ['bootstrap/commandBootstraps x1', 'bootstrap/daemonHttpComposition x1']
/** The mutation session's own refusal when the resolved actor is not the requester (pre-existing, not moved). */
const MUTATION_SESSION =
  'modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants'

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
const TEXTS = new Map<string, string>()
const text = (path: string) => {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = readFileSync(path, 'utf8')))
  return content
}
const srcPath = (abs: string) => slash(relative(SRC, abs)).replace(/\.tsx?$/, '')
/** The argument texts (whitespace and trailing commas removed) of every call of `name` in the file. */
function callArguments(path: string, source: string, name: string): string[][] {
  const file = parse(path, source)
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
            .getText(file)
            .replace(/\s+/g, '')
            .replace(/,(?=[)\]}])/g, ''),
        ),
      )
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}

/** Production files that call `name`, each with its call count. */
function productionCallers(name: string): string[] {
  return PRODUCTION.filter((path) => text(path).includes(name))
    .map((path) => [srcPath(path), callArguments(path, text(path), name).length] as const)
    .filter(([, count]) => count > 0)
    .map(([path, count]) => `${path} x${count}`)
    .sort()
}

describe('RFC-520 ① 资源包装配只在模块工厂里', () => {
  test(
    '四个资源包工厂只被模块工厂调用；两处 bootstrap 各调一次模块工厂（语料下限 3,000）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      for (const [name, callers] of Object.entries(FACTORIES))
        expect([name, productionCallers(name)]).toEqual([name, [...callers]])
      expect(productionCallers('composeResourcePackageRuntime')).toEqual(SHARED_CALLERS)
      expect(
        PRODUCTION.filter((path) => text(path).includes('foreign-resource-package-authority'))
          .map(srcPath)
          .sort(),
      ).toEqual([REGISTRY, MUTATION_SESSION])
    },
    CORPUS_TIMEOUT,
  )

  test('模块工厂里原子 apply 只构造一次，交给执行适配器并交出的是同一个（实参钉住）', () => {
    const path = join(SRC, `${RUNTIME}.ts`)
    const source = text(path)
    expect(callArguments(path, source, 'createResourceAuthorityRegistry')).toEqual([[]])
    expect(callArguments(path, source, 'composePostgresqlResourcePackageProvider')).toEqual([
      ['{...input,authorityResolver:authorities.resolver}'],
    ])
    expect(callArguments(path, source, 'createResourcePackageAtomicApplyOperations')).toEqual([
      ['{db:input.db,box:input.box}'],
    ])
    expect(callArguments(path, source, 'createPostgresqlResourcePackageExecutionAdapter')).toEqual([
      ['{box:input.box,provider,atomicApply}'],
    ])
    expect(callArguments(path, source, 'composePostgresqlResourcePackageCatalog')).toEqual([
      [
        '{provider,execution:createPostgresqlResourcePackageExecutionAdapter({box:input.box,provider,atomicApply})}',
      ],
    ])
    expect(source).toContain(
      'return Object.freeze({ provider, atomicApply, catalog, registerAuthority: authorities.register })',
    )
  })

  test('负对照：bootstrap 里手写的工厂调用会被认出', () => {
    const probe = join(SRC, 'bootstrap', 'probe.ts')
    const source = [
      `export function compose(db: never) {`,
      `  const provider = composePostgresqlResourcePackageProvider({ db } as never)`,
      `  return composePostgresqlResourcePackageCatalog({ provider } as never)`,
      `}`,
    ].join('\n')
    expect(callArguments(probe, source, 'composePostgresqlResourcePackageProvider')).toHaveLength(1)
    expect(callArguments(probe, source, 'composePostgresqlResourcePackageCatalog')).toEqual([
      ['{provider}asnever'],
    ])
  })
})

describe('RFC-520 ② 授权登记', () => {
  test('未登记的授权以原错误拒绝；登记过的解析出登记的行为人；两个登记互不相通', () => {
    const first = createResourceAuthorityRegistry()
    const second = createResourceAuthorityRegistry()
    const authority = { requestId: 'request-1' } as never
    const actor = { id: 'user-1' } as never
    expect(() => first.resolver.resolve(authority)).toThrow('foreign-resource-package-authority')
    first.register(authority, actor)
    expect(first.resolver.resolve(authority)).toBe(actor)
    expect(() => second.resolver.resolve(authority)).toThrow('foreign-resource-package-authority')
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.resolver)).toBe(true)
  })

  test('模块工厂把登记接进 provider 的变更会话工厂：登记前以原错误拒绝，登记后解析出登记的行为人，两次装配互不相通', () => {
    // The factories only keep their inputs while assembling; the session factory resolves the actor before touching any of them.
    const unused = {} as never
    const input = {
      db: unused,
      appHome: join(BACKEND, 'rfc520-never-created'),
      box: unused,
      mcpLifecycle: unused,
      capabilityTemplates: unused,
      // RFC-525: the package content and both artifact owners are the caller's selections.
      skillPackageContent: unused,
      skillArtifacts: unused,
      pluginArtifacts: unused,
    }
    const first = composeResourcePackageRuntime(input)
    const second = composeResourcePackageRuntime(input)
    const authority = { requestId: 'request-1' } as never
    const actor = { id: 'user-1' } as never
    const request = { authority, actor, humanMemberMappings: [], secretInputs: [] } as never
    expect(() => first.provider.mutationSessionFactory.create(request)).toThrow(
      'foreign-resource-package-authority',
    )
    first.registerAuthority(authority, actor)
    expect(first.provider.mutationSessionFactory.create(request).request.actor).toBe(actor)
    expect(() => second.provider.mutationSessionFactory.create(request)).toThrow(
      'foreign-resource-package-authority',
    )
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.keys(first).sort()).toEqual([
      'atomicApply',
      'catalog',
      'provider',
      'registerAuthority',
    ])
  })
})

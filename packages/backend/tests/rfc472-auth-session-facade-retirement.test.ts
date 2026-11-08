// RFC-472 — 退役 identity-access 的兼容转出 `src/auth/session.ts`：intent 的属主重新准入改走自有端口（RFC-294 W9-D 第十九步）。
//
// 锁五件事：
// ① `src/auth/session.ts` 不在：backend 的 src / 用例 / 脚本零 import（TypeScript `preProcessFile` 取全部模块引用，带负对照）；
//    四个包、e2e 与仓根脚本里也没有指着它的字符串字面量（RFC-470 实撞：别的包会按路径读后端源码）。
// ② identity-access 的 `composeDurableWorkOwnerAdmission` 按结构满足 intent 的 `IntentOwnerAdmissionPort`（编译期锁，逐项相同）。
// ③ 依赖方向：intent 对 identity-access 只有 `public/` 的类型导入、没有值导入（AST 判定，带正负对照）；dispatcher 与会话路由不再认识
//    identity-access 的准入 runtime。
// ④ 装配根：应用根由 identity-access composition 组装属主重新准入、注入 intent 束（RFC-380：束内只有 provider core 取 identity-access），
//    dispatch 与会话路由收同一个；守护进程准入直取 composition。
// ⑤ 行为（两引擎）：在册用户 → 登记过的 actor（权威登记表认得它，手拼的投影不认）；停用与不存在的账号 → null；REST 唯一的 Bearer
//    读点（identity-access `public/types` 转出、定义在 domain）的语法。
import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { buildActor } from '@/auth/actor'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import {
  admitDurableWorkOwner,
  composeDurableWorkOwnerAdmission,
} from '@/modules/identity-access/composition/authentication'
import { parseLocalBearerHeader as domainParse } from '@/modules/identity-access/domain/localBearerCredential'
import { parseLocalBearerHeader } from '@/modules/identity-access/public/types'
import type { IntentDispatchDeps } from '@/modules/intent/application/dispatcher'
import type { IntentOwnerAdmissionPort } from '@/modules/intent/application/ports/intentOwnerAdmission'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'
import { createUser, disableUser } from './helpers/userFixture'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RETIRED = 'auth/session'
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Every module specifier a file references: static (incl. empty `import {}`), side-effect, re-export, type, dynamic, require. */
const specifiersIn = (text: string) =>
  ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName)

/** Resolve an import specifier to a `src/`-relative path stem (alias and relative forms), or null. */
function targetOf(from: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2)
  if (!specifier.startsWith('.')) return null
  const rel = slash(relative(SRC, resolve(from, '..', specifier)))
  return rel.startsWith('..') ? null : rel.replace(/\.[cm]?tsx?$/, '')
}

const importsOf = (files: readonly string[]) =>
  files.flatMap((path) =>
    specifiersIn(readFileSync(path, 'utf8'))
      .filter((specifier) => targetOf(path, specifier) === RETIRED)
      .map((specifier) => `${slash(relative(REPO_ROOT, path))} -> ${specifier}`),
  )

/** String literals (not comments) that name the retired file by path — the shape `readFileSync(<path>)` locks use. */
function retiredPathLiterals(path: string, text: string): string[] {
  if (!text.includes('auth/session')) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      // `/api/auth/sessions` routes share the prefix; the retired file is `auth/session` + `.ts` or a bare specifier end.
      /(?:^|[/'"])auth\/session(?:\.ts)?$/.test(node.text)
    ) {
      hits.push(`${slash(relative(REPO_ROOT, path))}: ${node.text}`)
    }
    node.forEachChild(visit)
  }
  visit(source)
  return hits
}

/** Imports from identity-access in one file: specifier and whether every imported binding is type-only. */
function identityAccessImports(path: string, text: string) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const found: { specifier: string; typeOnly: boolean }[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.includes('modules/identity-access/')
    ) {
      let typeOnly: boolean
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        const named = clause?.namedBindings
        typeOnly =
          clause !== undefined &&
          (clause.isTypeOnly ||
            (clause.name === undefined &&
              named !== undefined &&
              ts.isNamedImports(named) &&
              named.elements.length > 0 &&
              named.elements.every((element) => element.isTypeOnly)))
      } else {
        const clause = node.exportClause
        typeOnly =
          node.isTypeOnly ||
          (clause !== undefined &&
            ts.isNamedExports(clause) &&
            clause.elements.length > 0 &&
            clause.elements.every((element) => element.isTypeOnly))
      }
      found.push({ specifier: node.moduleSpecifier.text, typeOnly })
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text.includes('modules/identity-access/')
    )
      found.push({ specifier: node.arguments[0].text, typeOnly: false })
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

// ② compile-time locks: identity-access's owner admission is exactly intent's port…
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Composed = ReturnType<typeof composeDurableWorkOwnerAdmission>
const sameAdmitOwner: Equal<Composed['admitOwner'], IntentOwnerAdmissionPort['admitOwner']> = true
const sameKeys: Equal<keyof Composed, keyof IntentOwnerAdmissionPort> = true
const dispatchTakesPort: Equal<IntentDispatchDeps['ownerAdmission'], IntentOwnerAdmissionPort> =
  true
// …and the assembly root can hand one to the other.
const handOver = (admission: Composed): IntentOwnerAdmissionPort => admission

describe('RFC-472 —— 退役的文件不在、零引用', () => {
  test('src/auth/session.ts 不在', () => {
    expect(existsSync(join(SRC, 'auth', 'session.ts'))).toBe(false)
  })

  test('backend 的 src、用例与脚本零 import 它', () => {
    expect(importsOf(walk(SRC))).toEqual([])
    expect(importsOf(walk(TESTS))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')))).toEqual([])
  }, 60_000)

  test('四个包、e2e 与仓根脚本里没有指着它的路径字面量（注释与 /api/auth/sessions 不算）', () => {
    const roots = [
      ...['backend', 'shared', 'frontend', 'system-mocks'].flatMap((pkg) =>
        ['src', 'tests', 'scripts'].map((dir) => join(REPO_ROOT, 'packages', pkg, dir)),
      ),
      join(REPO_ROOT, 'e2e'),
      join(REPO_ROOT, 'scripts'),
    ]
    const hits = roots
      .flatMap(walk)
      .filter((path) => path !== import.meta.path)
      .flatMap((path) => retiredPathLiterals(path, readFileSync(path, 'utf8')))
    expect(hits).toEqual([])
  }, 120_000)

  test('负对照：判据认得出别名、相对路径、空 import {} 与路径字面量，不误伤注释、同前缀与会话路由', () => {
    const probe = join(SRC, 'auth', 'probe.ts')
    expect(targetOf(probe, './session')).toBe('auth/session')
    expect(targetOf(join(SRC, 'modules', 'intent', 'probe.ts'), '../../auth/session')).toBe(
      'auth/session',
    )
    const fixture = [
      "import {} from '@/auth/session'",
      "export type { X } from '../auth/session'",
      "const lazy = import('@/auth/session')",
      '// @/auth/session (a comment)',
      "import { y } from '@/auth/sessionStore'",
    ].join('\n')
    const targets = specifiersIn(fixture).map((specifier) =>
      targetOf(join(SRC, 'routes', 'probe.ts'), specifier),
    )
    expect(targets.filter((target) => target === RETIRED)).toHaveLength(3)
    expect(
      // An absolute probe path: `relative(REPO_ROOT, …)` of a bare name would resolve against the process cwd.
      retiredPathLiterals(
        join(REPO_ROOT, 'probe.ts'),
        [
          "read('packages/backend/src/auth/session.ts')",
          "src('auth/session.ts')",
          "fetch('/api/auth/sessions')",
          "read('src/auth/sessionStore.ts')",
          '// packages/backend/src/auth/session.ts',
        ].join('\n'),
      ),
    ).toEqual(['probe.ts: packages/backend/src/auth/session.ts', 'probe.ts: auth/session.ts'])
  })
})

describe('RFC-472 —— 结构同形与依赖方向', () => {
  test('编译期锁成立', () => {
    expect([sameAdmitOwner, sameKeys, dispatchTakesPort]).toEqual([true, true, true])
    expect(typeof handOver).toBe('function')
  })

  test('intent 对 identity-access 只有 public 的类型导入，没有值导入', () => {
    const files = walk(join(SRC, 'modules', 'intent'))
    const imports = files.flatMap((path) =>
      identityAccessImports(path, readFileSync(path, 'utf8')).map((found) => ({
        file: slash(relative(SRC, path)),
        ...found,
      })),
    )
    // Positive control: the scanner sees intent's existing public type imports.
    expect(imports.length).toBeGreaterThanOrEqual(6)
    expect(imports.filter((found) => !found.typeOnly)).toEqual([])
    expect(imports.filter((found) => !found.specifier.includes('identity-access/public/'))).toEqual(
      [],
    )
    const dispatcher = read('modules/intent/application/dispatcher.ts')
    const routes = read('modules/intent/inbound/intentSessionRoutes.ts')
    for (const text of [dispatcher, routes]) {
      expect(text).not.toContain('identityAccess')
      expect(text).not.toContain('DirectAuthorityAdmissionRuntime')
    }
    expect(dispatcher).not.toContain('admitDurableWorkOwner')
    expect(dispatcher).toContain('await deps.ownerAdmission.admitOwner(session.ownerUserId)')
  })

  test('负对照：值导入、混合导入与动态导入都会被认出，纯类型导入不会', () => {
    const verdicts = identityAccessImports(
      'probe.ts',
      [
        "import type { A } from '@/modules/identity-access/public/participants'",
        "import { type B } from '@/modules/identity-access/public/types'",
        "import { parseLocalBearerHeader } from '@/modules/identity-access/public/types'",
        "import { type C, D } from '@/modules/identity-access/public/participants'",
        "export { E } from '@/modules/identity-access/composition/authentication'",
        "const lazy = import('@/modules/identity-access/composition')",
        "import { F } from '@/modules/other/public/types'",
      ].join('\n'),
    )
    expect(verdicts.map((found) => found.typeOnly)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ])
  })
})

describe('RFC-472 —— 装配根', () => {
  test('应用根组装一份属主重新准入交给 intent 束，dispatch 与会话路由都收它；守护进程准入直取 composition', () => {
    const application = read('bootstrap/daemonApplication.ts')
    expect(application).toContain(
      "import { composeDurableWorkOwnerAdmission } from '@/modules/identity-access/composition/authentication'",
    )
    expect(
      application.match(/ownerAdmission: composeDurableWorkOwnerAdmission\(identityAccess\),/g) ??
        [],
    ).toHaveLength(1)
    // RFC-380: inside bootstrap/daemonModules only the provider core imports identity-access.
    const intent = read('bootstrap/daemonModules/intent.ts')
    expect(specifiersIn(intent).filter((s) => s.includes('modules/identity-access'))).toEqual([])
    expect(intent).toContain("readonly ownerAdmission: IntentDispatchDeps['ownerAdmission']")
    expect(intent.match(/^ {4}ownerAdmission,$/gm) ?? []).toHaveLength(2)
    expect(intent).not.toContain('identityAccess,')
    const providerCore = read('bootstrap/daemonModules/providerCore.ts')
    expect(providerCore).toMatch(
      /import \{\s*actorOfDirectAuthority,\s*admitDaemonIdentity,\s*type CredentialAdapterSelection,\s*\} from '@\/modules\/identity-access\/composition\/authentication'/,
    )
  })
})

describe('RFC-472 —— REST 的 Bearer 读点', () => {
  test('public 转出的就是 domain 里那一个函数', () => {
    expect(parseLocalBearerHeader).toBe(domainParse)
  })

  test('语法：Bearer（大小写不敏感）+ 一段非空白令牌，其余一律 null', () => {
    expect(parseLocalBearerHeader('Bearer abc.def')).toBe('abc.def')
    expect(parseLocalBearerHeader('bearer abc')).toBe('abc')
    expect(parseLocalBearerHeader('BEARER  abc  ')).toBe('abc')
    for (const header of [
      null,
      undefined,
      '',
      'Bearer',
      'Bearer ',
      'Bearer a b',
      'Basic abc',
      'abc',
    ])
      expect([header, parseLocalBearerHeader(header)]).toEqual([header, null])
  })
})

describeEachProvider('RFC-472 —— 属主重新准入的行为', (harness) => {
  let db: PersistenceDb
  beforeEach(() => {
    db = harness.db
  })

  test('在册用户 → 登记过的 actor；停用与不存在的账号 → null', async () => {
    const runtime = createIdentityAccessRuntime({ db })
    const admission = composeDurableWorkOwnerAdmission(runtime)
    expect(Object.isFrozen(admission)).toBe(true)
    expect(Object.keys(admission)).toEqual(['admitOwner'])
    const owner = await createUser(db, {
      username: 'rfc472-owner',
      displayName: 'RFC-472 Owner',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const actor = await admission.admitOwner(owner.id)
    expect(actor?.user.id).toBe(owner.id)
    // Same computation as the dispatcher's former two lines: the registered projection itself.
    expect(actor).toEqual((await admitDurableWorkOwner(runtime, owner.id))!.actor)
    // The authority registry resolves it back; a hand-built projection of the same account it refuses.
    expect(() => runtime.directAuthority.authorityForLegacyProjection(actor!)).not.toThrow()
    const handBuilt = buildActor({ user: { ...actor!.user }, source: 'session' })
    expect(() => runtime.directAuthority.authorityForLegacyProjection(handBuilt)).toThrow(
      'foreign-legacy-actor-projection',
    )

    expect(await admission.admitOwner('rfc472-no-such-user')).toBeNull()
    await disableUser(db, owner.id)
    expect(await admission.admitOwner(owner.id)).toBeNull()
    runtime.shutdown()
  })
})

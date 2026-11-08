// RFC-471 — 开发交付的代码托管桥归 integration：`services/developmentDeliveryDeps.ts` 退役（RFC-294 W9-D 第十八步）。
//
// 锁五件事：
// ① `services/developmentDeliveryDeps.ts` 与 DA 的 `domain/repositoryProviderMatch.ts` 不在：backend 的 src / 用例 / 脚本零 import
//    （TypeScript `preProcessFile` 取全部模块引用，带负对照）；四个包、e2e 与仓根脚本里也没有指着它们的字符串字面量
//    （RFC-470 实撞：shared 包的用例按路径读后端源码，只扫 backend 的改指脚本漏了它）。
// ② integration 的组装结果按结构满足 DA 的端口（编译期锁），DA 的原始快照类型与 integration `MrFactsSnapshot` 逐项相同。
// ③ 依赖方向：DA 的新文件不取 integration，integration 的代码托管组装不取 DA；MR effects 全仓只一份实现；DA 的 public 不再
//    转出只有本桥在用的 pipeline 证据组装与 `PipelineStagingFactories`（集中验证的架构报告查出它们会成为无人消费的 public 符号）。
// ④ 装配根：交付 provider 不再收连接与请求；integration 由 provider 的仓库远端组装绑定，注入 DA 的 mission 操作、交付依赖与事实
//    采集，代码托管事件观察者用同一个绑定。
// ⑤ 行为：绑定、MR effects 的绑定缺失、原始事实透传、认领键、事实采集的错误文案与 `snapshotRef`、交付依赖的事实映射。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import type * as DevelopmentPorts from '@/modules/development-automation/application/ports/developmentDelivery'
import type {
  MrEffectsPort,
  RepoRemotePort,
} from '@/modules/development-automation/application/ports/reconcilerPorts'
import type { PipelineStagingFactories } from '@/modules/development-automation/application/ports/evidenceStaging'
import {
  composeDevelopmentDeliveryDeps,
  composeDevelopmentMrFactsCollector,
} from '@/modules/development-automation/composition/developmentDelivery'
import { canonicalDigest } from '@/modules/development-automation/domain/canonicalJson'
import type { DevelopmentDeliveryProvider } from '@/modules/development-automation/infrastructure/developmentDeliveryProvider'
import type { MrEnsureConnectionDeps } from '@/modules/integration/application/mrEnsure'
import type * as IntegrationFacts from '@/modules/integration/application/mrFacts'
import {
  composeDevelopmentCodeHostBinding,
  composeDevelopmentCodeHostDelivery,
  composeDevelopmentMrEffects,
  composeDevelopmentMrFactsSource,
  composeRepositoryCodeHostClaimKeys,
} from '@/modules/integration/composition/codeHostEffects'
import { sha256Hex } from '@/util/hash'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RETIRED = [
  'services/developmentDeliveryDeps',
  'modules/development-automation/domain/repositoryProviderMatch',
]
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
      .filter((specifier) => RETIRED.includes(targetOf(path, specifier) ?? ''))
      .map((specifier) => `${slash(relative(REPO_ROOT, path))} -> ${specifier}`),
  )

/** String literals (not comments) that name a retired file by path — the shape `readFileSync(<path>)` locks use. */
function retiredPathLiterals(path: string, text: string): string[] {
  if (!RETIRED.some((stem) => text.includes(stem))) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      RETIRED.some((stem) => node.text.includes(stem))
    ) {
      hits.push(`${slash(relative(REPO_ROOT, path))}: ${node.text}`)
    }
    node.forEachChild(visit)
  }
  visit(source)
  return hits
}

// ② compile-time locks: DA's raw-facts shape is integration's snapshot, member by member…
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const sameSnapshot: Equal<
  DevelopmentPorts.DevelopmentMrFactsSnapshot,
  IntegrationFacts.MrFactsSnapshot
> = true
const sameThread: Equal<DevelopmentPorts.DevelopmentMrThreadFact, IntegrationFacts.MrThreadFact> =
  true
const sameMessage: Equal<
  DevelopmentPorts.DevelopmentMrThreadMessageFact,
  IntegrationFacts.MrThreadMessageFact
> = true
// …and the assembly root hands integration's compositions to development automation's ports.
const handOver = (
  delivery: ReturnType<typeof composeDevelopmentCodeHostDelivery>,
): {
  readonly mrEffects: MrEffectsPort
  readonly mrFacts: DevelopmentPorts.DevelopmentMrFactsSourcePort
  readonly claimKeys: DevelopmentPorts.RepositoryCodeHostClaimKeysPort
} => delivery
// DA's repository remote is what integration's binding reads.
const remoteForBinding = (
  remote: RepoRemotePort,
): Parameters<typeof composeDevelopmentCodeHostBinding>[0]['repositories'] => remote

type CodeHostConnection = MrEnsureConnectionDeps['call']['connection']
const connection = (provider: 'gitlab' | 'github', baseUrl: string) =>
  ({ provider, baseUrl, repositoryUrlPrefixes: [] }) as unknown as CodeHostConnection
const requests = {
  async executeCodeHostCall() {
    return { ok: false, code: 'unused', summary: 'not called' }
  },
} as unknown as MrEnsureConnectionDeps['requests']
const MISSING = {
  ok: false as const,
  code: 'code-host-connection-missing' as const,
  detail: 'no code-host binding for repository r1',
}

describe('RFC-471 —— 退役的文件不在、零引用', () => {
  test('两个文件不在', () => {
    for (const path of RETIRED)
      expect([path, existsSync(join(SRC, `${path}.ts`))]).toEqual([path, false])
  })

  test('backend 的 src、用例与脚本零 import 它们', () => {
    expect(importsOf(walk(SRC))).toEqual([])
    expect(importsOf(walk(TESTS))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')))).toEqual([])
  }, 60_000)

  test('四个包、e2e 与仓根脚本里没有指着它们的路径字面量（注释不算）', () => {
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

  test('负对照：判据认得出别名、相对路径、空 import {} 与路径字面量，不误伤注释与同前缀', () => {
    const probe = join(SRC, 'services', 'probe.ts')
    expect(targetOf(probe, './developmentDeliveryDeps')).toBe('services/developmentDeliveryDeps')
    expect(
      targetOf(probe, '../modules/development-automation/domain/repositoryProviderMatch'),
    ).toBe('modules/development-automation/domain/repositoryProviderMatch')
    const fixture = [
      "import {} from '@/services/developmentDeliveryDeps'",
      "export type { X } from '../modules/development-automation/domain/repositoryProviderMatch'",
      "const lazy = import('@/services/developmentDeliveryDeps')",
      '// @/services/developmentDeliveryDeps (a comment)',
      "import { y } from '@/services/developmentDeliveryDepsV2'",
    ].join('\n')
    const targets = specifiersIn(fixture).map((specifier) => targetOf(probe, specifier))
    expect(targets.filter((target) => RETIRED.includes(target ?? ''))).toHaveLength(3)
    expect(
      retiredPathLiterals(
        'probe.ts',
        [
          "read('packages/backend/src/services/developmentDeliveryDeps.ts')",
          '// packages/backend/src/services/developmentDeliveryDeps.ts',
          '/** `modules/development-automation/domain/repositoryProviderMatch.ts` */',
        ].join('\n'),
      ),
    ).toEqual(['probe.ts: packages/backend/src/services/developmentDeliveryDeps.ts'])
  })
})

describe('RFC-471 —— 结构同形与依赖方向', () => {
  test('编译期锁成立', () => {
    expect([sameSnapshot, sameThread, sameMessage]).toEqual([true, true, true])
    expect([typeof handOver, typeof remoteForBinding]).toEqual(['function', 'function'])
  })

  test('DA 的新文件不取 integration；交付 provider 只取 integration 的 public；integration 的组装不取 DA', () => {
    const imports = (path: string) => specifiersIn(read(path))
    for (const path of [
      'modules/development-automation/composition/developmentDelivery.ts',
      'modules/development-automation/application/ports/developmentDelivery.ts',
    ])
      expect([path, imports(path).filter((s) => s.includes('modules/integration'))]).toEqual([
        path,
        [],
      ])
    expect(
      imports(
        'modules/development-automation/infrastructure/developmentDeliveryProvider.ts',
      ).filter((s) => s.includes('modules/integration')),
    ).toEqual(['@/modules/integration/public/participants'])
    expect(
      imports('modules/integration/composition/codeHostEffects.ts').filter((s) =>
        s.includes('development-automation'),
      ),
    ).toEqual([])
    expect(
      imports('modules/development-automation/composition/missionOperations.ts').filter((s) =>
        s.includes('developmentDeliveryDeps'),
      ),
    ).toEqual([])
  })

  test('DA 的 public 不再转出只有本桥在用的 pipeline 证据组装与类型（AST 取导出名，带正对照）', () => {
    const exportedNames = (path: string) => {
      const file = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
      const exported = (node: ts.Node) =>
        ts.canHaveModifiers(node) &&
        (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      return file.statements.flatMap((statement): string[] => {
        if (ts.isExportDeclaration(statement)) {
          // `export *` would hide names from this check: there must be none.
          if (statement.exportClause === undefined) return ['*']
          return ts.isNamedExports(statement.exportClause)
            ? statement.exportClause.elements.map((element) => element.name.text)
            : [statement.exportClause.name.text]
        }
        if (ts.isVariableStatement(statement))
          return exported(statement)
            ? statement.declarationList.declarations.flatMap((d) =>
                ts.isIdentifier(d.name) ? [d.name.text] : [],
              )
            : []
        if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isClassDeclaration(statement)) &&
          exported(statement)
        )
          return statement.name === undefined ? [] : [statement.name.text]
        return []
      })
    }
    const offered = [
      ...exportedNames('modules/development-automation/public/participants.ts'),
      ...exportedNames('modules/development-automation/public/types.ts'),
    ]
    // Positive controls: the parser sees both re-export lists and plain declarations.
    for (const name of [
      'assertEvidenceStagingFactory',
      'developmentBuiltinAgentConfigurationV2',
      'EvidenceStagingFactory',
      'DEVELOPMENT_APPROVAL_STATUS_CHANGED_EVENT_REF',
    ])
      expect([name, offered.includes(name)]).toEqual([name, true])
    expect(offered).not.toContain('*')
    for (const name of [
      'composeSelectedDevelopmentPipelineEvidence',
      'composeLegacyDevelopmentPipelineEvidence',
      'LegacyPipelineEvidencePort',
      'PipelineStagingFactories',
    ])
      expect([name, offered.includes(name)]).toEqual([name, false])
  })

  test('MR effects 全仓只一份实现：integration 的三个 MR 写 / 读函数只在 codeHostEffects.ts 被调', () => {
    const callers = walk(SRC).flatMap((path) => {
      const text = readFileSync(path, 'utf8')
      return ['ensureMergeRequest(', 'observeMergeRequest(', 'replyMergeRequestThread(']
        .filter((call) => text.includes(call) && !text.includes(`export async function ${call}`))
        .map((call) => `${slash(relative(SRC, path))}: ${call}`)
    })
    expect(callers.sort()).toEqual([
      'modules/integration/composition/codeHostEffects.ts: ensureMergeRequest(',
      'modules/integration/composition/codeHostEffects.ts: observeMergeRequest(',
      'modules/integration/composition/codeHostEffects.ts: replyMergeRequestThread(',
    ])
  })
})

describe('RFC-471 —— 装配根', () => {
  test('交付 provider 不收连接与请求；integration 由它的仓库远端组装绑定', () => {
    const credentials = read('bootstrap/daemonModules/repositoryCredentials.ts')
    const provider = credentials.slice(
      credentials.indexOf('createDevelopmentDeliveryProvider({'),
      credentials.indexOf('composeDevelopmentCodeHostDelivery({'),
    )
    expect(provider).not.toContain('connections:')
    expect(provider).not.toContain('requests:')
    expect(credentials).toMatch(
      /composeDevelopmentCodeHostDelivery\(\{\s*repositories:\s*\{\s*resolve:\s*\(repositoryId\)\s*=>\s*developmentDeliveryProvider\.resolveRepository\(repositoryId\),?\s*\},\s*connections:\s*codeHostConnections,/,
    )
    expect(credentials).toMatch(/developmentDeliveryProvider,\s*developmentCodeHost,/)
  })

  test('DA 的 mission 操作、交付依赖与事实采集收 integration 的组装；事件观察者用同一个绑定', () => {
    const automation = read('bootstrap/daemonModules/developmentAutomation.ts')
    expect(automation).toMatch(
      /mrEffects:\s*repository\.developmentCodeHost\.mrEffects,\s*repositoryClaimKeys:\s*repository\.developmentCodeHost\.claimKeys,/,
    )
    expect(automation).toMatch(
      /composeDevelopmentMrFactsCollector\(\{\s*provider:\s*repository\.developmentDeliveryProvider,\s*mrFacts:\s*repository\.developmentCodeHost\.mrFacts,?\s*\}\)/,
    )
    for (const file of [
      'bootstrap/daemonModules/developmentAutomation.ts',
      'bootstrap/daemonModules/digitalEmployee.ts',
    ])
      expect([file, read(file)]).toEqual([
        file,
        expect.stringMatching(
          /composeDevelopmentDeliveryDeps\(\{\s*provider:\s*repository\.developmentDeliveryProvider,\s*mrEffects:\s*repository\.developmentCodeHost\.mrEffects,\s*mrFacts:\s*repository\.developmentCodeHost\.mrFacts,/,
        ),
      ])
    expect(read('bootstrap/daemonModules/integration.ts')).toMatch(
      /binding:\s*input\.developmentCodeHostBinding,/,
    )
    expect(read('bootstrap/daemonApplication.ts')).toMatch(
      /developmentCodeHostBinding:\s*developmentCodeHost\.binding,/,
    )
  })
})

describe('RFC-471 —— 行为', () => {
  test('绑定：仓库没有远端 → null；GitHub / GitLab 匹配出 provider、project、调用依赖与请求；没有匹配的连接 → null', async () => {
    const gh = connection('github', 'https://api.github.com')
    const gl = connection('gitlab', 'https://gitlab.example/api/v4')
    const remotes: Record<string, string> = {
      a: 'https://github.com/owner/repo.git',
      b: 'https://gitlab.example/grp/sub/repo.git',
      c: 'https://elsewhere.example/x/y.git',
    }
    const binding = composeDevelopmentCodeHostBinding({
      repositories: { resolve: async (id) => (id in remotes ? { remoteUrl: remotes[id]! } : null) },
      connections: { resolve: async (provider) => (provider === 'github' ? gh : gl) },
      requests,
    })
    expect(await binding('missing')).toBeNull()
    const a = await binding('a')
    expect(a).toEqual({
      provider: 'github',
      project: 'owner/repo',
      call: { connection: gh, ctx: { ports: {} } },
      requests,
    })
    expect(a?.call.connection).toBe(gh)
    expect(a?.requests).toBe(requests)
    expect(await binding('b')).toEqual({
      provider: 'gitlab',
      project: encodeURIComponent('grp/sub/repo'),
      call: { connection: gl, ctx: { ports: {} } },
      requests,
    })
    expect(await binding('c')).toBeNull()
    // The SaaS fallback names github.com, but without a configured connection there is nothing to bind.
    const unconnected = composeDevelopmentCodeHostBinding({
      repositories: { resolve: () => ({ remoteUrl: remotes.a! }) },
      connections: { resolve: async () => null },
      requests,
    })
    expect(await unconnected('a')).toBeNull()
  })

  test('MR effects：同步与异步绑定缺失时三个方法都回 code-host-connection-missing；异步绑定照常调用', async () => {
    for (const binding of [() => null, async () => null]) {
      const effects = composeDevelopmentMrEffects({ binding })
      expect(
        await effects.ensure('r1', {
          missionId: 'm1',
          sourceBranch: 'feature',
          targetBranch: 'main',
          title: 'x',
        }),
      ).toEqual(MISSING)
      expect(
        await effects.reply('r1', { mrRef: '7', threadRef: 't', body: 'b', selfMarker: 'm1' }),
      ).toEqual(MISSING)
      expect(await effects.observe('r1', '7')).toEqual(MISSING)
    }
    const calls: unknown[] = []
    const replying = {
      async executeCodeHostCall(request: unknown) {
        calls.push(request)
        return { ok: true, status: 201, body: '{"id":42}' }
      },
    } as unknown as MrEnsureConnectionDeps['requests']
    const effects = composeDevelopmentMrEffects({
      binding: async () => ({
        provider: 'gitlab',
        project: 'grp%2Frepo',
        call: {
          connection: connection('gitlab', 'https://gitlab.example/api/v4'),
          ctx: { ports: {} },
        },
        requests: replying,
      }),
    })
    expect(
      await effects.reply('r1', { mrRef: '7', threadRef: 't1', body: 'done', selfMarker: 'm1' }),
    ).toEqual({ ok: true, noteRef: '42' })
    expect(calls).toHaveLength(1)
  })

  test('原始事实：绑定缺失回 code-host-connection-missing，其余原样透传采集结果', async () => {
    expect(
      await composeDevelopmentMrFactsSource({ binding: async () => null }).collect('r1', '7', {
        selfMarker: 'm1',
      }),
    ).toEqual(MISSING)
    const failing = {
      async executeCodeHostCall() {
        return { ok: false, code: 'http-500', summary: 'boom' }
      },
    } as unknown as MrEnsureConnectionDeps['requests']
    const out = await composeDevelopmentMrFactsSource({
      binding: () => ({
        provider: 'github',
        project: 'owner/repo',
        call: { connection: connection('github', 'https://api.github.com'), ctx: { ports: {} } },
        requests: failing,
      }),
    }).collect('r1', '7', { selfMarker: 'm1' })
    expect(out).toEqual({
      ok: false,
      code: 'mr-facts-lookup-failed',
      detail: 'http-500: boom',
    })
  })

  test('一处组装：绑定与建在它上面的三项能力用同一个绑定（装配根接的就是它）', async () => {
    const delivery = composeDevelopmentCodeHostDelivery({
      repositories: {
        resolve: async (id) =>
          id === 'r1' ? { remoteUrl: 'https://gitlab.example/grp/repo.git' } : null,
      },
      connections: {
        resolve: async (provider) =>
          provider === 'gitlab' ? connection('gitlab', 'https://gitlab.example/api/v4') : null,
      },
      requests,
    })
    expect(Object.isFrozen(delivery)).toBe(true)
    expect((await delivery.binding('r1'))?.project).toBe(encodeURIComponent('grp/repo'))
    expect(await delivery.claimKeys.resolve('r1')).toEqual({
      codeHostEndpointRef: 'gitlab',
      stableProjectRef: 'grp/repo',
    })
    const missing = { ...MISSING, detail: 'no code-host binding for repository r2' }
    expect(await delivery.claimKeys.resolve('r2')).toBeNull()
    expect(await delivery.mrEffects.observe('r2', '7')).toEqual(missing)
    expect(await delivery.mrFacts.collect('r2', '7', { selfMarker: 'm1' })).toEqual(missing)
  })

  test('认领键：解出 provider 与解码后的 project；没有绑定 → null', async () => {
    const keys = composeRepositoryCodeHostClaimKeys({
      binding: async (id) =>
        id === 'r1'
          ? {
              provider: 'gitlab',
              project: encodeURIComponent('grp/sub/repo'),
              call: {
                connection: connection('gitlab', 'https://gitlab.example'),
                ctx: { ports: {} },
              },
              requests,
            }
          : null,
    })
    expect(await keys.resolve('r1')).toEqual({
      codeHostEndpointRef: 'gitlab',
      stableProjectRef: 'grp/sub/repo',
    })
    expect(await keys.resolve('r2')).toBeNull()
  })

  const snapshot: DevelopmentPorts.DevelopmentMrFactsSnapshot = {
    mrRef: '17',
    headSha: 'a'.repeat(40),
    targetSha: 'b'.repeat(40),
    targetBranch: 'main',
    state: 'opened',
    draft: false,
    mergeableState: 'mergeable',
    approvalHold: null,
    mergedCommitSha: null,
    mergedAt: null,
    threads: [
      {
        threadRef: 't1',
        revision: 'v1',
        authorClass: 'human',
        resolved: false,
        lastBody: 'please fix',
        path: 'src/a.ts',
        messages: [
          {
            messageRef: 'n1',
            parentMessageRef: null,
            authorClass: 'human',
            body: 'please fix',
            path: 'src/a.ts',
            createdAt: null,
          },
        ],
      },
      {
        threadRef: 't2',
        revision: 'v2',
        authorClass: 'self',
        resolved: false,
        lastBody: 'on it',
        path: null,
        messages: [],
      },
      {
        threadRef: 't3',
        revision: 'v3',
        authorClass: 'bot',
        resolved: true,
        lastBody: 'lint ok',
        path: null,
        messages: [],
      },
    ],
  }

  const sourceFor = (
    results: Record<
      string,
      Awaited<ReturnType<DevelopmentPorts.DevelopmentMrFactsSourcePort['collect']>>
    >,
  ) => {
    const calls: unknown[][] = []
    const source: DevelopmentPorts.DevelopmentMrFactsSourcePort = {
      async collect(repositoryId, mrRef, options) {
        calls.push([repositoryId, mrRef, options])
        return results[repositoryId] ?? MISSING
      },
    }
    return { source, calls }
  }

  test('事实采集：四条错误文案逐字不变；成功时 snapshotRef 是同一个快照对象的摘要、线程摘要与 cell 投影照旧', async () => {
    const { source, calls } = sourceFor({
      ok: { ok: true, snapshot },
      failed: { ok: false, code: 'mr-facts-lookup-failed', detail: 'boom' },
      headless: { ok: true, snapshot: { ...snapshot, headSha: null } },
    })
    const targets: Record<string, string> = { c1: 'ok', c2: 'r1', c3: 'failed', c4: 'headless' }
    const collector = composeDevelopmentMrFactsCollector({
      provider: {
        readMrFactTarget: async ({ missionId, mrClaimId }) =>
          missionId === 'm1' && mrClaimId in targets
            ? { repositoryId: targets[mrClaimId]!, mrIid: '17' }
            : null,
      },
      mrFacts: source,
    }).mergeRequestFacts
    await expect(collector.collect({ missionId: 'm1', mrClaimId: null })).rejects.toThrow(
      'mission m1 has no MR claim to collect facts for',
    )
    await expect(collector.collect({ missionId: 'm1', mrClaimId: 'c9' })).rejects.toThrow(
      'mr claim c9 or mission not found',
    )
    await expect(collector.collect({ missionId: 'm1', mrClaimId: 'c2' })).rejects.toThrow(
      'no code-host binding for repository r1',
    )
    await expect(collector.collect({ missionId: 'm1', mrClaimId: 'c3' })).rejects.toThrow(
      'mr facts collect failed: mr-facts-lookup-failed: boom',
    )
    const collected = await collector.collect({ missionId: 'm1', mrClaimId: 'c1' })
    expect(collected.snapshotRef).toBe(canonicalDigest(snapshot))
    expect([collected.headSha, collected.targetSha]).toEqual([snapshot.headSha, snapshot.targetSha])
    expect(collected.cells['mr.exists']).toEqual({
      state: 'known',
      value: true,
      sourceRevision: collected.snapshotRef,
    })
    expect(collected.threads?.[0]).toEqual({
      threadRef: 't1',
      revision: 'v1',
      authorClass: 'human',
      resolved: false,
      bodyDigest: sha256Hex('please fix'),
      body: 'please fix',
      path: 'src/a.ts',
    })
    expect((await collector.collect({ missionId: 'm1', mrClaimId: 'c4' })).cells).toEqual({})
    // The source is asked for the claim's MR with the mission as the self marker.
    expect(calls.at(-2)).toEqual(['ok', '17', { selfMarker: 'm1' }])
  })

  test('交付依赖：仓库远端走 provider，MR effects 是注入的那一份，MR 事实按原映射（未解决且非 self 的线程计数），失败原样返回', async () => {
    const remote = { remoteUrl: 'https://github.com/owner/repo.git', defaultBranch: 'main' }
    const provider: DevelopmentDeliveryProvider = {
      resolveRepository: async (id) => (id === 'r1' ? remote : null),
      readMrFactTarget: async () => null,
      pipeline: {} as DevelopmentDeliveryProvider['pipeline'],
    }
    const factory = {
      namespace: { kind: 'evidence-staging-namespace', reference: {} },
      create: () => {
        throw new Error('staging is not used by this test')
      },
    }
    const staging = {
      collect: factory,
      trigger: factory,
      rerun: factory,
    } as unknown as PipelineStagingFactories
    const mrEffects = {} as MrEffectsPort
    const failure = { ok: false as const, code: 'mr-facts-lookup-failed', detail: 'boom' }
    const { source } = sourceFor({ r1: { ok: true, snapshot }, r2: failure })
    const deps = composeDevelopmentDeliveryDeps({ provider, mrEffects, mrFacts: source, staging })
    expect(deps.mrEffects).toBe(mrEffects)
    expect(await deps.repoRemote.resolve('r1')).toBe(remote)
    expect(await deps.repoRemote.resolve('r9')).toBeNull()
    expect(await deps.mrFacts.collect('r2', '17', 'm1')).toBe(failure)
    expect(await deps.mrFacts.collect('r3', '17', 'm1')).toEqual(MISSING)
    const mapped = await deps.mrFacts.collect('r1', '17', 'm1')
    expect(mapped).toEqual({
      ok: true,
      snapshot: {
        state: 'opened',
        headSha: snapshot.headSha,
        targetSha: snapshot.targetSha,
        targetBranch: 'main',
        draft: false,
        mergeableState: 'mergeable',
        approvalHold: null,
        mergedCommitSha: null,
        unresolvedReviewCount: 1,
        reviewThreads: snapshot.threads.map((thread) => ({
          threadRef: thread.threadRef,
          revision: thread.revision,
          authorClass: thread.authorClass,
          resolved: thread.resolved,
          body: thread.lastBody,
          path: thread.path,
          messages: thread.messages,
        })),
      },
    })
    expect(typeof deps.pipelineEvidence.collect).toBe('function')
  })
})

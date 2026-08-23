// RFC-310 T143/T165: executable owner/dependency manifest for the OS contexts.
// RFC-294's global seven-manifest W0-R remains a separate migration wave; this
// vertical-slice manifest prevents the new contexts from adding that debt now.

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import { mintedVocabulary, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BACKEND_SRC = join(REPO_ROOT, 'packages', 'backend', 'src')
const MANIFEST_PATH = join(
  REPO_ROOT,
  'design',
  'RFC-310-rule-driven-development-digital-employee',
  'os-architecture-manifest.json',
)

interface ContextManifest {
  readonly owner: string
  readonly topLevelEntries: readonly string[]
  readonly publicEntries: readonly string[]
  readonly externalImports: readonly string[]
}

interface OsArchitectureManifest {
  readonly schemaVersion: 1
  readonly contexts: Readonly<
    Record<'digital-employee' | 'event-center' | 'execution-contract', ContextManifest>
  >
  readonly genericVocabularyBan: {
    readonly note: string
    readonly extraLiterals: readonly { readonly literal: string; readonly why: string }[]
    readonly allowlist: readonly {
      readonly file: string
      readonly literals: readonly string[]
      readonly why: string
      readonly removeWhen: string
    }[]
  }
}

/**
 * 通用 OS / 画布不得出现的业务身份词汇。
 *
 * 主体从**内置类型包的描述符**派生——它是「开发员工这一类型有哪些身份」的单一事实源，
 * 类型包演进时禁用集自动跟上；手抄一份等于把同一批词写两遍，而写两遍的那一份必然过期
 * （这正是 DE-07 的形态：一个 2026 年初写下的单词，一直被当成整条不耦合规则的执法者）。
 *
 * `extraLiterals` 是少量**手写且逐条有据**的补充：开发域的终态词（'merged' 等）不在描述符
 * 里，却是最典型的越界形态。刻意不把 'failed' / 'canceled' 这类通用生命周期词放进来——
 * 那会让违规集被假阳性淹没，最后所有人都去加豁免。
 */
function derivedGenericVocabularyBan(): readonly string[] {
  const descriptor = JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
    readonly typeRef: { readonly typeId: string }
    readonly workContracts?: readonly Record<string, unknown>[]
    readonly contextTypes?: readonly { readonly typeId?: string }[]
    readonly eventTypes?: readonly { readonly ref?: { readonly id?: string } }[]
  }
  const vocabulary = new Set<string>([descriptor.typeRef.typeId])
  for (const contract of descriptor.workContracts ?? []) {
    for (const key of ['contractId', 'inputSchemaId', 'outputSchemaId']) {
      const value = contract[key]
      if (typeof value === 'string') vocabulary.add(value)
    }
  }
  for (const context of descriptor.contextTypes ?? []) {
    if (typeof context.typeId === 'string') vocabulary.add(context.typeId)
  }
  for (const event of descriptor.eventTypes ?? []) {
    if (typeof event.ref?.id === 'string') vocabulary.add(event.ref.id)
  }
  for (const extra of manifest.genericVocabularyBan.extraLiterals) vocabulary.add(extra.literal)
  return [...vocabulary].sort()
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as OsArchitectureManifest

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, out)
    else if (/\.[cm]?tsx?$/.test(name)) out.push(path)
  }
  return out
}

function portable(path: string): string {
  return path.replaceAll('\\', '/')
}

function importSpecifiers(text: string): string[] {
  const values: string[] = []
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) values.push(match[1]!)
  }
  return [...new Set(values)].sort()
}

describe('RFC-310 Digital Employee OS architecture manifest', () => {
  test('new bounded contexts keep their exact owner roots and public entrypoints', () => {
    expect(manifest.schemaVersion).toBe(1)
    for (const [context, entry] of Object.entries(manifest.contexts)) {
      expect(entry.owner.length).toBeGreaterThan(20)
      const root = join(BACKEND_SRC, 'modules', context)
      expect(readdirSync(root).sort()).toEqual([...entry.topLevelEntries].sort())
      expect(readdirSync(join(root, 'public')).sort()).toEqual([...entry.publicEntries].sort())
    }
  })

  test('every external dependency equals the reviewed public/composition/provider-adapter manifest', () => {
    const files = walk(BACKEND_SRC)
    for (const [context, entry] of Object.entries(manifest.contexts)) {
      const moduleRoot = portable(join(BACKEND_SRC, 'modules', context))
      const prefix = `@/modules/${context}/`
      const actual: string[] = []
      for (const file of files) {
        if (portable(file).startsWith(`${moduleRoot}/`)) continue
        for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
          if (!specifier.startsWith(prefix)) continue
          actual.push(
            `${portable(relative(BACKEND_SRC, file))} -> ${specifier.slice(prefix.length)}`,
          )
        }
      }
      expect(actual.sort()).toEqual([...entry.externalImports].sort())
      expect(
        actual.every(
          (edge) =>
            / -> (?:composition|public\/(?:commands|queries|participants|events|types))$/.test(
              edge,
            ) ||
            /^modules\/[^/]+\/application\/adapters\/[^ ]+-adapter\.ts -> composition\/required-ports$/.test(
              edge,
            ),
        ),
      ).toBe(true)
    }
  })

  test('generic OS core and canvas never branch on the development employee type', () => {
    const genericRoots = [
      join(BACKEND_SRC, 'modules', 'digital-employee'),
      join(BACKEND_SRC, 'modules', 'event-center'),
      join(BACKEND_SRC, 'modules', 'execution-contract'),
      join(REPO_ROOT, 'packages', 'frontend', 'src', 'components', 'digital-employees'),
    ]
    const genericRoutes = [
      join(REPO_ROOT, 'packages', 'frontend', 'src', 'routes', 'digital-employees.tsx'),
      join(REPO_ROOT, 'packages', 'frontend', 'src', 'routes', 'digital-employees.$typeRef.tsx'),
      join(REPO_ROOT, 'packages', 'frontend', 'src', 'routes', 'employee-cases.$caseId.tsx'),
      join(
        REPO_ROOT,
        'packages',
        'frontend',
        'src',
        'components',
        'task-creation',
        'TaskCreationSubjectDescriptorContract.tsx',
      ),
    ]
    const files = [...genericRoots.flatMap((root) => walk(root)), ...genericRoutes]

    // RFC-317 T32（DE-07）—— 禁用集由内置类型包描述符**派生**，不是一个手抄的单词。
    //
    // 旧写法是 `new RegExp(\`['"]\${manifest.genericTypeLiteralBan}['"]\`)` 打在原始文本上，
    // genericTypeLiteralBan = 'development'。它读起来像「通用 OS 与画布永不按开发员工
    // 类型分支」，实际只挡住**一个词的一种拼法**：模板字符串、导入常量、
    // `startsWith('develop')`、标识符形式全都绕得过。更糟的是它扫描的文件里当时就已经
    // 躺着业务身份（`terminalKind === 'merged'`、'MR 已合入' 文案），却照样全绿——
    // 下游（含 RFC-294 提案）把这条当成「不再耦合」的执法依据，而它没有那个力量。
    const banned = derivedGenericVocabularyBan()
    expect(banned.length, '禁用集派生为空 ⇒ 下面那条必然绿，零预言力').toBeGreaterThanOrEqual(20)
    const allowlist = new Map(
      manifest.genericVocabularyBan.allowlist.map((entry) => [entry.file, entry] as const),
    )
    const offenders: string[] = []
    for (const file of files) {
      const rel = portable(relative(REPO_ROOT, file))
      const hits = mintedVocabulary(sourceUnit(rel, readFileSync(file, 'utf8')), banned)
      if (hits.length === 0) continue
      const allowed = allowlist.get(rel)
      const literals = [...new Set(hits.map((hit) => hit.slice(hit.indexOf("'") + 1, -1)))].sort()
      if (allowed === undefined) {
        offenders.push(`${rel} → ${literals.join(', ')}（不在 allowlist）`)
        continue
      }
      const unlisted = literals.filter((literal) => !allowed.literals.includes(literal))
      if (unlisted.length > 0) offenders.push(`${rel} → ${unlisted.join(', ')}（allowlist 未覆盖）`)
    }
    expect(
      offenders,
      '通用 OS / 画布里出现了开发员工类型的业务身份。要么把它移回类型包，要么在' +
        'os-architecture-manifest.json 的 genericVocabularyBan.allowlist 里逐条登记并写清' +
        'why / removeWhen——登记是**显式欠账**，不是豁免',
    ).toEqual([])
  })

  test('RFC-317 T32 —— allowlist 无过期条目（文件没了 / 已清干净 ⇒ 删掉这一行）', () => {
    const banned = derivedGenericVocabularyBan()
    const stale: string[] = []
    for (const entry of manifest.genericVocabularyBan.allowlist) {
      const absolute = join(REPO_ROOT, entry.file)
      if (!existsSync(absolute)) {
        stale.push(`${entry.file}（文件已不存在）`)
        continue
      }
      const hits = new Set(
        mintedVocabulary(sourceUnit(entry.file, readFileSync(absolute, 'utf8')), banned).map(
          (hit) => hit.slice(hit.indexOf("'") + 1, -1),
        ),
      )
      const gone = entry.literals.filter((literal) => !hits.has(literal))
      if (gone.length > 0) stale.push(`${entry.file} → ${gone.join(', ')}（已清干净，登记应删）`)
    }
    expect(stale, 'allowlist 只能缩、不能涨；过期条目必须删').toEqual([])
  })

  test('RFC-317 T32 —— 每条 allowlist / 手写禁用词都写清了理由与清偿波次', () => {
    const badAllow = manifest.genericVocabularyBan.allowlist
      .filter(
        (entry) =>
          entry.why.trim().length < 20 ||
          entry.removeWhen.trim().length < 5 ||
          !/RFC-\d{3}|T\d{1,3}/.test(entry.removeWhen),
      )
      .map((entry) => entry.file)
    expect(badAllow, 'removeWhen 必须点名具体 RFC / 任务').toEqual([])
    const badExtra = manifest.genericVocabularyBan.extraLiterals
      .filter((entry) => entry.why.trim().length < 20)
      .map((entry) => entry.literal)
    expect(
      badExtra,
      '手写的禁用词必须写清「为什么它是开发域专有、而不是通用生命周期词」——' +
        '把 failed / canceled 这类通用词放进来会淹没在假阳性里',
    ).toEqual([])
  })

  test('every Digital Employee composition requires the platform execution-contract participant', () => {
    const composition = readFileSync(
      join(BACKEND_SRC, 'modules', 'digital-employee', 'composition.ts'),
      'utf8',
    )
    const authoring = readFileSync(
      join(BACKEND_SRC, 'modules', 'digital-employee', 'application', 'authoringService.ts'),
      'utf8',
    )
    const runtime = readFileSync(
      join(BACKEND_SRC, 'modules', 'digital-employee', 'application', 'runtimeService.ts'),
      'utf8',
    )
    expect(composition).toContain('readonly executionContracts: ExecutionContractParticipant')
    expect(authoring).toContain('readonly executionContracts: ExecutionContractParticipant')
    expect(runtime).toContain('readonly executionContracts: ExecutionContractParticipant')
    expect(composition).not.toContain('executionContracts?:')
    expect(authoring).not.toContain('executionContracts?:')
    expect(runtime).not.toContain('executionContracts?:')
    expect(
      existsSync(
        join(BACKEND_SRC, 'modules', 'digital-employee', 'composition', 'defaultRequiredPorts.ts'),
      ),
    ).toBe(false)
  })

  test('Event Center provider adapters cannot acquire integration storage or dispatcher internals', () => {
    const adapter = readFileSync(
      join(
        BACKEND_SRC,
        'modules',
        'integration',
        'application',
        'adapters',
        'event-center-adapter.ts',
      ),
      'utf8',
    )
    expect(adapter).toContain('@/modules/event-center/composition/required-ports')
    for (const forbidden of [
      "from '@/db",
      "from '@/services",
      "from 'drizzle-orm'",
      '/infrastructure/',
    ]) {
      expect(adapter).not.toContain(forbidden)
    }
  })

  test('Webhook ingress is publisher-only and Event Center receives no endpoint-wide dispatcher', () => {
    const ingress = readFileSync(join(BACKEND_SRC, 'routes', 'webhooks.ts'), 'utf8')
    const replay = readFileSync(join(BACKEND_SRC, 'routes', 'webhookDeliveries.ts'), 'utf8')
    const integrationComposition = readFileSync(
      join(BACKEND_SRC, 'modules', 'integration', 'composition.ts'),
      'utf8',
    )
    const dispatcherTypes = readFileSync(
      join(BACKEND_SRC, 'services', 'webhook', 'dispatcherTypes.ts'),
      'utf8',
    )

    for (const route of [ingress, replay]) {
      expect(route).toContain('commands.observe(')
      expect(route).not.toMatch(/webhookDispatcher\s*\.\s*dispatch\s*\(/)
    }
    expect(integrationComposition).toContain('dispatcher: EventCenterCodeHostDeliveryDispatcher')
    expect(dispatcherTypes).toContain(
      'export interface EventCenterCodeHostDeliveryDispatcher {\n  dispatchSubscription',
    )
    expect(dispatcherTypes).toContain(
      'export interface EventCenterAutomationWorkStarter {\n  dispatchEventTarget',
    )
    expect(dispatcherTypes).not.toMatch(
      /interface EventCenter\w+ \{[^}]*dispatchSubscription[^}]*dispatchEventTarget/,
    )
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的源码喂给 `importSpecifiers` 自己。
//
// 见 rfc310-architecture-lock 同名 describe：解析漏掉一种语法形态 ⇒ 越界边根本
// 不进集合 ⇒ 规则永远零违规，与「模块干净」同形。
describe('RFC-317 T14 —— matcher 自证：五种 import 语法都必须被解析出来', () => {
  test('static / type-only / export-from / 裸 import / 动态 import / require 全覆盖', () => {
    const fabricated =
      "import { a } from '@/modules/one/public/commands'\n" +
      "import type { B } from '@/modules/two/public/types'\n" +
      "export { c } from '@/modules/three/public/events'\n" +
      "import '@/modules/four/composition'\n" +
      "const e = await import('@/modules/five/application/service')\n" +
      "const f = require('@/modules/six/infrastructure/store')\n"
    expect(importSpecifiers(fabricated)).toEqual([
      '@/modules/five/application/service',
      '@/modules/four/composition',
      '@/modules/one/public/commands',
      '@/modules/six/infrastructure/store',
      '@/modules/three/public/events',
      '@/modules/two/public/types',
    ])
  })

  test('路径归一化对 Windows 分隔符生效（否则 Windows 上整条规则形同虚设）', () => {
    expect(portable('modules\\digital-employee\\public\\types.ts')).toBe(
      'modules/digital-employee/public/types.ts',
    )
  })
})

// RFC-317 T13 —— 语料非空。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到后端源码语料（扫空即假绿）', () => {
    expect(walk(BACKEND_SRC).length).toBeGreaterThanOrEqual(600)
  })
})

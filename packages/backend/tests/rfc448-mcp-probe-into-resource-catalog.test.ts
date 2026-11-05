// RFC-448 — MCP 探测用例与资源操作协调器归 resource-catalog（RFC-294 W4 B / D 第十四步）。
//
// 锁四件事：
// ① 位置与引用：三个 `services/` 文件不存在，源码里没有文件 import 它们（census AST，别名与相对路径都认，带负对照）；
//    路由不 import `services/`、对 resource-catalog 只经 public；探测用例与记录读写不 import infrastructure / composition / legacy；
//    装配根不再 import 路由。
// ② 两个进程级协调器实例只在 composition 声明一次。
// ③ 探测用例的外部行为：404 区分、配置变化 409、禁用 422（都不探测）、成功写入并带回 configHashUsed、同一配置并发只探测一次、
//    列表只给可见 MCP 的记录。
// ④ 装配：有 `probeRunner` 时探测交给它；`mcpProbeNow()` 取测试注入的时钟。
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createMcpProbeOperations } from '@/modules/resource-catalog/application/mcps/probeOperations'
import {
  __setMcpProbeOptionsForTesting,
  composeMcpProbeOperations,
  mcpOperationCoordinator,
  mcpProbeNow,
  pluginOperationCoordinator,
} from '@/modules/resource-catalog/composition'
import { ResourceOperationCoordinator } from '@/modules/resource-catalog/infrastructure/resourceOperationCoordinator'
import type {
  McpAclIdentityParticipant,
  McpOperationContext,
  McpProbeMeasurement,
  McpProbeStore,
} from '@/modules/resource-catalog/public/participants'
import type { McpQueries } from '@/modules/resource-catalog/public/queries'
import type { McpCatalogResource, McpProbeRecord } from '@/modules/resource-catalog/public/types'
import { DomainError } from '@/util/errors'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const RC = 'modules/resource-catalog'
const OLD_PATHS = [
  'services/mcpProbe',
  'services/mcpProbeStore',
  'services/resourceOperationCoordinator',
] as const

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** 文件的全部模块说明符（静态 / 类型 / 动态 import、export-from、require），去重；与 R1 账本同一口径。 */
function specifiersOf(path: string): string[] {
  const rel = relative(REPO_ROOT, path).split('\\').join('/')
  const unit = sourceUnit(rel, readFileSync(path, 'utf8'))
  return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
}

/** 说明符解析到 `src/` 下的路径（不带扩展名）；包名等非本地说明符返回 null。 */
function targetOf(from: string, specifier: string): string | null {
  let target: string
  if (specifier.startsWith('@/')) target = specifier.slice(2)
  else if (specifier.startsWith('.')) {
    target = relative(SRC, resolve(from, '..', specifier))
      .split('\\')
      .join('/')
  } else return null
  return target.replace(/\.[cm]?tsx?$/, '')
}

function targetsOf(rel: string): string[] {
  const path = join(SRC, rel)
  return specifiersOf(path).flatMap((specifier) => targetOf(path, specifier) ?? [])
}

function srcRelative(path: string): string {
  return relative(SRC, path).split('\\').join('/')
}

async function rejectionOf(run: () => Promise<unknown>): Promise<DomainError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof DomainError) return error
    throw error
  }
  throw new Error('expected a DomainError')
}

const AUTHORITY = { actor: 'viewer' } as unknown as McpOperationContext

function mcpResource(overrides: Partial<Record<string, unknown>> = {}): McpCatalogResource {
  return {
    id: 'mcp-1',
    name: 'files',
    enabled: true,
    updatedAt: 1_000,
    operationConfigHash: 'hash-1',
    type: 'local',
    ...overrides,
  } as unknown as McpCatalogResource
}

function measurement(startedAt: number): McpProbeMeasurement {
  return {
    status: 'ok',
    latencyMs: 12,
    handshakeMs: 5,
    serverInfo: { name: 'files', version: '1.0.0' },
    protocolVersion: '2025-06-18',
    capabilities: {},
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    errorCode: null,
    errorMessage: null,
    errorDetail: null,
    startedAt,
    finishedAt: startedAt + 12,
  }
}

/** 内存里的探测记录存储（按 mcpId 一行）。 */
function memoryProbeStore(): McpProbeStore {
  const rows = new Map<string, McpProbeRecord>()
  return {
    list: async () => [...rows.values()],
    getByMcpId: async (mcpId) => rows.get(mcpId) ?? null,
    upsert: async (mcpId, write) => {
      // The write first: an explicit row identity always wins over whatever the
      // caller's object happens to carry.
      const record: McpProbeRecord = {
        ...write,
        id: `probe-${mcpId}`,
        mcpId,
        mcpName: 'files',
        updatedAt: write.finishedAt,
      }
      rows.set(mcpId, record)
      return record
    },
  }
}

function harness(visible: McpCatalogResource[]) {
  let probes = 0
  const store = memoryProbeStore()
  const queries = {
    get: async (_authority: McpOperationContext, input: { readonly id: string }) =>
      visible.find((mcp) => mcp.id === input.id) ?? null,
    list: async () => visible,
  } as unknown as McpQueries
  const aclIdentity = { load: async () => null } as unknown as McpAclIdentityParticipant
  const operations = createMcpProbeOperations({
    queries,
    aclIdentity,
    store,
    coordinator: new ResourceOperationCoordinator(),
    now: () => 5_000,
    runProbe: async (_mcp, { startedAt }) => {
      probes += 1
      await Bun.sleep(5)
      return measurement(startedAt)
    },
  })
  return { operations, store, probesRun: () => probes }
}

describe('RFC-448 —— 位置与引用', () => {
  test('三个旧文件不存在，用例、记录、探测、协调器与装配各在新位置', () => {
    for (const old of OLD_PATHS) expect(existsSync(join(SRC, `${old}.ts`))).toBe(false)
    for (const file of [
      `${RC}/application/mcps/probeOperations.ts`,
      `${RC}/application/mcps/probeRecords.ts`,
      `${RC}/infrastructure/mcpProbe.ts`,
      `${RC}/infrastructure/resourceOperationCoordinator.ts`,
      `${RC}/composition/resourceOperationCoordinators.ts`,
      `${RC}/composition/mcpProbeOperations.ts`,
    ])
      expect(existsSync(join(SRC, file))).toBe(true)
  })

  test('源码里没有文件 import 三个旧路径；装配根不再 import 路由', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(500)
    const offenders: string[] = []
    const routeImporters: string[] = []
    for (const path of files) {
      for (const specifier of specifiersOf(path)) {
        const target = targetOf(path, specifier)
        if (target !== null && (OLD_PATHS as readonly string[]).includes(target))
          offenders.push(`${srcRelative(path)} -> ${specifier}`)
        if (target === 'routes/mcps') routeImporters.push(srcRelative(path))
      }
    }
    expect(offenders).toEqual([])
    // 非空对照：路由仍由 server.ts 挂载；装配根（bootstrap/）不再取路由里的时钟。
    expect(routeImporters).toEqual(['server.ts'])
  }, 60_000)

  test('负对照：同一判据认得出别名与相对路径两种写法', () => {
    const probe = join(SRC, 'routes', 'probe.ts')
    expect(targetOf(probe, '@/services/mcpProbe')).toBe('services/mcpProbe')
    expect(targetOf(probe, '../services/mcpProbeStore.ts')).toBe('services/mcpProbeStore')
    expect(targetOf(probe, '@/services/mcpProbe')).not.toBe('services/mcpProbeStore')
    expect(targetOf(probe, '@agent-workflow/shared')).toBeNull()
  })

  test('路由不 import services/，对 resource-catalog 只经 public', () => {
    const targets = targetsOf('routes/mcps.ts')
    expect(targets.filter((target) => target.startsWith('services/'))).toEqual([])
    const rc = targets.filter((target) => target.startsWith(`${RC}/`))
    expect(rc.length).toBeGreaterThan(0)
    for (const target of rc) expect(target.startsWith(`${RC}/public/`), target).toBe(true)
    expect(rc).toContain(`${RC}/public/types`)
  })

  test('探测用例与记录读写只依赖共享合同、util 与同模块端口 / public', () => {
    for (const file of [
      `${RC}/application/mcps/probeOperations.ts`,
      `${RC}/application/mcps/probeRecords.ts`,
    ]) {
      const targets = targetsOf(`${file}`)
      expect(targets.length, file).toBeGreaterThan(1)
      for (const target of targets) {
        const allowed =
          target.startsWith('util/') ||
          target.startsWith(`${RC}/public/`) ||
          target.startsWith(`${RC}/application/`)
        expect(allowed, `${file} -> ${target}`).toBe(true)
      }
    }
  })

  test('两个进程级协调器实例只在 composition 声明一次', () => {
    const declaring = walk(SRC)
      .map((path) => ({
        path: srcRelative(path),
        count: (readFileSync(path, 'utf8').match(/new ResourceOperationCoordinator\(\)/g) ?? [])
          .length,
      }))
      .filter((entry) => entry.count > 0)
    expect(declaring).toEqual([
      { path: `${RC}/composition/resourceOperationCoordinators.ts`, count: 2 },
    ])
    expect(mcpOperationCoordinator).toBeInstanceOf(ResourceOperationCoordinator)
    expect(pluginOperationCoordinator).not.toBe(mcpOperationCoordinator)
  })
})

describe('RFC-448 —— 探测用例', () => {
  test('MCP 不存在 → mcp-not-found；从未探测 → probe-not-found', async () => {
    const { operations } = harness([mcpResource()])
    expect((await rejectionOf(() => operations.read(AUTHORITY, 'missing'))).code).toBe(
      'mcp-not-found',
    )
    const neverProbed = await rejectionOf(() => operations.read(AUTHORITY, 'mcp-1'))
    expect([neverProbed.code, neverProbed.status]).toEqual(['probe-not-found', 404])
  })

  test('配置哈希不符 → 409 resource-operation-stale；禁用 → 422 mcp-disabled；两者都不探测', async () => {
    const stale = harness([mcpResource()])
    const conflict = await rejectionOf(() => stale.operations.probe(AUTHORITY, 'mcp-1', 'hash-old'))
    expect([conflict.code, conflict.status]).toEqual(['resource-operation-stale', 409])
    expect(stale.probesRun()).toBe(0)

    const disabled = harness([mcpResource({ enabled: false })])
    const refused = await rejectionOf(() => disabled.operations.probe(AUTHORITY, 'mcp-1', 'hash-1'))
    expect([refused.code, refused.status]).toEqual(['mcp-disabled', 422])
    expect(disabled.probesRun()).toBe(0)
  })

  test('成功的探测写入记录、带回 configHashUsed；之后 read 与 list 都能取到', async () => {
    const { operations } = harness([mcpResource()])
    const receipt = await operations.probe(AUTHORITY, 'mcp-1', 'hash-1')
    expect(receipt).toMatchObject({ mcpId: 'mcp-1', status: 'ok', configHashUsed: 'hash-1' })
    expect(await operations.read(AUTHORITY, 'mcp-1')).toMatchObject({
      mcpId: 'mcp-1',
      status: 'ok',
    })
    expect((await operations.list(AUTHORITY)).map((probe) => probe.mcpId)).toEqual(['mcp-1'])
  })

  test('同一配置并发两次只探测一次，两次拿到同一份结果', async () => {
    const { operations, probesRun } = harness([mcpResource()])
    const [first, second] = await Promise.all([
      operations.probe(AUTHORITY, 'mcp-1', 'hash-1'),
      operations.probe(AUTHORITY, 'mcp-1', 'hash-1'),
    ])
    expect(probesRun()).toBe(1)
    expect(second).toEqual(first)
  })

  test('列表只给可见 MCP 的记录', async () => {
    const visible = [mcpResource()]
    const { operations, store } = harness(visible)
    await operations.probe(AUTHORITY, 'mcp-1', 'hash-1')
    await store.upsert('mcp-hidden', {
      ...(await store.getByMcpId('mcp-1'))!,
    })
    expect((await store.list()).map((row) => row.mcpId).sort()).toEqual(['mcp-1', 'mcp-hidden'])
    expect((await operations.list(AUTHORITY)).map((probe) => probe.mcpId)).toEqual(['mcp-1'])
  })
})

describe('RFC-448 —— 装配', () => {
  afterEach(() => __setMcpProbeOptionsForTesting(undefined))

  test('有 probeRunner 时探测交给它；mcpProbeNow() 取测试注入的时钟', async () => {
    __setMcpProbeOptionsForTesting({ now: () => 42_000 })
    expect(mcpProbeNow()).toBe(42_000)
    const runs: number[] = []
    const operations = composeMcpProbeOperations({
      queries: {
        get: async () => mcpResource({ id: 'mcp-runner', updatedAt: 0 }),
        list: async () => [mcpResource({ id: 'mcp-runner' })],
      } as unknown as McpQueries,
      aclIdentity: { load: async () => null } as unknown as McpAclIdentityParticipant,
      store: memoryProbeStore(),
      coordinator: new ResourceOperationCoordinator(),
      probeRunner: {
        probe: async (_mcp, { startedAt }) => {
          runs.push(startedAt)
          return measurement(startedAt)
        },
      },
    })
    const receipt = await operations.probe(AUTHORITY, 'mcp-runner', 'hash-1')
    expect(runs).toEqual([42_000])
    expect(receipt).toMatchObject({
      mcpId: 'mcp-runner',
      startedAt: 42_000,
      configHashUsed: 'hash-1',
    })
  })
})

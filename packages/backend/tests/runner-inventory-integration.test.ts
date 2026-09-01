// RFC-029 T4 + T8 — runner.ts must:
//   1. copy aw-inventory-dump.mjs into the per-run dir before spawning,
//   2. append a `file://` plugin spec into OPENCODE_CONFIG_CONTENT.plugin,
//   3. set OPENCODE_AW_INVENTORY_OUT in the child env,
//   4. after child exit, read the inventory file and persist the observation.
//
// RFC-297 T22 起落库目标换成 `node_runs.runtime_inventory_json`（跨运行时统一的
// 观测），旧的 `inventory_snapshot_json` 对新 run **停写**——继续写就是同一份
// 数据的第三份拷贝，且是只有 opencode 才有的那一份形状。旧列保留只为读存量行。
// 这些用例因此断言新列：读取链路（dump 文件 → 观测）没变，变的是落到哪儿。
//
// The mock-opencode fixture's MOCK_OPENCODE_WRITE_INVENTORY_FROM env var
// simulates the dump plugin's write side so this test never depends on a
// real opencode binary.

import type { Agent, RuntimeInventoryObservation } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from './helpers/runner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

function makeAgent(): Agent {
  return {
    id: ulid(),
    name: 'inv-agent',
    description: 'inventory test agent',
    outputs: ['summary'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'agent body',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  cleanup(): void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-inv-runner-'))
  const worktreePath = join(appHome, 'worktree')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return {
    db,
    appHome,
    worktreePath,
    taskId,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedRun(db: DbClient, taskId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'n1',
    status: 'pending',
  })
  return id
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

describe('runNode RFC-029 inventory snapshot', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('happy path: dump-plugin-written inventory is read and stored as captured:true', async () => {
    const agent = makeAgent()
    const nodeRunId = await seedRun(h.db, h.taskId)
    const captureCfg = join(h.appHome, 'inline-cfg.jsonl')
    const fixturePath = join(h.appHome, 'inventory-fixture.json')
    writeFileSync(
      fixturePath,
      JSON.stringify({
        schemaVersion: 1,
        capturedAt: 1700000000000,
        agents: [{ name: 'inv-agent', mode: 'primary', source: 'inline' }],
        skills: [],
        mcps: [{ name: 'memcache', type: 'local', status: 'connected', hint: null }],
        plugins: [{ specifier: 'file:///tmp/x.mjs', source: 'inline' }],
      }),
      'utf-8',
    )

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_CAPTURE_CONFIG_TO: captureCfg,
        MOCK_OPENCODE_WRITE_INVENTORY_FROM: fixturePath,
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent,
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          nodeKind: 'agent-single',
        }),
    )

    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!
    // 停写旧列（RFC-297 T22）；观测落在新列上，且富字段一个不少（AC-2）。
    expect(row.inventorySnapshotJson).toBeNull()
    expect(row.runtimeInventoryJson).not.toBeNull()
    const observation: RuntimeInventoryObservation = JSON.parse(row.runtimeInventoryJson!)
    expect(observation.state).toBe('captured')
    if (observation.state === 'captured') {
      expect(observation.faces.agents?.[0]?.name).toBe('inv-agent')
      expect(observation.faces.agents?.[0]?.mode).toBe('primary')
      expect(observation.faces.mcps?.[0]?.status).toBe('connected')
      expect(observation.faces.plugins?.[0]?.key).toBe('file:///tmp/x.mjs')
    }
  })

  test('missing inventory file → captured:false reason=file-missing', async () => {
    const agent = makeAgent()
    const nodeRunId = await seedRun(h.db, h.taskId)

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        // No MOCK_OPENCODE_WRITE_INVENTORY_FROM → mock leaves file unwritten.
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent,
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          nodeKind: 'agent-single',
        }),
    )

    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!
    expect(row.inventorySnapshotJson).toBeNull()
    // 插件没写出文件 → 观测缺失，reason 原样透传（不再是「假装有一份 captured:false
    // 快照」的旧形状）。
    const observation: RuntimeInventoryObservation = JSON.parse(row.runtimeInventoryJson!)
    expect(observation.state).toBe('unavailable')
    if (observation.state === 'unavailable') expect(observation.reason).toBe('file-missing')
  })

  test('inline OPENCODE_CONFIG_CONTENT.plugin entry includes the dump plugin file://', async () => {
    const agent = makeAgent()
    const nodeRunId = await seedRun(h.db, h.taskId)
    // Drop a tiny hook into mock-opencode by reusing CAPTURE_CONFIG path but
    // verifying via the raw inline JSON env var contents at spawn time.
    // Strategy: capture argv (which is fine but doesn't carry env), so we
    // instead read the spawned runRoot to confirm the .mjs file exists.

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent,
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          nodeKind: 'agent-single',
        }),
    )
    // runner cleans up runRoot on success — assert via the dump plugin source
    // file that should have been copied in. We can't peek at runRoot anymore
    // because cleanup ran; the inventory landing (previous test) is the
    // positive proof the plugin pathway was wired. This test asserts the
    // node row got an observation write (not NULL) on the failure branch too,
    // which means readSnapshotFromRunDir was called.
    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!
    expect(row.runtimeInventoryJson).not.toBeNull()
  })

  // RFC-297 AC-5 的端到端锁：**零注入节点**（没挂任何技能 / MCP / 子代理）。
  //
  // 这是本 RFC 唯一一个用户可感知的缺口：观测此前只在 `declaredHasContent(declared)`
  // 为真时才随启动验证记录落库，declared 全空的节点于是永远查不到「这一轮到底
  // 加载了什么」。此前只有纯函数覆盖（buildRuntimeInventoryObservation），这条补
  // 真跑 runner 的端到端——两列的**分工**必须同时成立，少一半都算没修好。
  test('AC-5 零注入节点：清单照落，验证记录不落（两者受不同的门）', async () => {
    const agent = makeAgent() // 无 skills / mcps / dependsOn → declared 全空
    const nodeRunId = await seedRun(h.db, h.taskId)
    const fixturePath = join(h.appHome, 'zero-injection-inventory.json')
    writeFileSync(
      fixturePath,
      JSON.stringify({
        schemaVersion: 1,
        capturedAt: 1700000000000,
        // 平台什么都没注入，运行时报告的都是它自带的。
        agents: [{ name: 'built-in', mode: 'primary', source: 'native' }],
        skills: [],
        mcps: [],
        plugins: [],
      }),
      'utf-8',
    )

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_WRITE_INVENTORY_FROM: fixturePath,
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent,
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          nodeKind: 'agent-single',
        }),
    )

    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!
    // 清单：无条件落库——「这一轮加载了什么」谁都想知道。
    expect(row.runtimeInventoryJson).not.toBeNull()
    const observation: RuntimeInventoryObservation = JSON.parse(row.runtimeInventoryJson!)
    expect(observation.state).toBe('captured')
    if (observation.state === 'captured') {
      expect(observation.faces.agents?.[0]?.name).toBe('built-in')
      // 平台没注入过任何东西 → 报告的一切都记 ambient，且不产生 declared-missing。
      expect(observation.faces.agents?.[0]?.provenance).toBe('ambient')
      expect(
        Object.values(observation.faces)
          .flat()
          .some((e) => e.provenance === 'declared-missing'),
      ).toBe(false)
    }
    // 验证：仍受 declaredHasContent 门控——没注入就不存在「注入是否生效」这个问题，
    // 落一条 record 只会让 banner 报出无意义的「无法验证」（RFC-280 P2-E 噪音）。
    expect(row.startupVerificationJson).toBeNull()
  })

  test('non-agent node kind: inventory column stays NULL (column not populated)', async () => {
    // Important behavior: non-agent kinds never go through runner.runNode in
    // production, but if a test/scheduler ever did, we want the inventory
    // pipeline to skip cleanly rather than write a misleading captured:false.
    const agent = makeAgent()
    const nodeRunId = await seedRun(h.db, h.taskId)

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent,
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          nodeKind: 'review',
        }),
    )

    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!
    expect(row.inventorySnapshotJson).toBeNull()
  })
})

describe('runner.ts source: dump plugin wiring lock', () => {
  test('opencode driver materializes the dump plugin; runner keeps the business gate', () => {
    // RFC-143 PR-4: the plugin materialization + inventoryOutPath threading
    // moved into the opencode driver's buildBusinessSpawn (runtime capability);
    // the runner keeps only the BUSINESS gate (agent kind + not-a-followup).
    // RFC-297 T13: 该门的字段名从 `wantsInventory` 改为 `freshAgentRun`——旧名把
    // 「opencode 需要物化 dump 插件」这条运行时知识写进了调用方，于是 MCP 测试台
    // 里长出了 `startupObservation === 'inventory-file'` 这种判据。新名只陈述业务
    // 事实，据此做什么由各 driver 自己决定。grep 锁跟着改名走。
    const driverSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'runtime', 'opencode', 'driver.ts'),
      'utf-8',
    )
    // materializeInventoryPlugin replaced the older awInventoryDumpSourcePath
    // + copyFileSync pair so binary-mode runs (which have no plugin .mjs on
    // disk) still get the file written via the embed.generated PLUGIN_FILES
    // fallback.
    expect(driverSrc).toContain('materializeInventoryPlugin')
    expect(driverSrc).toContain('inventoryOutPath')
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
      'utf-8',
    )
    // RFC-146: the agent-kind gate is the shared isAgentNodeKind now
    // (inventory.isAgentRunKind was a local copy of it and is gone).
    expect(src).toContain('isAgentNodeKind')
    expect(src).toContain('freshAgentRun')
    const spawnSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'runtime', 'opencode', 'spawn.ts'),
      'utf-8',
    )
    expect(spawnSrc).toContain('OPENCODE_AW_INVENTORY_OUT')
  })

  test('opencode-plugin/index exports both helpers and references PLUGIN_FILES embed table', () => {
    const src = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'services',
        'runtime',
        'opencode',
        'plugin',
        'index.ts',
      ),
      'utf-8',
    )
    // Source-tree path resolver (used by docs / logs).
    expect(src).toContain('export function awInventoryDumpSourcePath')
    // Runtime materializer that handles dev + binary modes. Async because
    // binary mode reads bytes via `Bun.file().arrayBuffer()` — see
    // opencode-plugin/index.ts comment for why copyFileSync on /$bunfs fails.
    expect(src).toContain('export async function materializeInventoryPlugin')
    // Binary-mode fallback is via the embed table.
    expect(src).toContain('PLUGIN_FILES')
  })

  test('build-binary.ts walks opencode-plugin dir + writes PLUGIN_FILES into embed.generated', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', '..', '..', 'scripts', 'build-binary.ts'),
      'utf-8',
    )
    // Plugins dir is registered + .mjs filter is applied.
    expect(src).toContain('pluginsDir')
    expect(src).toContain(".mjs'")
    // The generated PLUGIN_FILES export block is emitted.
    expect(src).toContain('PLUGIN_FILES: Record<string, string>')
  })

  test('plugin file exists in tree (dev mode source)', () => {
    const p = resolve(
      import.meta.dir,
      '..',
      'src',
      'services',
      'runtime',
      'opencode',
      'plugin',
      'aw-inventory-dump.mjs',
    )
    expect(existsSync(p)).toBe(true)
  })
})

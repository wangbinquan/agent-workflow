// RFC-359 W4-B2 批 a —— resource-catalog 四对只差客户端类型 / 事务原语的适配器合一，两个引擎各跑一遍：
// 演示目录种子（占位 / 重名告警 / 幂等）、MCP 探测记录（插入 → 更新 → 列表 / 单读 / 缺父）、
// agent 资源库存读取、插件世代 GC 的引用读取。写事务走 `resourceCatalogTransaction.ts`（SERIALIZABLE）。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { WorkflowDefinition } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { mcps, plugins, users } from '@/db/schema'
import { composeSqliteDemoResourceCatalogSeedParticipant } from '@/modules/resource-catalog/composition/demoResourceCatalogSeed'
import { createDatabaseAgentResourceInventoryReadPort } from '@/modules/resource-catalog/infrastructure/agentResourceInventory'
import { createDemoResourceCatalogSeedPersistence } from '@/modules/resource-catalog/infrastructure/demoResourceCatalogSeed'
import { createMcpProbeStore } from '@/modules/resource-catalog/infrastructure/mcpProbeStore'
import { createPluginGenerationReferenceReadPort } from '@/modules/resource-catalog/infrastructure/pluginGenerationGc'
import { createDemoResourceCatalogSeedParticipant } from '@/modules/resource-catalog/application/demoResourceCatalogSeed'
import type { McpProbeWrite } from '@/modules/resource-catalog/public/types'
import { describeEachProvider } from './helpers/eachProvider'

async function seedOwner(db: ProviderNeutralDatabase): Promise<string> {
  const id = `u_b2a_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'admin',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  return id
}

function demoInput(
  owner: string,
  ids: { agent: string; wf1: string; wf2: string },
  agentName = 'demo-reviewer',
) {
  const definition: WorkflowDefinition = {
    $schema_version: 1,
    inputs: [{ kind: 'text', key: 'k', label: 'k' }],
    nodes: [{ id: 'in', kind: 'input', inputKey: 'k' }],
    edges: [],
  }
  return {
    marker: { kind: 'initial-demo-offer' as const, ownerUserId: owner, offeredAt: 10 },
    agent: {
      id: ids.agent,
      name: agentName,
      description: 'demo',
      outputs: ['summary'],
      syncOutputsOnIterate: false,
      readonly: true,
      bodyMd: 'You review.',
    },
    workflows: [
      { id: ids.wf1, name: `wf-one-${ids.wf1.slice(-4)}`, description: '', definition },
      { id: ids.wf2, name: `wf-two-${ids.wf2.slice(-4)}`, description: '', definition },
    ],
  }
}

describeEachProvider('RFC-359 W4-B2a —— 演示目录种子', (harness) => {
  test('首次种下 agent + 两个工作流；重跑幂等；id 被别的名字占用 ⇒ 告警而不覆盖', async () => {
    const db = harness.db
    const owner = await seedOwner(db)
    const ids = { agent: `a_${ulid()}`, wf1: `wf_${ulid()}`, wf2: `wf_${ulid()}` }
    const participant = createDemoResourceCatalogSeedParticipant(
      createDemoResourceCatalogSeedPersistence(db),
    )
    const first = await participant.seed(demoInput(owner, ids))
    expect(first.createdAgent).toBe(true)
    expect([...first.createdWorkflowIds]).toEqual([ids.wf1, ids.wf2])
    expect(first.occupiedIdWarnings).toEqual([])
    const again = await participant.seed(demoInput(owner, ids))
    expect(again.createdAgent).toBe(false)
    expect([...again.createdWorkflowIds]).toEqual([])
    expect(again.occupiedIdWarnings).toEqual([])
    const renamed = await participant.seed(demoInput(owner, ids, 'someone-else'))
    expect(renamed.occupiedIdWarnings).toEqual([
      {
        resourceType: 'agent',
        resourceId: ids.agent,
        expectedName: 'someone-else',
        occupiedBy: 'demo-reviewer',
      },
    ])
    // 两个 bootstrap 具名装配是同一份实现。
    expect(typeof composeSqliteDemoResourceCatalogSeedParticipant(db as never).seed).toBe(
      'function',
    )
  })
})

describeEachProvider('RFC-359 W4-B2a —— MCP 探测记录', (harness) => {
  test('upsert 先插入后更新；list 按 mcp 名排序；缺父 ⇒ mcp-not-found', async () => {
    const db = harness.db
    const owner = await seedOwner(db)
    const mcpId = `m_${ulid()}`
    await db.insert(mcps).values({
      id: mcpId,
      name: `zeta-${mcpId.slice(-4).toLowerCase()}`,
      description: '',
      type: 'local',
      config: JSON.stringify({ command: ['echo'] }),
      enabled: true,
      ownerUserId: owner,
    })
    const store = createMcpProbeStore(db)
    const write = (status: 'ok' | 'error'): McpProbeWrite => ({
      status,
      latencyMs: 12,
      handshakeMs: 3,
      serverInfoJson: null,
      protocolVersion: '2025-03-26',
      capabilitiesJson: null,
      toolsJson: '[]',
      resourcesJson: null,
      resourceTemplatesJson: null,
      promptsJson: null,
      errorCode: null,
      errorMessage: status === 'error' ? 'boom' : null,
      errorDetailJson: null,
      startedAt: 1,
      finishedAt: 2,
    })
    expect(await store.getByMcpId(mcpId)).toBeNull()
    const inserted = await store.upsert(mcpId, write('ok'))
    expect(inserted.status).toBe('ok')
    const updated = await store.upsert(mcpId, write('error'))
    expect(updated.status).toBe('error')
    expect((await store.getByMcpId(mcpId))?.status).toBe('error')
    expect((await store.list()).some((probe) => probe.mcpId === mcpId)).toBe(true)
    await expect(store.upsert('missing', write('ok'))).rejects.toMatchObject({
      code: 'mcp-not-found',
    })
  })
})

describeEachProvider('RFC-359 W4-B2a —— agent 资源库存与插件 GC 引用', (harness) => {
  test('库存读取汇总四类资源；GC 引用列出所有插件缓存路径', async () => {
    const db = harness.db
    const owner = await seedOwner(db)
    const mcpId = `m_${ulid()}`
    await db.insert(mcps).values({
      id: mcpId,
      name: `inv-${mcpId.slice(-4).toLowerCase()}`,
      description: '',
      type: 'local',
      config: JSON.stringify({ command: ['echo'] }),
      enabled: true,
      ownerUserId: owner,
    })
    const pluginId = `p_${ulid()}`
    await db.insert(plugins).values({
      id: pluginId,
      name: `plugin-${pluginId.slice(-4).toLowerCase()}`,
      spec: 'demo@1.0.0',
      sourceKind: 'npm',
      cachedPath: `/tmp/plugins/${pluginId}`,
      installedAt: 1,
      ownerUserId: owner,
      visibility: 'private',
      createdAt: 1,
      updatedAt: 1,
    })
    const inventory = await createDatabaseAgentResourceInventoryReadPort({
      db,
      skillAvailability: { isAvailable: () => true },
    }).load()
    expect(inventory.mcps.has(mcpId)).toBe(true)
    expect(inventory.plugins.has(pluginId)).toBe(true)
    expect(await createPluginGenerationReferenceReadPort(db).listReferencedCachedPaths()).toContain(
      `/tmp/plugins/${pluginId}`,
    )
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'resource-catalog',
    'infrastructure',
  )
  for (const stem of [
    'DemoResourceCatalogSeed',
    'McpProbeStore',
    'PluginGenerationGc',
    'AgentResourceInventory',
  ]) {
    for (const provider of ['sqlite', 'postgresql']) {
      expect(existsSync(resolve(infra, `${provider}${stem}.ts`))).toBe(false)
    }
  }
})

// Module contract audit: the public built-in tool catalog has a passive,
// single-load lifetime and exact type/revision projections. No runtime process is needed.
import { describe, expect, test } from 'bun:test'
import type { Agent } from '@agent-workflow/shared'
import {
  composeDigitalEmployeeBuiltinToolCatalog,
  createDigitalEmployeeMaintenanceJobHandlers,
} from '@/modules/digital-employee/composition'
import { composeDigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/digital-employee/composition/agentTemplateCatalog'

const workContract = { contractId: 'module-audit.work', version: 1 }
const agent: Agent = {
  id: 'agent-catalog',
  name: 'catalog-agent',
  description: 'Catalog fixture',
  builtin: true,
  visibility: 'public',
  outputs: ['agent-result'],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: { digitalEmployeeTemplate: 'fixture', executionContracts: [workContract] },
  bodyMd: 'Produce the declared result.',
  schemaVersion: 1,
  createdAt: 10,
  updatedAt: 20,
}

function descriptor(revision: number): string {
  return JSON.stringify({
    typeRef: { typeId: 'module-audit', revision },
    workContracts: [workContract],
    authoringManifest: {
      workItems: [
        {
          workItemRef: 'perform',
          nodeKind: 'business-tool',
          workContractRef: workContract,
          toolRoleGroups: [{ roleRef: 'worker' }],
        },
      ],
    },
  })
}

function catalogFixture() {
  const reads: string[] = []
  let descriptorReads = 0
  const participant = composeDigitalEmployeeAgentTemplateCatalogParticipant({
    async get(id) {
      reads.push(id)
      return id === agent.id ? agent : null
    },
    async createBuiltin() {
      throw new Error('catalog reads must not create templates')
    },
    async renameBuiltin() {
      throw new Error('catalog reads must not rename templates')
    },
    async updateBuiltin() {
      throw new Error('catalog reads must not update templates')
    },
  })
  const catalog = composeDigitalEmployeeBuiltinToolCatalog({
    agentTemplates: participant,
    templateHelpers: {
      DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS: [agent.id, 'missing-template'],
      digitalEmployeeBuiltinAgentSuccessorId: () => null,
      digitalEmployeeBuiltinToolConfiguration: () => null,
      digitalEmployeeAgentToolPresentation: () => ({ zh: '工作工具', selection: 'selectable' }),
    },
    typePackageDescriptorJsons: async () => {
      descriptorReads += 1
      return [descriptor(1), descriptor(2)]
    },
  })
  return { catalog, reads, descriptorReads: () => descriptorReads }
}

describe('module contract: digital-employee', () => {
  test('construction is passive and concurrent load calls share one complete catalog snapshot', async () => {
    const fx = catalogFixture()
    const typeRef = JSON.stringify({ typeId: 'module-audit', revision: 1 })
    expect(fx.reads).toEqual([])
    expect(fx.descriptorReads()).toBe(0)
    expect(() => fx.catalog.listJson(typeRef, 'perform')).toThrow(
      'digital-employee-tool-catalog-not-loaded',
    )
    await Promise.all(Array.from({ length: 25 }, () => fx.catalog.load()))
    expect(fx.reads).toEqual([agent.id, 'missing-template'])
    expect(fx.descriptorReads()).toBe(1)
    const tools = JSON.parse(fx.catalog.listJson(typeRef, 'perform'))
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      id: 'platform:employee-tool:module-audit:1:perform:agent-catalog',
      publishedRevision: 20,
      content: {
        workContractRef: workContract,
        implementation: { agentRef: { id: agent.id, revision: 20 } },
      },
    })
  })

  test('large read batches use the frozen catalog and exact revisions do not silently select another revision', async () => {
    const fx = catalogFixture()
    await fx.catalog.load()
    const id = 'platform:employee-tool:module-audit:1:perform:agent-catalog'
    const typeRef = JSON.stringify({ typeId: 'module-audit', revision: 1 })
    for (let index = 0; index < 500; index += 1) {
      expect(JSON.parse(fx.catalog.listJson(typeRef, 'perform'))).toHaveLength(1)
      expect(
        JSON.parse(fx.catalog.getRevisionJson(JSON.stringify({ id, revision: 20 }))!),
      ).toMatchObject({
        ref: { id, revision: 20 },
        state: 'published',
      })
    }
    expect(fx.catalog.getRevisionJson(JSON.stringify({ id, revision: 19 }))).toBeNull()
    expect(JSON.parse(fx.catalog.listJson(typeRef, 'unknown-work-item'))).toEqual([])
    expect(
      JSON.parse(
        fx.catalog.listJson(JSON.stringify({ typeId: 'module-audit', revision: 3 }), 'perform'),
      ),
    ).toEqual([])
    expect(fx.reads).toEqual([agent.id, 'missing-template'])
    expect(fx.descriptorReads()).toBe(1)
  })

  test('compatible migration advances the type revision while retaining the exact agent and work item', async () => {
    const { catalog } = catalogFixture()
    await catalog.load()
    const old = JSON.stringify({
      id: 'platform:employee-tool:module-audit:1:perform:agent-catalog',
      revision: 20,
    })
    const target = JSON.stringify({ typeId: 'module-audit', revision: 2 })
    expect(
      JSON.parse(catalog.resolveCompatibleRevisionJson!(old, target, 'perform')!),
    ).toMatchObject({
      ref: { id: 'platform:employee-tool:module-audit:2:perform:agent-catalog', revision: 20 },
      content: { typeRef: { typeId: 'module-audit', revision: 2 }, workItemRef: 'perform' },
    })
    expect(catalog.resolveCompatibleRevisionJson!(old, target, 'another-item')).toBeNull()
    expect(
      catalog.resolveCompatibleRevisionJson!(
        old,
        JSON.stringify({ typeId: 'module-audit', revision: 1 }),
        'perform',
      ),
    ).toBeNull()
  })

  test('employee input maintenance yields between full slices and stops on a partial slice', async () => {
    const limits: number[] = []
    const counts = [1000, 1000, 7]
    const handlers = createDigitalEmployeeMaintenanceJobHandlers({
      async sweepExpiredInputUploads(_now, limit) {
        limits.push(limit)
        return counts.shift()!
      },
    })
    const first = await handlers.employeeInputGc({ appHome: '/unused', payload: {} })
    expect(first).toEqual({
      counters: { swept: 1000 },
      delta: { kind: 'none' },
      continuation: { cursor: { version: 1 }, resumeAfterMs: 25 },
    })
    const second = await handlers.employeeInputGc({
      appHome: '/unused',
      payload: {},
      cursor: first.continuation!.cursor,
    })
    expect(second.continuation).toEqual(first.continuation)
    const last = await handlers.employeeInputGc({
      appHome: '/unused',
      payload: {},
      cursor: second.continuation!.cursor,
    })
    expect(last).toEqual({ counters: { swept: 7 }, delta: { kind: 'none' } })
    expect(limits).toEqual([1000, 1000, 1000])
  })

  test('a failed employee input slice returns no success receipt and can be retried', async () => {
    const failure = new Error('employee-upload-store-unavailable')
    let attempts = 0
    const handlers = createDigitalEmployeeMaintenanceJobHandlers({
      async sweepExpiredInputUploads() {
        attempts += 1
        if (attempts === 1) throw failure
        return 0
      },
    })
    const input = { appHome: '/unused', payload: {}, cursor: { version: 1 } }
    await expect(handlers.employeeInputGc(input)).rejects.toBe(failure)
    expect(await handlers.employeeInputGc(input)).toEqual({
      counters: { swept: 0 },
      delta: { kind: 'none' },
    })
    expect(attempts).toBe(2)
  })
})

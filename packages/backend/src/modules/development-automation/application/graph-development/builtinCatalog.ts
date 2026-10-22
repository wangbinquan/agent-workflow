import { canonicalJson, type CreateWorkflow } from '@agent-workflow/shared'
import type { DigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/digital-employee/public/participants'
import type { DigitalEmployeePlatformToolCatalogParticipant } from '@/modules/digital-employee/public/types'
import {
  GRAPH_BUILTIN_AGENTS,
  GRAPH_BUILTIN_IDS,
  GRAPH_BUILTIN_WORKFLOWS,
} from './builtinResources'
import { GRAPH_EMPLOYEE_TYPE } from './employeeType'
import { graphDigest } from '../../domain/graph-development/model'

export interface GraphBuiltinCatalogInput {
  agents: DigitalEmployeeAgentTemplateCatalogParticipant
  workflows: {
    ensure(id: string, definition: CreateWorkflow): Promise<{ id: string; revision: number }>
  }
}

/** Reconciles immutable built-in resource versions once per application lifetime. */
export function createGraphBuiltinCatalog(input: GraphBuiltinCatalogInput) {
  let records:
    | { id: string; revision: number; item: string; implementation: unknown; label: string }[]
    | undefined
  let loading: Promise<void> | undefined
  const prefix = 'platform:graph-development:'
  function current() {
    if (!records) throw new Error('graph-builtins-not-loaded')
    return records
  }
  function record(value: NonNullable<typeof records>[number]) {
    const contractRef = { contractId: `graph-development.${value.item}`, version: 1 }
    const content = {
      schemaVersion: 1,
      typeRef: GRAPH_EMPLOYEE_TYPE,
      workItemRef: value.item,
      workContractRef: contractRef,
      roleRef: 'primary',
      displayName: value.label,
      description: value.label,
      implementation: value.implementation,
      connectionRef: null,
    }
    const receipt = {
      schemaVersion: 1,
      status: 'valid',
      contractRef,
      implementationDigest: graphDigest(value.implementation),
      checks: [
        { code: 'platform-exact-resource', ok: true, detail: canonicalJson(value.implementation) },
      ],
      checkedAt: value.revision,
    }
    return {
      id: value.id,
      typeRef: GRAPH_EMPLOYEE_TYPE,
      workItemRef: value.item,
      content,
      validationReceipt: { ...receipt, receiptDigest: graphDigest(receipt) },
      publishedRevision: value.revision,
      ownerUserId: null,
      createdAt: value.revision,
      updatedAt: value.revision,
      retiredAt: null,
      origin: 'platform',
      selection: 'selectable',
    }
  }
  const catalog: DigitalEmployeePlatformToolCatalogParticipant & { load(): Promise<void> } = {
    load() {
      return (loading ??= (async () => {
        for (const resource of GRAPH_BUILTIN_AGENTS) {
          const existing = await input.agents.get(resource.id)
          if (!existing) await input.agents.createBuiltin(resource.id, resource.definition)
          else if (
            !existing.builtin ||
            existing.name !== resource.definition.name ||
            existing.bodyMd !== resource.definition.bodyMd
          )
            throw new Error(`graph-builtin-agent-content-conflict:${resource.id}`)
        }
        const workflows = []
        for (const resource of GRAPH_BUILTIN_WORKFLOWS) {
          const ref = await input.workflows.ensure(resource.id, resource.definition)
          workflows.push({
            id: `${prefix}${resource.item}`,
            revision: ref.revision,
            item: resource.item,
            implementation: { kind: 'workflow', workflowRef: ref },
            label: resource.item === 'review-design' ? '审核冻结实现依据' : '自适应设计与澄清',
          })
        }
        const agent = await input.agents.get(GRAPH_BUILTIN_IDS.implementer)
        if (!agent) throw new Error('graph-builtin-implementer-missing')
        records = [
          ...workflows,
          {
            id: `${prefix}implement-change`,
            revision: agent.updatedAt,
            item: 'implement-change',
            implementation: {
              kind: 'agent',
              agentRef: { id: agent.id, revision: agent.updatedAt },
            },
            label: '根据批准依据生成代码与测试',
          },
        ]
      })())
    },
    listJson(refJson, item) {
      const ref = JSON.parse(refJson) as { typeId: string; revision: number }
      return canonicalJson(
        ref.typeId === GRAPH_EMPLOYEE_TYPE.typeId && ref.revision === 1
          ? current()
              .filter((value) => value.item === item)
              .map(record)
          : [],
      )
    },
    getRevisionJson(refJson) {
      const ref = JSON.parse(refJson) as { id: string; revision: number }
      const value = current().find(
        (value) => value.id === ref.id && value.revision === ref.revision,
      )
      if (!value) return null
      const full = record(value)
      return canonicalJson({
        ref,
        content: full.content,
        contentDigest: graphDigest(full.content),
        validationReceipt: full.validationReceipt,
        state: 'published',
        publishedAt: value.revision,
        publishedBy: null,
      })
    },
    isPlatformTool: (id) => id.startsWith(prefix),
    resolveCompatibleRevisionJson() {
      return null
    },
  }
  return Object.freeze(catalog)
}

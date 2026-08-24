import { canonicalJson } from '@agent-workflow/shared'
import { z } from 'zod'

import type { DbClient } from '@/db/client'
import { employeeTypePackages } from '@/db/schema'
import {
  normalizeDispatchRouteDefinitionsJson,
  type DigitalEmployeePlatformToolCatalogParticipant,
} from '@/modules/digital-employee/public/types'
import { sha256Hex } from '@/util/hash'
import { getAgentByIdSync } from '@/services/agent'
import {
  DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS,
  digitalEmployeeBuiltinAgentSuccessorId,
  digitalEmployeeBuiltinToolConfiguration,
  digitalEmployeeAgentToolPresentation,
} from '@/services/digitalEmployeeAgentTemplates'

const descriptorSchema = z
  .object({
    typeRef: z.object({ typeId: z.string(), revision: z.number().int().positive() }).strict(),
    workContracts: z.array(
      z.object({ contractId: z.string(), version: z.number().int().positive() }).passthrough(),
    ),
    authoringManifest: z
      .object({
        workItems: z.array(
          z
            .object({
              workItemRef: z.string(),
              nodeKind: z.enum(['business-tool', 'system', 'collaboration']),
              workContractRef: z
                .object({ contractId: z.string(), version: z.number().int().positive() })
                .strict(),
              humanReview: z
                .object({ artifactPort: z.string(), planningRoleRef: z.string() })
                .passthrough()
                .nullable()
                .optional(),
              orderedDispatchAuthoring: z
                .object({ destinationWorkItemRefs: z.array(z.string()) })
                .passthrough()
                .nullable()
                .optional(),
              toolRoleGroups: z.array(
                z
                  .object({
                    roleRef: z.string(),
                    workContractRef: z
                      .object({ contractId: z.string(), version: z.number().int().positive() })
                      .strict()
                      .optional(),
                  })
                  .passthrough(),
              ),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough()

const typeRefSchema = z
  .object({ typeId: z.string(), revision: z.number().int().positive() })
  .strict()
const exactRefSchema = z.object({ id: z.string(), revision: z.number().int().positive() }).strict()
function digest(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

function declaredContracts(value: unknown): readonly { contractId: string; version: number }[] {
  return z
    .array(z.object({ contractId: z.string(), version: z.number().int().positive() }).passthrough())
    .catch([])
    .parse(value)
}

function declaredDispatchRoutes(value: unknown) {
  const inputJson = JSON.stringify(value)
  if (inputJson === undefined) return undefined
  const normalizedJson = normalizeDispatchRouteDefinitionsJson(inputJson)
  return normalizedJson === null
    ? undefined
    : (JSON.parse(normalizedJson) as Array<{
        routeRef: string
        displayName: string
        description: string
        fallback: boolean
      }>)
}

export function composeDigitalEmployeeBuiltinToolCatalog(input: {
  readonly db: DbClient
  readonly typePackageDescriptorJsons: readonly string[]
}): DigitalEmployeePlatformToolCatalogParticipant {
  const descriptorsByTypeRef = new Map<string, z.infer<typeof descriptorSchema>>()
  const persistedDescriptorJsons = input.db
    .select({ descriptorJson: employeeTypePackages.descriptorJson })
    .from(employeeTypePackages)
    .all()
    .map((row) => row.descriptorJson)
  for (const value of [...persistedDescriptorJsons, ...input.typePackageDescriptorJsons]) {
    const descriptor = descriptorSchema.parse(JSON.parse(value) as unknown)
    descriptorsByTypeRef.set(
      `${descriptor.typeRef.typeId}@${descriptor.typeRef.revision}`,
      descriptor,
    )
  }
  const descriptors = [...descriptorsByTypeRef.values()]
  const builtinAgents = DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS.map((agentId) => ({
    agentId,
    agent: getAgentByIdSync(input.db, agentId),
  }))
  const prefix = 'platform:employee-tool:'
  const parseIdentity = (toolId: string) => {
    if (!toolId.startsWith(prefix)) return null
    const [typeId, revisionText, workItemRef, ...agentParts] = toolId
      .slice(prefix.length)
      .split(':')
    const revision = Number(revisionText)
    const agentId = agentParts.reduce(
      (value, part) => (value === '' ? part : `${value}:${part}`),
      '',
    )
    if (
      typeId === undefined ||
      workItemRef === undefined ||
      agentId === '' ||
      !Number.isInteger(revision) ||
      revision <= 0
    ) {
      return null
    }
    return { typeId, revision, workItemRef, agentId }
  }

  // Type descriptors and code-owned builtin Agent revisions are reconciled
  // before this process-lifetime participant is composed. Project the catalog
  // once: automatic upgrade may call list/get/resolve thousands of times while
  // scanning historical closures, and rebuilding it would otherwise execute
  // one SQLite SELECT per Agent for every call.
  const records = descriptors.flatMap((descriptor) =>
    descriptor.authoringManifest.workItems.flatMap((item) => {
      if (item.nodeKind !== 'business-tool') return []
      const dispatchSources = descriptor.authoringManifest.workItems.filter((source) =>
        source.orderedDispatchAuthoring?.destinationWorkItemRefs.includes(item.workItemRef),
      )
      return item.toolRoleGroups.flatMap((role) => {
        const workContractRef = role.workContractRef ?? item.workContractRef
        const contract = descriptor.workContracts.find(
          (candidate) =>
            candidate.contractId === workContractRef.contractId &&
            candidate.version === workContractRef.version,
        )
        if (contract === undefined) return []
        const expectedOutputPort =
          item.humanReview?.planningRoleRef === role.roleRef
            ? item.humanReview.artifactPort
            : 'agent-result'
        return builtinAgents.flatMap(({ agentId, agent }) => {
          if (agent === null || agent.builtin !== true || agent.visibility !== 'public') return []
          const template = agent.frontmatterExtra.digitalEmployeeTemplate
          if (typeof template !== 'string') return []
          const builtinConfiguration = digitalEmployeeBuiltinToolConfiguration(agentId)
          const dispatchRouteDefinitions = declaredDispatchRoutes(
            agent.frontmatterExtra.dispatchRouteDefinitions ??
              builtinConfiguration?.dispatchRouteDefinitions,
          )
          if (item.orderedDispatchAuthoring != null && dispatchRouteDefinitions === undefined) {
            return []
          }
          const presentation = digitalEmployeeAgentToolPresentation(template)
          if (presentation === null) return []
          const selection = presentation.selection
          const declared = declaredContracts(agent.frontmatterExtra.executionContracts)
          const compatible = declared.some(
            (candidate) =>
              candidate.contractId === workContractRef.contractId &&
              candidate.version === workContractRef.version,
          )
          if (!compatible || !agent.outputs.includes(expectedOutputPort)) return []
          const implementation = {
            kind: 'agent' as const,
            agentRef: { id: agent.id, revision: agent.updatedAt },
          }
          const checks = [
            {
              code: 'platform-agent-exact-revision',
              ok: true,
              detail: `${agent.id}@${agent.updatedAt}`,
            },
            {
              code: 'platform-agent-contract',
              ok: true,
              detail: `${agent.name} declares ${contract.contractId}@${contract.version} and publishes ${expectedOutputPort}`,
            },
          ]
          const receiptCore = {
            schemaVersion: 1 as const,
            status: 'valid' as const,
            contractRef: workContractRef,
            implementationDigest: digest(implementation),
            checks,
            checkedAt: agent.updatedAt,
          }
          const content = {
            schemaVersion: 1 as const,
            typeRef: descriptor.typeRef,
            workItemRef: item.workItemRef,
            workContractRef,
            roleRef: role.roleRef,
            displayName: presentation.zh,
            description: agent.description,
            implementation,
            connectionRef: null,
            ...(item.orderedDispatchAuthoring == null
              ? {}
              : { dispatchRouteDefinitions: dispatchRouteDefinitions! }),
            ...(dispatchSources.length === 0
              ? {}
              : {
                  acceptedDispatchRoutes: dispatchSources.map((source) => ({
                    classifierWorkItemRef: source.workItemRef,
                    routeRefs: ['*'],
                  })),
                }),
          }
          const id = `${prefix}${descriptor.typeRef.typeId}:${descriptor.typeRef.revision}:${item.workItemRef}:${agent.id}`
          return [
            {
              id,
              typeRef: descriptor.typeRef,
              workItemRef: item.workItemRef,
              content,
              validationReceipt: { ...receiptCore, receiptDigest: digest(receiptCore) },
              publishedRevision: agent.updatedAt,
              ownerUserId: agent.ownerUserId,
              createdAt: agent.createdAt,
              updatedAt: agent.updatedAt,
              retiredAt: null,
              origin: 'platform' as const,
              selection,
            },
          ]
        })
      })
    }),
  )

  return {
    listJson(typeRefJson, workItemRef) {
      const typeRef = typeRefSchema.parse(JSON.parse(typeRefJson) as unknown)
      return JSON.stringify(
        records.filter(
          (record) =>
            record.typeRef.typeId === typeRef.typeId &&
            record.typeRef.revision === typeRef.revision &&
            record.workItemRef === workItemRef,
        ),
      )
    },
    getRevisionJson(refJson) {
      const ref = exactRefSchema.parse(JSON.parse(refJson) as unknown)
      const record = records.find(
        (candidate) =>
          candidate.id === ref.id &&
          candidate.publishedRevision === ref.revision &&
          candidate.selection === 'selectable',
      )
      if (record === undefined) return null
      return JSON.stringify({
        ref,
        content: record.content,
        contentDigest: digest(record.content),
        validationReceipt: record.validationReceipt,
        state: 'published',
        publishedAt: record.updatedAt,
        publishedBy: record.ownerUserId,
      })
    },
    resolveCompatibleRevisionJson(sourceRefJson, targetTypeRefJson, workItemRef) {
      const sourceRef = exactRefSchema.parse(JSON.parse(sourceRefJson) as unknown)
      const targetTypeRef = typeRefSchema.parse(JSON.parse(targetTypeRefJson) as unknown)
      const identity = parseIdentity(sourceRef.id)
      if (
        identity === null ||
        identity.typeId !== targetTypeRef.typeId ||
        identity.revision >= targetTypeRef.revision ||
        identity.workItemRef !== workItemRef
      ) {
        return null
      }
      const record = records.find(
        (candidate) =>
          candidate.typeRef.typeId === targetTypeRef.typeId &&
          candidate.typeRef.revision === targetTypeRef.revision &&
          candidate.workItemRef === workItemRef &&
          candidate.selection === 'selectable' &&
          candidate.content.implementation.kind === 'agent' &&
          [identity.agentId, digitalEmployeeBuiltinAgentSuccessorId(identity.agentId)].includes(
            candidate.content.implementation.agentRef.id,
          ),
      )
      if (record === undefined || record.publishedRevision === null) return null
      const ref = { id: record.id, revision: record.publishedRevision }
      return JSON.stringify({
        ref,
        content: record.content,
        contentDigest: digest(record.content),
        validationReceipt: record.validationReceipt,
        state: 'published',
        publishedAt: record.updatedAt,
        publishedBy: record.ownerUserId,
      })
    },
    isPlatformTool: (toolId) => toolId.startsWith(prefix),
  }
}

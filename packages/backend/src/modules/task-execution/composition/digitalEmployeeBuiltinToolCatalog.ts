import { canonicalJson } from '@agent-workflow/shared'
import { z } from 'zod'

import type { DbClient } from '@/db/client'
import {
  normalizeDispatchRouteDefinitionsJson,
  type DigitalEmployeePlatformToolCatalogParticipant,
} from '@/modules/digital-employee/public/types'
import { sha256Hex } from '@/util/hash'
import { getAgentByIdSync } from '@/services/agent'
import {
  DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS,
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
                .object({ artifactPort: z.string() })
                .passthrough()
                .nullable()
                .optional(),
              orderedDispatchAuthoring: z
                .object({ destinationWorkItemRefs: z.array(z.string()) })
                .passthrough()
                .nullable()
                .optional(),
              toolRoleGroups: z.array(z.object({ roleRef: z.string() }).passthrough()),
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
    .array(z.object({ contractId: z.string(), version: z.number().int().positive() }).strict())
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
  const descriptors = input.typePackageDescriptorJsons.map((value) =>
    descriptorSchema.parse(JSON.parse(value) as unknown),
  )
  const prefix = 'platform:employee-tool:'

  const records = () =>
    descriptors.flatMap((descriptor) =>
      descriptor.authoringManifest.workItems.flatMap((item) => {
        if (item.nodeKind !== 'business-tool') return []
        const roleRef = item.toolRoleGroups[0]?.roleRef
        const dispatchSources = descriptor.authoringManifest.workItems.filter((source) =>
          source.orderedDispatchAuthoring?.destinationWorkItemRefs.includes(item.workItemRef),
        )
        const contract = descriptor.workContracts.find(
          (candidate) =>
            candidate.contractId === item.workContractRef.contractId &&
            candidate.version === item.workContractRef.version,
        )
        if (roleRef === undefined || contract === undefined) return []
        return DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS.flatMap((agentId) => {
          const agent = getAgentByIdSync(input.db, agentId)
          if (agent === null || agent.builtin !== true || agent.visibility !== 'public') return []
          const template = agent.frontmatterExtra.digitalEmployeeTemplate
          if (typeof template !== 'string') return []
          const dispatchRouteDefinitions = declaredDispatchRoutes(
            agent.frontmatterExtra.dispatchRouteDefinitions,
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
              candidate.contractId === item.workContractRef.contractId &&
              candidate.version === item.workContractRef.version,
          )
          const automatic =
            selection === 'automatic' &&
            item.humanReview?.artifactPort !== undefined &&
            agent.outputs.includes(item.humanReview.artifactPort)
          if (!compatible && !automatic) return []
          if (selection === 'selectable' && !agent.outputs.includes('agent-result')) return []
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
              code: automatic ? 'platform-agent-review-artifact' : 'platform-agent-contract',
              ok: true,
              detail: automatic
                ? `${agent.name} publishes ${item.humanReview!.artifactPort}`
                : `${agent.name} declares ${contract.contractId}@${contract.version}`,
            },
          ]
          const receiptCore = {
            schemaVersion: 1 as const,
            status: 'valid' as const,
            contractRef: item.workContractRef,
            implementationDigest: digest(implementation),
            checks,
            checkedAt: agent.updatedAt,
          }
          const content = {
            schemaVersion: 1 as const,
            typeRef: descriptor.typeRef,
            workItemRef: item.workItemRef,
            workContractRef: item.workContractRef,
            roleRef,
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
      }),
    )

  return {
    listJson(typeRefJson, workItemRef) {
      const typeRef = typeRefSchema.parse(JSON.parse(typeRefJson) as unknown)
      return JSON.stringify(
        records().filter(
          (record) =>
            record.typeRef.typeId === typeRef.typeId &&
            record.typeRef.revision === typeRef.revision &&
            record.workItemRef === workItemRef,
        ),
      )
    },
    getRevisionJson(refJson) {
      const ref = exactRefSchema.parse(JSON.parse(refJson) as unknown)
      const record = records().find(
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
    isPlatformTool: (toolId) => toolId.startsWith(prefix),
  }
}

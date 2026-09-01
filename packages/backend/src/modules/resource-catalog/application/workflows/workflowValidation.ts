import {
  collectWorkflowCallRefs,
  collectWorkgroupCallRefs,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'
import type { WorkflowValidationQueries } from '../../public/queries'
import type {
  ValidateStoredWorkflowCatalogInput,
  ValidateWorkflowDraftCatalogInput,
} from '../../public/types'
import type { WorkflowOperationContext } from '../../public/participants'
import type {
  WorkflowReferenceAdmissionGroup,
  WorkflowReferenceAdmissionPort,
  WorkflowValidationPort,
} from './ports'

export interface WorkflowValidationApplicationDependencies {
  readonly validation: WorkflowValidationPort
  readonly admission: WorkflowReferenceAdmissionPort
}

function agentReferences(definition: WorkflowDefinition): ReadonlySet<string> {
  const references = new Set<string>()
  for (const node of definition.nodes ?? []) {
    if (node.kind !== 'agent-single' || !('agentId' in node)) continue
    if (typeof node.agentId === 'string' && node.agentId.length > 0) {
      references.add(node.agentId)
    }
  }
  return references
}

function workflowReferences(definition: WorkflowDefinition): ReadonlySet<string> {
  return new Set(collectWorkflowCallRefs(definition).map((reference) => reference.workflowName))
}

function workgroupReferences(definition: WorkflowDefinition): ReadonlySet<string> {
  return new Set(collectWorkgroupCallRefs(definition).map((reference) => reference.workgroupName))
}

function added(previous: ReadonlySet<string>, next: ReadonlySet<string>): readonly string[] {
  return [...next].filter((reference) => !previous.has(reference))
}

function referenceGroups(
  previous: WorkflowDefinition,
  next: WorkflowDefinition,
): readonly WorkflowReferenceAdmissionGroup[] {
  return Object.freeze([
    Object.freeze({
      resourceType: 'agent' as const,
      references: Object.freeze(added(agentReferences(previous), agentReferences(next))),
      domain: 'id' as const,
    }),
    Object.freeze({
      resourceType: 'workflow' as const,
      references: Object.freeze(added(workflowReferences(previous), workflowReferences(next))),
      domain: 'name' as const,
    }),
    Object.freeze({
      resourceType: 'workgroup' as const,
      references: Object.freeze(added(workgroupReferences(previous), workgroupReferences(next))),
      domain: 'name' as const,
    }),
  ])
}

export function createWorkflowValidationApplication(
  dependencies: WorkflowValidationApplicationDependencies,
): WorkflowValidationQueries {
  const queries: WorkflowValidationQueries = {
    async validateStored(
      _authority: WorkflowOperationContext,
      input: ValidateStoredWorkflowCatalogInput,
    ) {
      const validated = await dependencies.validation.validate({
        definition: input.workflow.definition,
        currentWorkflow: { id: input.workflow.id, name: input.workflow.name },
      })
      return Object.freeze({
        validationContextHash: validated.validationContextHash,
        ok: validated.result.ok,
        issues: Object.freeze([...validated.result.issues]),
      })
    },

    async validateDraft(
      authority: WorkflowOperationContext,
      input: ValidateWorkflowDraftCatalogInput,
    ) {
      const candidateHash = dependencies.validation.candidateHash(input.definition)
      if (candidateHash !== input.claimedCandidateHash) {
        throw new ValidationError(
          'workflow-candidate-hash-mismatch',
          'workflow candidate does not match the claimed hash',
          { claimed: input.claimedCandidateHash, actual: candidateHash },
        )
      }
      await dependencies.admission.assertUsable(
        authority,
        referenceGroups(input.workflow.definition, input.definition),
      )
      const validated = await dependencies.validation.validate({
        definition: input.definition,
        currentWorkflow: { id: input.workflow.id, name: input.workflow.name },
      })
      return Object.freeze({
        candidateHash,
        validationContextHash: validated.validationContextHash,
        ok: validated.result.ok,
        issues: Object.freeze([...validated.result.issues]),
      })
    },
  }
  return Object.freeze(queries)
}

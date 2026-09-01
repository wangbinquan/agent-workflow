import type { DbClient } from '@/db/client'
import type {
  WorkflowReferenceAdmissionPort,
  WorkflowValidationPort,
} from '../application/workflows/ports'
import {
  loadWorkflowValidationContext,
  validateWorkflowDefinition,
  workflowDefinitionCandidateHashOf,
  workflowValidationContextHashOf,
} from './legacy/workflow.validator'
import { assertNewRefsUsable } from './legacy/resourceRefs'

export function createSqliteWorkflowValidationPort(db: DbClient): WorkflowValidationPort {
  const port: WorkflowValidationPort = {
    candidateHash: workflowDefinitionCandidateHashOf,
    async validate(candidate) {
      const context = await loadWorkflowValidationContext(db, candidate)
      return Object.freeze({
        validationContextHash: workflowValidationContextHashOf(context),
        result: validateWorkflowDefinition(candidate.definition, context),
      })
    },
  }
  return Object.freeze(port)
}

export function createSqliteWorkflowReferenceAdmissionPort(
  db: DbClient,
): WorkflowReferenceAdmissionPort {
  const port: WorkflowReferenceAdmissionPort = {
    assertUsable: (authority, groups) =>
      assertNewRefsUsable(
        db,
        authority,
        groups.map((group) => ({
          type: group.resourceType,
          names: group.references,
          domain: group.domain,
        })),
      ),
  }
  return Object.freeze(port)
}

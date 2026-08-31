// RFC-349 — PostgreSQL implementation of the admission-time configuration
// lookup. The application sees only the existing Promise port; provider rows
// and Drizzle handles remain inside development-automation infrastructure.

import { and, eq, isNull } from 'drizzle-orm'

import {
  automationPolicyRevisions,
  digitalEmployeeRevisions,
  repositoryEmployeeAssignments,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { AdmissionAssignmentView, AdmissionLookup } from '../application/ports/admissionLookup'

const assignmentFields = {
  scopeKind: repositoryEmployeeAssignments.scopeKind,
  employeeId: repositoryEmployeeAssignments.employeeId,
  employeeRevision: repositoryEmployeeAssignments.employeeRevision,
  selectionPolicyId: repositoryEmployeeAssignments.selectionPolicyId,
  selectionPolicyRevision: repositoryEmployeeAssignments.selectionPolicyRevision,
  executionPolicyId: repositoryEmployeeAssignments.executionPolicyId,
  executionPolicyRevision: repositoryEmployeeAssignments.executionPolicyRevision,
  defaultRequirementSourceKey: repositoryEmployeeAssignments.defaultRequirementSourceKey,
}

async function findAssignment(
  db: PostgresqlDatabaseClient,
  scopeKind: AdmissionAssignmentView['scopeKind'],
  scopeRef: string | null,
): Promise<AdmissionAssignmentView | null> {
  const row = await db
    .select(assignmentFields)
    .from(repositoryEmployeeAssignments)
    .where(
      and(
        eq(repositoryEmployeeAssignments.scopeKind, scopeKind),
        scopeRef === null
          ? isNull(repositoryEmployeeAssignments.scopeRef)
          : eq(repositoryEmployeeAssignments.scopeRef, scopeRef),
      ),
    )
    .limit(1)
    .get()
  return row ?? null
}

async function revisionContent(
  query: PromiseLike<{ readonly contentJson: string } | undefined>,
): Promise<unknown | null> {
  const row = await query
  return row === undefined ? null : (JSON.parse(row.contentJson) as unknown)
}

export function createPostgresqlAdmissionLookup(db: PostgresqlDatabaseClient): AdmissionLookup {
  return {
    async resolveAssignment(scope) {
      const repository = await findAssignment(db, 'repository', scope.repositoryId)
      if (repository !== null) return repository
      if (scope.repositoryGroupId !== null) {
        const group = await findAssignment(db, 'repository-group', scope.repositoryGroupId)
        if (group !== null) return group
      }
      return await findAssignment(db, 'global-default', null)
    },
    async getEmployeeRevisionContent(id, revision) {
      return await revisionContent(
        db
          .select({ contentJson: digitalEmployeeRevisions.contentJson })
          .from(digitalEmployeeRevisions)
          .where(
            and(
              eq(digitalEmployeeRevisions.employeeId, id),
              eq(digitalEmployeeRevisions.revision, revision),
            ),
          )
          .limit(1)
          .get(),
      )
    },
    async getPolicyRevisionContent(id, revision) {
      return await revisionContent(
        db
          .select({ contentJson: automationPolicyRevisions.contentJson })
          .from(automationPolicyRevisions)
          .where(
            and(
              eq(automationPolicyRevisions.policyId, id),
              eq(automationPolicyRevisions.revision, revision),
            ),
          )
          .limit(1)
          .get(),
      )
    },
  }
}

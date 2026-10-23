// RFC-395 II-a: all SQL catalog readers exclude the same reserved definition anchors.
import { and, notInArray, type SQL, type SQLWrapper } from 'drizzle-orm'
import { TASK_DEFINITION_HOST_IDS } from '@agent-workflow/shared'

export function workflowCatalogPredicate(id: SQLWrapper, predicate?: SQL): SQL {
  return and(notInArray(id, [...TASK_DEFINITION_HOST_IDS]), predicate)!
}

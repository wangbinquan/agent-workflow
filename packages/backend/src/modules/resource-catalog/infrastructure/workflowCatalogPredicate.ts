import type { SQL, SQLWrapper } from 'drizzle-orm'
import { isTaskDefinitionHostId } from '@agent-workflow/shared'
import { workflowCatalogPredicate } from '@/platform/persistence/workflowCatalogPredicate'
import { ForbiddenError } from '@/util/errors'

export { workflowCatalogPredicate }

/** The four definition anchors remain reserved even when no catalog row exists. */
export function assertWorkflowCatalogIdWritable(id: string | null): void {
  if (id !== null && isTaskDefinitionHostId(id)) {
    throw new ForbiddenError('builtin-readonly', `built-in workflow '${id}' is read-only`)
  }
}

/** 通用目录读同样排除历史宿主行；其他资源的原查询条件保持不变。 */
export function catalogResourcePredicate(
  kind: string,
  id: SQLWrapper,
  predicate?: SQL,
): SQL | undefined {
  return kind === 'workflow' ? workflowCatalogPredicate(id, predicate) : predicate
}

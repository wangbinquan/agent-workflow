import type { DbClient } from '@/db/client'
import {
  copyWorkflow,
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  getWorkflowAclRow,
  listWorkflows,
  updateWorkflow,
} from '@/modules/resource-catalog/infrastructure/legacy/workflow'
import type { WorkflowRepository } from '../application/workflows/ports'

/**
 * SQLite explicit compatibility island for the Workflow vertical slice.
 *
 * Active transports consume module-owned handles. The mature exact-revision,
 * reference-fence, script-author and websocket funnels stay behind this port
 * until T9 can move them without weakening their transaction protocol.
 */
export function createSqliteWorkflowRepository(db: DbClient): WorkflowRepository {
  return Object.freeze({
    list: () => listWorkflows(db),
    get: (id) => getWorkflow(db, id),
    async getAclIdentity(id) {
      const row = await getWorkflowAclRow(db, id)
      return row === null ? null : Object.freeze({ ...row })
    },
    create: (authority, input) =>
      createWorkflow(db, input, {
        ownerUserId: authority.user.id,
        actor: authority,
      }),
    copy: (authority, id, input) => copyWorkflow(db, id, input, authority),
    update: (authority, id, input) =>
      updateWorkflow(db, id, input, { kind: 'actor', actor: authority }),
    delete: (authority, id, input) =>
      deleteWorkflow(db, id, input, { kind: 'actor', actor: authority }),
  } satisfies WorkflowRepository)
}

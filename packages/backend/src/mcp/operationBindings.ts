// RFC-344 — the MCP adapter's closed operation dependency table.
//
// Tool handlers import stable operation refs from here. URL templates and HTTP
// verbs live only in this binding projection; handlers invoke operation ids and
// supply typed path/query/body values.

import {
  declareHttpOperation,
  operationId,
  type DeclaredHttpOperation,
} from '@/platform/operations/catalog'
import type { McpOperationBinding, OperationId } from '@/platform/operations/contracts'

export type McpHttpOperation = DeclaredHttpOperation

const query = (id: string, path: string): DeclaredHttpOperation =>
  declareHttpOperation({ id, method: 'GET', path, kind: 'query' })
const command = (
  id: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
): DeclaredHttpOperation => declareHttpOperation({ id, method, path, kind: 'command' })
const descriptorQuery = (id: string, path: string): DeclaredHttpOperation =>
  declareHttpOperation({ id, method: 'GET', path, kind: 'query', implementation: 'descriptor' })
const descriptorCommand = (
  id: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
): DeclaredHttpOperation =>
  declareHttpOperation({ id, method, path, kind: 'command', implementation: 'descriptor' })

export const MCP_OPERATIONS = Object.freeze({
  workflowGet: descriptorQuery('workflow-catalog.get-workflow.v1', '/api/workflows/:id'),
  taskLaunch: command('task-execution.launch-task.v1', 'POST', '/api/tasks'),
  cachedReposList: query('source-control.list-cached-repos.v1', '/api/cached-repos'),
  repoRefsList: query('source-control.list-repo-refs.v1', '/api/repos/refs'),
  taskGet: query('task-execution.get-task.v1', '/api/tasks/:id'),
  taskList: query('task-execution.list-tasks.v1', '/api/tasks'),
  taskDiffGet: query('task-execution.get-task-diff.v1', '/api/tasks/:id/diff'),
  taskNodeRunsList: query('task-execution.list-node-runs.v1', '/api/tasks/:id/node-runs'),
  taskCancel: command('task-execution.cancel-task.v1', 'POST', '/api/tasks/:id/cancel'),
  taskRetryNode: command(
    'task-execution.retry-node.v1',
    'POST',
    '/api/tasks/:id/nodes/:nodeRunId/retry',
  ),
  taskResume: command('task-execution.resume-task.v1', 'POST', '/api/tasks/:id/resume'),
  taskDiagnose: command('task-execution.diagnose-task.v1', 'POST', '/api/tasks/:id/diagnose'),
  taskAlertsList: query('task-execution.list-task-alerts.v1', '/api/tasks/:id/alerts'),
  taskAlertRepair: command(
    'task-execution.repair-task-alert.v1',
    'POST',
    '/api/tasks/:id/alerts/:alertId/repair',
  ),
  taskAlertRepairOptionsList: query(
    'task-execution.list-alert-repair-options.v1',
    '/api/tasks/:id/alerts/:alertId/repair-options',
  ),
  taskDelete: command('task-execution.delete-task.v1', 'DELETE', '/api/tasks/:id'),

  reviewsList: query('collaboration.list-reviews.v1', '/api/reviews'),
  clarifyList: query('collaboration.list-clarify-rounds.v1', '/api/clarify'),
  workgroupPendingList: query(
    'collaboration.list-pending-workgroups.v1',
    '/api/workgroup-tasks/pending',
  ),
  fusionsList: query('collaboration.list-fusions.v1', '/api/fusions'),
  clarifyGet: query('collaboration.get-clarify-round.v1', '/api/clarify/:nodeRunId'),
  clarifyAnswer: command(
    'collaboration.answer-clarify-round.v1',
    'POST',
    '/api/clarify/:nodeRunId/answers',
  ),
  taskQuestionsList: query('collaboration.list-task-questions.v1', '/api/tasks/:id/questions'),
  taskQuestionRaise: command(
    'collaboration.raise-task-question.v1',
    'POST',
    '/api/tasks/:id/questions/manual',
  ),
  taskQuestionConfirm: command(
    'collaboration.confirm-task-question.v1',
    'POST',
    '/api/tasks/:id/questions/:entryId/confirm',
  ),
  taskQuestionReassign: command(
    'collaboration.reassign-task-question.v1',
    'POST',
    '/api/tasks/:id/questions/:entryId/reassign',
  ),
  taskQuestionStage: command(
    'collaboration.stage-task-question.v1',
    'POST',
    '/api/tasks/:id/questions/:entryId/stage',
  ),
  taskQuestionsDispatch: command(
    'collaboration.dispatch-task-questions.v1',
    'POST',
    '/api/tasks/:id/questions/dispatch',
  ),
  clarifyDirectivesList: query(
    'collaboration.list-clarify-directives.v1',
    '/api/tasks/:id/clarify-directives',
  ),
  clarifyDirectiveSet: command(
    'collaboration.set-clarify-directive.v1',
    'POST',
    '/api/tasks/:id/nodes/:nodeId/clarify-directive',
  ),
  clarifyDraftSave: command(
    'collaboration.save-clarify-draft.v1',
    'PUT',
    '/api/clarify/:nodeRunId/draft',
  ),
  workgroupRoomGet: query(
    'collaboration.get-workgroup-room.v1',
    '/api/workgroup-tasks/:taskId/room',
  ),
  workgroupMessagePost: command(
    'collaboration.post-workgroup-message.v1',
    'POST',
    '/api/workgroup-tasks/:taskId/messages',
  ),
  workgroupStepConfirm: command(
    'collaboration.confirm-workgroup-step.v1',
    'POST',
    '/api/workgroup-tasks/:taskId/confirm',
  ),
  workgroupDynamicWorkflowConfirm: command(
    'collaboration.confirm-dynamic-workflow.v1',
    'POST',
    '/api/workgroup-tasks/:taskId/dw-confirm',
  ),
  workgroupDynamicWorkflowSave: command(
    'collaboration.save-dynamic-workflow.v1',
    'POST',
    '/api/workgroup-tasks/:taskId/dw-save-as-workflow',
  ),
  workgroupAssignmentDeliver: command(
    'collaboration.deliver-workgroup-assignment.v1',
    'POST',
    '/api/workgroup-tasks/:taskId/assignments/:id/deliver',
  ),
  workgroupAssignmentCancel: command(
    'collaboration.cancel-workgroup-assignment.v1',
    'POST',
    '/api/workgroup-tasks/:taskId/assignments/:id/cancel',
  ),
  fusionGet: query('collaboration.get-fusion.v1', '/api/fusions/:id'),
  fusionApprove: command('collaboration.approve-fusion.v1', 'POST', '/api/fusions/:id/approve'),
  fusionReject: command('collaboration.reject-fusion.v1', 'POST', '/api/fusions/:id/reject'),
  fusionCancel: command('collaboration.cancel-fusion.v1', 'POST', '/api/fusions/:id/cancel'),
  reviewGet: query('collaboration.get-review.v1', '/api/reviews/:nodeRunId'),
  reviewDocumentGet: query(
    'collaboration.get-review-document.v1',
    '/api/reviews/:nodeRunId/versions/:versionId',
  ),
  reviewVersionsList: query(
    'collaboration.list-review-versions.v1',
    '/api/reviews/:nodeRunId/versions',
  ),
  reviewRoundsList: query('collaboration.list-review-rounds.v1', '/api/reviews/:nodeRunId/rounds'),
  reviewCommentAdd: command(
    'collaboration.add-review-comment.v1',
    'POST',
    '/api/reviews/:nodeRunId/comments',
  ),
  reviewCommentUpdate: command(
    'collaboration.update-review-comment.v1',
    'PATCH',
    '/api/reviews/:nodeRunId/comments/:commentId',
  ),
  reviewCommentDelete: command(
    'collaboration.delete-review-comment.v1',
    'DELETE',
    '/api/reviews/:nodeRunId/comments/:commentId',
  ),
  reviewSelectionSet: command(
    'collaboration.set-review-selection.v1',
    'PATCH',
    '/api/reviews/:nodeRunId/documents/:docVersionId/selection',
  ),
  reviewSubmit: command(
    'collaboration.submit-review.v1',
    'POST',
    '/api/reviews/:nodeRunId/decision',
  ),
})

export const RESOURCE_OPERATIONS = Object.freeze({
  agents: Object.freeze({
    list: descriptorQuery('agent-catalog.list-agents.v1', '/api/agents'),
    get: descriptorQuery('agent-catalog.get-agent.v1', '/api/agents/:id'),
    create: descriptorCommand('agent-catalog.create-agent.v1', 'POST', '/api/agents'),
    update: descriptorCommand('agent-catalog.update-agent.v1', 'PUT', '/api/agents/:id'),
    delete: descriptorCommand('agent-catalog.delete-agent.v1', 'DELETE', '/api/agents/:id'),
  }),
  skills: Object.freeze({
    list: descriptorQuery('skill-catalog.list-skills.v1', '/api/skills'),
    get: descriptorQuery('skill-catalog.get-skill.v1', '/api/skills/:id'),
    create: descriptorCommand('skill-catalog.create-skill.v1', 'POST', '/api/skills'),
    update: descriptorCommand('skill-catalog.save-skill.v1', 'POST', '/api/skills/:id/save'),
    delete: descriptorCommand('skill-catalog.delete-skill.v1', 'DELETE', '/api/skills/:id'),
  }),
  mcps: Object.freeze({
    list: descriptorQuery('mcp-catalog.list-mcps.v1', '/api/mcps'),
    get: descriptorQuery('mcp-catalog.get-mcp.v1', '/api/mcps/:id'),
    create: descriptorCommand('mcp-catalog.create-mcp.v1', 'POST', '/api/mcps'),
    update: descriptorCommand('mcp-catalog.update-mcp.v1', 'PUT', '/api/mcps/:id'),
    delete: descriptorCommand('mcp-catalog.delete-mcp.v1', 'DELETE', '/api/mcps/:id'),
  }),
  plugins: Object.freeze({
    list: descriptorQuery('plugin-catalog.list-plugins.v1', '/api/plugins'),
    get: descriptorQuery('plugin-catalog.get-plugin.v1', '/api/plugins/:id'),
    create: descriptorCommand('plugin-catalog.create-plugin.v1', 'POST', '/api/plugins'),
    update: descriptorCommand('plugin-catalog.update-plugin.v1', 'PUT', '/api/plugins/:id'),
    delete: descriptorCommand('plugin-catalog.delete-plugin.v1', 'DELETE', '/api/plugins/:id'),
  }),
  workflows: Object.freeze({
    list: descriptorQuery('workflow-catalog.list-workflows.v1', '/api/workflows'),
    get: MCP_OPERATIONS.workflowGet,
    create: descriptorCommand('workflow-catalog.create-workflow.v1', 'POST', '/api/workflows'),
    update: descriptorCommand('workflow-catalog.update-workflow.v1', 'PUT', '/api/workflows/:id'),
    delete: descriptorCommand(
      'workflow-catalog.delete-workflow.v1',
      'DELETE',
      '/api/workflows/:id',
    ),
  }),
  workgroups: Object.freeze({
    list: descriptorQuery('workgroup-catalog.list-workgroups.v1', '/api/workgroups'),
    get: descriptorQuery('workgroup-catalog.get-workgroup.v1', '/api/workgroups/:id'),
    create: descriptorCommand('workgroup-catalog.create-workgroup.v1', 'POST', '/api/workgroups'),
    update: descriptorCommand(
      'workgroup-catalog.update-workgroup.v1',
      'PUT',
      '/api/workgroups/:id',
    ),
    delete: descriptorCommand(
      'workgroup-catalog.delete-workgroup.v1',
      'DELETE',
      '/api/workgroups/:id',
    ),
  }),
  'scheduled-tasks': Object.freeze({
    list: query('scheduled-task.list-scheduled-tasks.v1', '/api/scheduled-tasks'),
    get: query('scheduled-task.get-scheduled-task.v1', '/api/scheduled-tasks/:id'),
    create: command('scheduled-task.create-scheduled-task.v1', 'POST', '/api/scheduled-tasks'),
    update: command('scheduled-task.update-scheduled-task.v1', 'PUT', '/api/scheduled-tasks/:id'),
    delete: command(
      'scheduled-task.delete-scheduled-task.v1',
      'DELETE',
      '/api/scheduled-tasks/:id',
    ),
  }),
  repos: Object.freeze({
    list: MCP_OPERATIONS.cachedReposList,
    create: command(
      'source-control.import-cached-repos.v1',
      'POST',
      '/api/cached-repos/batch-import',
    ),
    delete: command('source-control.delete-cached-repo.v1', 'DELETE', '/api/cached-repos/:id'),
  }),
  'capability-templates': Object.freeze({
    list: query('capability-catalog.list-capability-templates.v1', '/api/capability-templates'),
    get: query('capability-catalog.get-capability-template.v1', '/api/capability-templates/:id'),
    create: command(
      'capability-catalog.create-capability-template.v1',
      'POST',
      '/api/capability-templates',
    ),
    update: command(
      'capability-catalog.update-capability-template.v1',
      'PUT',
      '/api/capability-templates/:id',
    ),
    delete: command(
      'capability-catalog.delete-capability-template.v1',
      'DELETE',
      '/api/capability-templates/:id',
    ),
  }),
  'repo-groups': Object.freeze({
    list: query('source-control.list-repo-groups.v1', '/api/repo-groups'),
    get: query('source-control.get-repo-group.v1', '/api/repo-groups/:id'),
    create: command('source-control.create-repo-group.v1', 'POST', '/api/repo-groups'),
    update: command('source-control.update-repo-group.v1', 'PUT', '/api/repo-groups/:id'),
    delete: command('source-control.delete-repo-group.v1', 'DELETE', '/api/repo-groups/:id'),
  }),
  memory: Object.freeze({
    list: query('memory.list-memories.v1', '/api/memories'),
    facets: query('memory.list-memory-facets.v1', '/api/memories/facets'),
    get: query('memory.get-memory.v1', '/api/memories/:id'),
    create: command('memory.create-memory.v1', 'POST', '/api/memories'),
    update: command('memory.update-memory.v1', 'PATCH', '/api/memories/:id'),
    delete: command('memory.delete-memory.v1', 'DELETE', '/api/memories/:id'),
  }),
})

export function directBinding(
  toolName: string,
  operation: DeclaredHttpOperation,
): McpOperationBinding {
  return Object.freeze({ kind: 'mcp-direct', toolName, operationId: operation.id })
}

export function compositeBinding(
  toolName: string,
  operations: ReadonlyArray<DeclaredHttpOperation>,
): McpOperationBinding {
  return Object.freeze({
    kind: 'mcp-composite',
    toolName,
    dependencies: Object.freeze([...new Set(operations.map((entry) => entry.id))]),
  })
}

export function parameterizedBinding(
  toolName: string,
  cases: ReadonlyArray<{ readonly selector: string; readonly operation: DeclaredHttpOperation }>,
): McpOperationBinding {
  return Object.freeze({
    kind: 'mcp-parameterized',
    toolName,
    cases: Object.freeze(
      cases.map((entry) =>
        Object.freeze({ selector: entry.selector, operationId: entry.operation.id }),
      ),
    ),
  })
}

export function localBinding(toolName: string, id: string): McpOperationBinding {
  return Object.freeze({ kind: 'mcp-local', toolName, operationId: operationId(id) })
}

export function bindingAllows(binding: McpOperationBinding, id: OperationId): boolean {
  switch (binding.kind) {
    case 'mcp-direct':
    case 'mcp-local':
      return binding.operationId === id
    case 'mcp-composite':
      return binding.dependencies.includes(id)
    case 'mcp-parameterized':
      return binding.cases.some((entry) => entry.operationId === id)
  }
}

const resourceCases = (
  verbs: ReadonlyArray<'list' | 'facets' | 'get' | 'create' | 'update' | 'delete'>,
): Array<{ selector: string; operation: DeclaredHttpOperation }> => {
  const cases: Array<{ selector: string; operation: DeclaredHttpOperation }> = []
  for (const [kind, operations] of Object.entries(RESOURCE_OPERATIONS)) {
    for (const verb of verbs) {
      const operation = (operations as Partial<Record<typeof verb, DeclaredHttpOperation>>)[verb]
      if (operation !== undefined) cases.push({ selector: `${kind}:${verb}`, operation })
    }
  }
  return cases
}

/** Exact 52-tool binding closure. Adding a tool without a binding is a startup error. */
export const MCP_TOOL_BINDINGS = Object.freeze({
  launch_task: compositeBinding('launch_task', [
    MCP_OPERATIONS.workflowGet,
    MCP_OPERATIONS.taskLaunch,
  ]),
  list_repo_refs: compositeBinding('list_repo_refs', [
    MCP_OPERATIONS.cachedReposList,
    MCP_OPERATIONS.repoRefsList,
  ]),
  get_task: directBinding('get_task', MCP_OPERATIONS.taskGet),
  list_tasks: directBinding('list_tasks', MCP_OPERATIONS.taskList),
  watch_task: compositeBinding('watch_task', [MCP_OPERATIONS.taskGet]),
  get_task_diff: directBinding('get_task_diff', MCP_OPERATIONS.taskDiffGet),
  list_node_runs: directBinding('list_node_runs', MCP_OPERATIONS.taskNodeRunsList),
  cancel_task: directBinding('cancel_task', MCP_OPERATIONS.taskCancel),
  retry_node: directBinding('retry_node', MCP_OPERATIONS.taskRetryNode),
  resume_task: directBinding('resume_task', MCP_OPERATIONS.taskResume),
  diagnose_task: directBinding('diagnose_task', MCP_OPERATIONS.taskDiagnose),
  list_task_alerts: directBinding('list_task_alerts', MCP_OPERATIONS.taskAlertsList),
  repair_alert: directBinding('repair_alert', MCP_OPERATIONS.taskAlertRepair),
  list_repair_options: directBinding(
    'list_repair_options',
    MCP_OPERATIONS.taskAlertRepairOptionsList,
  ),
  delete_task: directBinding('delete_task', MCP_OPERATIONS.taskDelete),
  list_pending_gates: compositeBinding('list_pending_gates', [
    MCP_OPERATIONS.reviewsList,
    MCP_OPERATIONS.clarifyList,
    MCP_OPERATIONS.workgroupPendingList,
    MCP_OPERATIONS.fusionsList,
  ]),
  get_clarify_session: directBinding('get_clarify_session', MCP_OPERATIONS.clarifyGet),
  answer_clarify: directBinding('answer_clarify', MCP_OPERATIONS.clarifyAnswer),
  list_task_questions: directBinding('list_task_questions', MCP_OPERATIONS.taskQuestionsList),
  raise_task_question: directBinding('raise_task_question', MCP_OPERATIONS.taskQuestionRaise),
  confirm_task_question: directBinding('confirm_task_question', MCP_OPERATIONS.taskQuestionConfirm),
  reassign_task_question: directBinding(
    'reassign_task_question',
    MCP_OPERATIONS.taskQuestionReassign,
  ),
  stage_task_question: directBinding('stage_task_question', MCP_OPERATIONS.taskQuestionStage),
  dispatch_task_questions: directBinding(
    'dispatch_task_questions',
    MCP_OPERATIONS.taskQuestionsDispatch,
  ),
  list_clarify_directives: directBinding(
    'list_clarify_directives',
    MCP_OPERATIONS.clarifyDirectivesList,
  ),
  set_clarify_directive: directBinding('set_clarify_directive', MCP_OPERATIONS.clarifyDirectiveSet),
  save_clarify_draft: directBinding('save_clarify_draft', MCP_OPERATIONS.clarifyDraftSave),
  get_workgroup_room: directBinding('get_workgroup_room', MCP_OPERATIONS.workgroupRoomGet),
  post_workgroup_message: directBinding(
    'post_workgroup_message',
    MCP_OPERATIONS.workgroupMessagePost,
  ),
  confirm_workgroup_step: directBinding(
    'confirm_workgroup_step',
    MCP_OPERATIONS.workgroupStepConfirm,
  ),
  confirm_workgroup_dynamic_workflow: directBinding(
    'confirm_workgroup_dynamic_workflow',
    MCP_OPERATIONS.workgroupDynamicWorkflowConfirm,
  ),
  save_workgroup_dynamic_workflow: directBinding(
    'save_workgroup_dynamic_workflow',
    MCP_OPERATIONS.workgroupDynamicWorkflowSave,
  ),
  deliver_workgroup_assignment: directBinding(
    'deliver_workgroup_assignment',
    MCP_OPERATIONS.workgroupAssignmentDeliver,
  ),
  cancel_workgroup_assignment: directBinding(
    'cancel_workgroup_assignment',
    MCP_OPERATIONS.workgroupAssignmentCancel,
  ),
  list_fusions: directBinding('list_fusions', MCP_OPERATIONS.fusionsList),
  get_fusion: directBinding('get_fusion', MCP_OPERATIONS.fusionGet),
  approve_fusion: directBinding('approve_fusion', MCP_OPERATIONS.fusionApprove),
  reject_fusion: directBinding('reject_fusion', MCP_OPERATIONS.fusionReject),
  cancel_fusion: directBinding('cancel_fusion', MCP_OPERATIONS.fusionCancel),
  list_reviews: directBinding('list_reviews', MCP_OPERATIONS.reviewsList),
  get_review: directBinding('get_review', MCP_OPERATIONS.reviewGet),
  get_review_document: directBinding('get_review_document', MCP_OPERATIONS.reviewDocumentGet),
  list_review_history: compositeBinding('list_review_history', [
    MCP_OPERATIONS.reviewVersionsList,
    MCP_OPERATIONS.reviewRoundsList,
  ]),
  add_review_comment: directBinding('add_review_comment', MCP_OPERATIONS.reviewCommentAdd),
  update_review_comment: directBinding('update_review_comment', MCP_OPERATIONS.reviewCommentUpdate),
  delete_review_comment: directBinding('delete_review_comment', MCP_OPERATIONS.reviewCommentDelete),
  set_review_document_selection: directBinding(
    'set_review_document_selection',
    MCP_OPERATIONS.reviewSelectionSet,
  ),
  submit_review: directBinding('submit_review', MCP_OPERATIONS.reviewSubmit),
  resource_read: parameterizedBinding('resource_read', resourceCases(['list', 'facets', 'get'])),
  resource_write: parameterizedBinding(
    'resource_write',
    resourceCases(['create', 'update', 'delete']),
  ),
  describe_resource: localBinding('describe_resource', 'mcp.describe-resource.v1'),
  describe_capabilities: localBinding('describe_capabilities', 'mcp.describe-capabilities.v1'),
} satisfies Readonly<Record<string, McpOperationBinding>>)

export function bindingForTool(toolName: string): McpOperationBinding | undefined {
  return (MCP_TOOL_BINDINGS as Readonly<Record<string, McpOperationBinding>>)[toolName]
}

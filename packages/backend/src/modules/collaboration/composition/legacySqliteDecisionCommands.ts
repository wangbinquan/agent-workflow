// RFC-349 — bootstrap-only SQLite compatibility composition. Keeping these
// factories off the context-wide composition barrel prevents the legacy
// services they bridge from forming a value cycle back through that barrel.

export { createReviewDecisionCommand } from '../infrastructure/reviewDecisionCommand'
export { createQuestionDispatchCommand } from '../infrastructure/questionDispatchCommand'
export { createClarifyDecisionCommand } from '../infrastructure/clarifyDecisionCommand'
// RFC-359 W1-T1：task-DAG 调度器消费的 collaboration 投影。它经派发管线绕回 services facade，
// 放在 context-wide barrel 上会成环（depcheck no-circular），故与决定命令同样只从这里出。
export { createTaskDagCollaborationOperations } from '../infrastructure/taskDagCollaborationOperations'

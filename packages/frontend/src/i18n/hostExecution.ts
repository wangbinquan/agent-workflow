import type { HostExecutionGroup } from '@agent-workflow/shared'

export interface HostExecutionMessages {
  resourceOnly: string
  resourceOnlyDescription: string
  standby: string
  preparing: string
  draining: string
  closed: string
  partial: string
  unavailable: string
  activeDescription: string
  checking: string
  queryFailed: string
  retryActivation: string
  retryingActivation: string
  recoveryBeforeRetry: string
  retryFailed: string
  recoverIntent: string
  recoveringIntent: string
  intentRecoveryDescription: string
  intentRecoveryPending: string
  intentRecoveryAcknowledged: string
  group: Record<HostExecutionGroup, string>
}

export const hostExecutionZh: HostExecutionMessages = {
  resourceOnly: '当前可编辑资源，执行能力尚未接入',
  resourceOnlyDescription:
    '可以继续编辑和保存资源。任务、测试及自动运行将在对应能力接入并就绪后开放。',
  standby: '执行暂不可用',
  preparing: '执行正在准备',
  draining: '正在结算已有执行',
  closed: '执行已关闭',
  partial: '部分执行能力尚未就绪',
  unavailable: '尚未就绪：{{groups}}。可以继续编辑和保存资源。',
  activeDescription: '当前可用：{{groups}}。',
  checking: '正在读取执行状态',
  queryFailed: '无法读取执行状态，请重试。',
  retryActivation: '重试启动执行',
  retryingActivation: '正在重试启动',
  recoveryBeforeRetry: '先完成未结算执行的恢复，再重试启动。资源编辑和保存仍可使用。',
  retryFailed: '执行仍未就绪，请完成原执行的恢复后再重试。',
  recoverIntent: '恢复原意图执行',
  recoveringIntent: '正在恢复原执行',
  intentRecoveryDescription: '保留原回合、结果和草稿，确认原执行结束并完成结算后，可重试启动执行。',
  intentRecoveryPending: '原执行尚未确认结算，请保留此回合并再次恢复。',
  intentRecoveryAcknowledged: '原意图执行已确认结算。刷新会话后，可重试启动执行。',
  group: {
    task: '工作流任务',
    intent: '意图自动续跑',
    purpose: '外部业务适配器',
    diagnostics: 'MCP 测试',
    verification: '验证命令',
    observation: '统计报告',
    memory: '记忆蒸馏',
    development: '开发自动化',
    'digital-employee': '数字员工自动运行',
    'event-dispatch': '事件自动触发',
    knowledge: '知识融合',
    maintenance: '备份与维护',
  },
}

export const hostExecutionEn: HostExecutionMessages = {
  resourceOnly: 'Resource editing is available; execution is awaiting integration',
  resourceOnlyDescription:
    'Continue editing and saving resources. Tasks, tests and automatic runs become available as their capabilities are integrated and ready.',
  standby: 'Execution is unavailable',
  preparing: 'Preparing execution',
  draining: 'Settling existing execution',
  closed: 'Execution is closed',
  partial: 'Some execution capabilities are not ready',
  unavailable: 'Not ready: {{groups}}. Resource editing and saving remain available.',
  activeDescription: 'Available now: {{groups}}.',
  checking: 'Reading execution status',
  queryFailed: 'Unable to read execution status. Please retry.',
  retryActivation: 'Retry execution startup',
  retryingActivation: 'Retrying execution startup',
  recoveryBeforeRetry:
    'Recover unsettled executions before retrying startup. Resource editing and saving remain available.',
  retryFailed: 'Execution is still unavailable. Recover the original executions before retrying.',
  recoverIntent: 'Recover original intent execution',
  recoveringIntent: 'Recovering original execution',
  intentRecoveryDescription:
    'Keep the original turn, result and draft. Retry execution startup after the original execution and settlement are acknowledged.',
  intentRecoveryPending:
    'The original execution is still unsettled. Keep this turn and retry its recovery.',
  intentRecoveryAcknowledged:
    'The original intent execution is settled. Refresh the session, then retry execution startup.',
  group: {
    task: 'Workflow tasks',
    intent: 'Automatic intent continuation',
    purpose: 'External business adapters',
    diagnostics: 'MCP tests',
    verification: 'Verification commands',
    observation: 'Observation reports',
    memory: 'Memory distillation',
    development: 'Development automation',
    'digital-employee': 'Automatic digital employee runs',
    'event-dispatch': 'Automatic event triggers',
    knowledge: 'Knowledge fusion',
    maintenance: 'Backups and maintenance',
  },
}

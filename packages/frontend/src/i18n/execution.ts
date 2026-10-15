import type { ExecutionGroup } from '@agent-workflow/shared'

export interface ExecutionMessages {
  standby: string
  standbyDescription: string
  frozen: string
  frozenDescription: string
  unavailable: string
  /** Known standby reasons reported by the instance; others use the generic description. */
  reasons: Record<'remote-execution-not-available', string>
  group: Record<ExecutionGroup, string>
}

export const executionZh: ExecutionMessages = {
  standby: '本实例处于待机状态',
  standbyDescription:
    '可以继续浏览、编辑和保存资源。CrewStation 激活本实例后，任务和自动运行才会开始。',
  frozen: '本实例已交出执行权',
  frozenDescription: '正在交接给新的实例，资源编辑和保存仍可使用。交接完成后页面会连到新的实例。',
  unavailable: '{{group}}暂不可用：本实例当前没有执行权。',
  reasons: {
    'remote-execution-not-available':
      '本部署尚未接入 CrewStation 远程执行：可以浏览、编辑和保存工作流与资源，任务与自动运行暂不可用。',
  },
  group: {
    task: '工作流任务',
    intent: '意图执行',
    purpose: '外部业务适配器',
    diagnostics: 'MCP 与运行时测试',
    verification: '验证命令',
    memory: '记忆蒸馏',
    development: '开发自动化',
    'digital-employee': '数字员工运行',
    'event-dispatch': '事件触发',
    knowledge: '知识融合',
    maintenance: '备份与维护',
  },
}

export const executionEn: ExecutionMessages = {
  standby: 'This instance is on standby',
  standbyDescription:
    'You can keep browsing, editing and saving resources. Tasks and automatic runs start once CrewStation activates this instance.',
  frozen: 'This instance has handed over execution',
  frozenDescription:
    'Execution is moving to a new instance; resource editing and saving remain available. The page reconnects once the handover completes.',
  unavailable: '{{group}} is unavailable: this instance is not executing work right now.',
  reasons: {
    'remote-execution-not-available':
      'CrewStation remote execution is not connected to this deployment yet: workflows and resources can be browsed, edited and saved, while tasks and automatic runs are unavailable.',
  },
  group: {
    task: 'Workflow tasks',
    intent: 'Intent execution',
    purpose: 'External business adapters',
    diagnostics: 'MCP and runtime tests',
    verification: 'Verification commands',
    memory: 'Memory distillation',
    development: 'Development automation',
    'digital-employee': 'Digital employee runs',
    'event-dispatch': 'Event triggers',
    knowledge: 'Knowledge fusion',
    maintenance: 'Backups and maintenance',
  },
}

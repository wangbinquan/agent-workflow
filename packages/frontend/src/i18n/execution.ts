import type { ExecutionGroup } from '@agent-workflow/shared'

/** RFC-370 — the standby / frozen reasons a hosted instance reports with precise copy. */
export type ExecutionReason =
  | 'remote-execution-not-available'
  | 'execution-lease-pending'
  | 'execution-lease-held-elsewhere'
  | 'not-the-active-release'
  | 'execution-frozen-by-platform'
  | 'database-frozen-by-platform'
  | 'platform-unreachable'
  | 'execution-lease-rejected'
  | 'execution-recovery-in-progress'
  | 'execution-authority-closed'

export interface ExecutionMessages {
  standby: string
  standbyDescription: string
  frozen: string
  frozenDescription: string
  unavailable: string
  /** Known standby reasons reported by the instance; others use the generic description. */
  reasons: Record<ExecutionReason, string>
  /** Reasons whose banner title differs from the state's. */
  reasonTitles: Partial<Record<ExecutionReason, string>>
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
    'execution-lease-pending':
      '正在向 CrewStation 申请执行权，通常几秒内完成；期间可以浏览、编辑和保存资源。',
    'execution-lease-held-elsewhere':
      '另一个实例正在执行任务；本实例在它交出执行权后接管。可以继续浏览、编辑和保存资源。',
    'not-the-active-release':
      '本实例不是当前对外服务的版本，切流到本版本后才会执行任务；可以继续浏览资源。',
    'execution-frozen-by-platform':
      '执行权已交给新的实例，任务会在新实例上继续。交接完成后页面会连到新的实例。',
    'database-frozen-by-platform':
      'CrewStation 正在迁移或恢复本服务的数据库：现在可以浏览，但不能保存修改，任务与自动运行也已暂停。平台完成后会自动恢复。',
    'platform-unreachable':
      '暂时连不上 CrewStation 平台，正在自动重试；恢复连接后任务与自动运行继续。可以继续浏览、编辑和保存资源。',
    'execution-lease-rejected':
      'CrewStation 拒绝了本实例的执行权申请，正在自动重试；如长时间持续，请联系平台管理员检查本服务的发布与执行控制。',
    'execution-recovery-in-progress': '正在接管上次运行中的任务，完成后任务与自动运行即可使用。',
    'execution-authority-closed': '本实例正在停止，页面稍后会连到继续服务的实例。',
  },
  reasonTitles: {
    'database-frozen-by-platform': '数据库维护中，暂时只读',
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
    'execution-lease-pending':
      'Requesting execution from CrewStation; this usually takes a few seconds. You can keep browsing, editing and saving resources.',
    'execution-lease-held-elsewhere':
      'Another instance is executing work; this instance takes over once it hands execution over. You can keep browsing, editing and saving resources.',
    'not-the-active-release':
      'This instance is not the release currently serving traffic; it executes work after traffic switches to it. You can keep browsing.',
    'execution-frozen-by-platform':
      'Execution moved to a new instance, where tasks continue. The page reconnects once the handover completes.',
    'database-frozen-by-platform':
      'CrewStation is migrating or restoring this service database: you can browse, but changes cannot be saved and tasks and automatic runs are paused. Everything resumes when the platform finishes.',
    'platform-unreachable':
      'CrewStation cannot be reached right now; retrying automatically. Tasks and automatic runs continue once the connection is back. You can keep browsing, editing and saving resources.',
    'execution-lease-rejected':
      'CrewStation refused this instance execution; retrying automatically. If this persists, ask a platform administrator to check the service release and execution control.',
    'execution-recovery-in-progress':
      'Taking over the work that was running before; tasks and automatic runs are available once it completes.',
    'execution-authority-closed':
      'This instance is stopping; the page reconnects to the instance that keeps serving.',
  },
  reasonTitles: {
    'database-frozen-by-platform': 'Database maintenance: read-only for now',
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

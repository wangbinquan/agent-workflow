export interface HostedBackupMessages {
  title: string
  hint: string
  databaseOnly: string
  create: string
  creating: string
  empty: string
  recent: string
  createdAt: string
  kind: string
  size: string
  state: string
  actions: string
  manual: string
  scheduled: string
  protected: string
  verify: string
  verifying: string
  verified: string
  close: string
  reference: string
  referenceHint: string
  copy: string
  copied: string
  copyFailed: string
  counts: string
  restoreSteps: string
  restoreStep1: string
  restoreStep2: string
  restoreStep3: string
  changedPermission: string
  verifiedAt: string
  states: Record<'building' | 'ready' | 'failed' | 'released', string>
}
export const hostedBackupZh: HostedBackupMessages = {
  title: '托管备份与恢复',
  hint: '备份是一份数据库归档，存入 CrewStation 对象空间；归档引用的内容在备份保留期内一并保留。',
  databaseOnly:
    '托管备份只包含数据库，不包含任务工作区：工作区位于平台持久卷上，卷丢失时通过平台恢复动作（重建或重启）处理。',
  create: '创建备份',
  creating: '正在创建备份…',
  empty: '尚无备份记录',
  recent: '仅显示最近 100 条备份记录。',
  createdAt: '创建时间',
  kind: '来源',
  size: '大小',
  state: '状态',
  actions: '操作',
  manual: '手工',
  scheduled: '定时',
  protected: '当前恢复源，保留中',
  verify: '校验并查看恢复信息',
  verifying: '正在核对备份归档…',
  verified: '备份归档可用',
  close: '关闭',
  reference: '恢复引用',
  referenceHint: '将完整引用交给平台管理员，在 CrewStation 服务发布的“数据库恢复”页使用。',
  copy: '复制恢复引用',
  copied: '已复制',
  copyFailed: '复制失败，请手动复制恢复引用。',
  counts:
    '{{workflows}} 个工作流，{{skills}} 个技能；归档 {{size}} 仍完整保存在对象存储中，恢复时会逐字节校验。',
  restoreSteps: '平台恢复步骤',
  restoreStep1: '平台管理员在 CrewStation 的“数据库恢复”页选择兼容版本，粘贴此引用并创建独立恢复。',
  restoreStep2:
    '平台准备空目标库，恢复作业下载并校验归档后导入；独立校验通过后，管理员确认进入维护并切换，原数据库保留。',
  restoreStep3:
    '恢复后运行中的任务被中断，未完成任务暂停自动恢复；核对各任务的工作区后再手工续跑。',
  changedPermission: '当前账号或备份权限已变化，请刷新页面。',
  verifiedAt: '校验时间：{{time}}',
  states: {
    building: '创建中',
    ready: '可用',
    failed: '失败',
    released: '已删除',
  },
}
export const hostedBackupEn: HostedBackupMessages = {
  title: 'Hosted backup and restore',
  hint: 'A backup is one database archive stored in CrewStation object storage; the content it references is retained while the backup is kept.',
  databaseOnly:
    'Hosted backups contain the database only, not task workspaces: workspaces live on platform persistent volumes, and a lost volume is recovered with the platform actions (rebuild or restart).',
  create: 'Create backup',
  creating: 'Creating backup…',
  empty: 'No backups yet',
  recent: 'Only the latest 100 backups are shown.',
  createdAt: 'Created',
  kind: 'Source',
  size: 'Size',
  state: 'State',
  actions: 'Actions',
  manual: 'Manual',
  scheduled: 'Scheduled',
  protected: 'Retained as the current restore source',
  verify: 'Verify and view restore details',
  verifying: 'Checking the backup archive…',
  verified: 'Backup archive available',
  close: 'Close',
  reference: 'Restore reference',
  referenceHint:
    'Give the complete reference to a platform administrator for the Database restore page under CrewStation service releases.',
  copy: 'Copy restore reference',
  copied: 'Copied',
  copyFailed: 'Copy failed. Copy the reference manually.',
  counts:
    '{{workflows}} workflows, {{skills}} skills; the {{size}} archive is intact in object storage and is verified byte for byte when restored.',
  restoreSteps: 'Platform restore steps',
  restoreStep1:
    'A platform administrator selects a compatible release and pastes this reference on the CrewStation Database restore page to create an independent restore.',
  restoreStep2:
    'The platform provisions an empty database; the restore job downloads and verifies the archive, then imports it. After independent verification, an administrator confirms maintenance and cutover; the original database is retained.',
  restoreStep3:
    'After the restore, running tasks are interrupted and unfinished tasks stay paused for automatic recovery. Check each task workspace before resuming it manually.',
  changedPermission: 'Your signed-in account or backup permission changed. Refresh the page.',
  verifiedAt: 'Verified at {{time}}',
  states: {
    building: 'Building',
    ready: 'Ready',
    failed: 'Failed',
    released: 'Deleted',
  },
}

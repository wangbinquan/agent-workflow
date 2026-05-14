// P-5-03 stage 1: zh-CN resource bundle.
//
// Source of truth for the Chinese UI. Keep keys flat under top-level sections
// (nav / auth / settings / errors). Newer routes can add their own section as
// we migrate them to t() — there is no migration script, but the key tree
// matches en-US 1:1.

export interface Resources {
  nav: {
    agents: string
    skills: string
    workflows: string
    tasks: string
    settings: string
    brand: string
  }
  auth: {
    title: string
    hint: string
    hintCmd: string
    hintAfter: string
    daemonUrl: string
    token: string
    tokenPlaceholder: string
    verifying: string
    connect: string
  }
  settings: {
    title: string
    hintBacked: string
    hintPatched: string
    hintRestart: string
    tabRuntime: string
    tabLimits: string
    tabGc: string
    tabNetwork: string
    tabConnection: string
    tabAppearance: string
    loading: string
    saving: string
    saved: string
    save: string
    backupTitle: string
    backupHint: string
    backupCreate: string
    backupRunning: string
    backupSavedAs: string
    themeLabel: string
    themeHint: string
    themeSystem: string
    themeLight: string
    themeDark: string
    restartRequiredTitle: string
    restartRequiredHint: string
  }
  errors: Record<string, string>
}

export const zhCN: Resources = {
  nav: {
    agents: '代理',
    skills: '技能',
    workflows: '工作流',
    tasks: '任务',
    settings: '设置',
    brand: 'Agent Workflow',
  },
  auth: {
    title: '连接到守护进程',
    hint: '运行 ',
    hintCmd: 'agent-workflow start',
    hintAfter: '，复制启动时打印的 token 粘贴到下方。',
    daemonUrl: '守护进程 URL',
    token: 'Token',
    tokenPlaceholder: '64 位十六进制',
    verifying: '验证中…',
    connect: '连接',
  },
  settings: {
    title: '设置',
    hintBacked: '基于 ',
    hintPatched: '。补丁通过 ',
    hintRestart: '。标注 restart 的字段需重启守护进程才生效。',
    tabRuntime: '运行时',
    tabLimits: '限额',
    tabGc: 'GC',
    tabNetwork: '网络',
    tabConnection: '连接',
    tabAppearance: '外观',
    loading: '加载中…',
    saving: '保存中…',
    saved: '已保存',
    save: '保存',
    backupTitle: '导出备份',
    backupHint:
      '将 db.sqlite + config.json + skills/ + workflows YAML 打包为 tarball，存放到 ~/.agent-workflow/backups/。不含 worktrees / runs / logs / token。',
    backupCreate: '创建备份',
    backupRunning: '正在创建备份…',
    backupSavedAs: '已保存 ',
    themeLabel: '主题',
    themeHint: '系统：跟随操作系统的浅色 / 深色偏好。',
    themeSystem: '跟随系统',
    themeLight: '浅色',
    themeDark: '深色',
    restartRequiredTitle: '需要重启守护进程',
    restartRequiredHint:
      '新值已写入 config.json，但 bind host / bind port 仅在下次 agent-workflow start 时生效。请在终端先 agent-workflow stop，再 agent-workflow start。',
  },
  // Error codes thrown by the backend (DomainError family + transport).
  errors: {
    'http-401': '未授权 — 请重新登录并粘贴 token。',
    'http-404': '资源不存在。',
    'http-409': '存在冲突，请刷新后重试。',
    'route-not-found': '路由不存在。',
    'task-not-cancelable': '该任务已结束，无法取消。',
    'task-not-resumable': '该任务还在运行或未失败，无法 resume。',
    'task-still-running': '任务还在运行，请先取消。',
    'workflow-import-conflict': '导入冲突：已存在同 id 的工作流。',
    'config-invalid': '配置不合法。',
    'task-invalid': '任务输入不合法。',
    fallback: '请求失败',
  },
}

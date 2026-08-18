import { PERMISSIONS, type Permission } from '@agent-workflow/shared'

export interface PermissionCatalogTranslation {
  label: string
  description: string
}

type Locale = 'en-US' | 'zh-CN'
type ResourceOf<P extends string> = P extends `${infer Resource}:${string}` ? Resource : never
type ActionOf<P extends string> = P extends `${string}:${infer Tail}`
  ? Tail extends `${infer Action}:${string}`
    ? Action
    : Tail
  : never
type PermissionResource = ResourceOf<Permission>
type PermissionAction = ActionOf<Permission>

const EN_RESOURCES = {
  agents: 'Agents',
  skills: 'Skills',
  mcps: 'MCP servers',
  plugins: 'Plugins',
  workflows: 'Workflows',
  workgroups: 'Workgroups',
  'scheduled-tasks': 'Scheduled tasks',
  'webhook-triggers': 'Webhook triggers',
  'webhook-endpoints': 'Webhook endpoints',
  repos: 'Repositories',
  memory: 'Memory',
  tasks: 'Tasks',
  users: 'Users',
  settings: 'Settings',
  oidc: 'OIDC',
  backup: 'Backups',
  runtime: 'Runtime',
  account: 'Account',
  intent: 'Intent Builder',
  scripts: 'Scripts',
  'code-host-calls': 'Code-host calls',
  'resource-acl': 'Resource ACL',
  'memory-distill-jobs': 'Memory distill jobs',
  'mcp-runtime-tests': 'MCP runtime tests',
  // RFC-304 — the two capability template layers. Named for what a reader
  // manages rather than for the table: "department template" is what the
  // scripts live in, "team template" is what points it at agents and prompts.
  'capability-templates': 'Capability templates',
  'code-rounds': 'Capability rounds',
  // RFC-310 — digital-employee configuration resources.
  'action-templates': 'Action templates',
  'verification-profiles': 'Verification profiles',
  'digital-employees': 'Digital employees',
  'automation-policies': 'Automation policies',
  'adapter-definitions': 'Development adapters',
  'repository-employee-assignments': 'Repository employee assignments',
} satisfies Record<PermissionResource, string>

const ZH_RESOURCES = {
  agents: 'Agent',
  skills: '技能',
  mcps: 'MCP 服务',
  plugins: '插件',
  workflows: '工作流',
  workgroups: '工作组',
  'scheduled-tasks': '定时任务',
  'webhook-triggers': 'Webhook 触发规则',
  'webhook-endpoints': 'Webhook 端点',
  repos: '仓库',
  memory: '记忆',
  tasks: '任务',
  users: '用户',
  settings: '系统设置',
  oidc: 'OIDC',
  backup: '备份',
  runtime: '运行时',
  account: '账户',
  intent: 'Intent 构建器',
  scripts: '脚本',
  'code-host-calls': '代码平台调用',
  'resource-acl': '资源 ACL',
  'memory-distill-jobs': '记忆提炼任务',
  'mcp-runtime-tests': 'MCP 运行测试',
  'capability-templates': '能力模板',
  'code-rounds': '能力轮次',
  // RFC-310 —— 数字员工配置资源。
  'action-templates': '动作模板',
  'verification-profiles': '验证配置',
  'digital-employees': '数字员工',
  'automation-policies': '自动化策略',
  'adapter-definitions': '开发适配器',
  'repository-employee-assignments': '仓库员工指派',
} satisfies Record<PermissionResource, string>

const EN_ACTIONS = {
  read: 'View',
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
  execute: 'Run',
  launch: 'Start',
  write: 'Manage',
  configure: 'Configure',
  run: 'Run',
  self: 'Use own account',
  author: 'Author',
  manage: 'Manage',
  search: 'Search',
  bypass: 'Bypass',
  private: 'View assigned private',
  audit: 'Audit',
  'override-owner': 'Override owner',
  archive: 'Archive',
} satisfies Record<PermissionAction, string>

const ZH_ACTIONS = {
  read: '查看',
  create: '创建',
  update: '修改',
  delete: '删除',
  execute: '执行',
  launch: '发起',
  write: '管理',
  configure: '配置',
  run: '执行',
  self: '使用自己的账户',
  author: '编写',
  manage: '管理',
  search: '搜索',
  bypass: '绕过',
  private: '查看获授权私有',
  audit: '审计',
  'override-owner': '覆盖 owner',
  archive: '归档',
} satisfies Record<PermissionAction, string>

const SPECIAL: Record<Locale, Partial<Record<Permission, PermissionCatalogTranslation>>> = {
  'en-US': {
    'tasks:read:own': {
      label: 'View own tasks',
      description: 'View tasks you own or participate in, subject to task membership.',
    },
    'tasks:read:all': {
      label: 'View all tasks',
      description: 'Extend task visibility from membership-scoped tasks to every task.',
    },
    'scripts:author': {
      label: 'Author script nodes',
      description:
        'View and change inline script bodies when the workflow ACL also permits editing. This does not control execution.',
    },
    'code-host-calls:author': {
      label: 'Author code-host call nodes',
      description:
        'View and change code-host calls that use the platform bot identity, subject to the workflow ACL.',
    },
    'account:self': {
      label: 'Use own account',
      description: 'Intrinsic access to the signed-in account profile, sessions and tokens.',
    },
    'webhook-endpoints:manage': {
      label: 'Manage webhook endpoints',
      description: 'Create, rotate and remove platform ingress endpoints and their secrets.',
    },
    'resource-acl:bypass': {
      label: 'Bypass resource ACLs',
      description: 'View and manage ACL resources regardless of owner or explicit resource grants.',
    },
    'resource-acl:private': {
      label: 'View assigned private resources',
      description:
        'View private ACL resources when you are their owner or have an explicit resource grant.',
    },
    'memory-distill-jobs:manage': {
      label: 'Manage memory distill jobs',
      description: 'View, retry and cancel platform memory-distillation jobs.',
    },
    'intent:audit': {
      label: 'Audit all Intent sessions',
      description: 'View Intent sessions owned by other users for platform audit purposes.',
    },
    'mcp-runtime-tests:audit': {
      label: 'Audit MCP runtime tests',
      description: 'View MCP runtime test sessions owned by other users.',
    },
    'webhook-triggers:override-owner': {
      label: 'Override webhook trigger owners',
      description: 'Modify or delete webhook trigger rules owned by another user.',
    },
  },
  'zh-CN': {
    'tasks:read:own': {
      label: '查看自己的任务',
      description: '查看自己拥有或参与的任务，仍受任务成员范围约束。',
    },
    'tasks:read:all': {
      label: '查看全部任务',
      description: '把任务可见范围从自己拥有或参与的任务扩展到全部任务。',
    },
    'scripts:author': {
      label: '编写脚本节点',
      description: '在工作流 ACL 同时允许编辑时查看和修改内联脚本正文；此权限不控制脚本执行。',
    },
    'code-host-calls:author': {
      label: '编写代码平台调用节点',
      description: '在工作流 ACL 同时允许编辑时，查看和修改使用平台机器人身份的代码平台调用。',
    },
    'account:self': {
      label: '使用自己的账户',
      description: '登录账户固有的个人资料、会话与令牌管理权限。',
    },
    'webhook-endpoints:manage': {
      label: '管理 Webhook 端点',
      description: '创建、轮换和删除平台入站端点及其验证密钥。',
    },
    'resource-acl:bypass': {
      label: '绕过资源 ACL',
      description: '不受 owner 或显式资源授权限制，查看和管理所有 ACL 资源。',
    },
    'resource-acl:private': {
      label: '查看获授权的私有资源',
      description: '作为 owner 或获得显式资源授权时，查看对应的私有 ACL 资源。',
    },
    'memory-distill-jobs:manage': {
      label: '管理记忆提炼任务',
      description: '查看、重试和取消平台记忆提炼任务。',
    },
    'intent:audit': {
      label: '审计全部 Intent 会话',
      description: '出于平台审计目的查看其他用户拥有的 Intent 会话。',
    },
    'mcp-runtime-tests:audit': {
      label: '审计 MCP 运行测试',
      description: '查看其他用户拥有的 MCP 运行测试会话。',
    },
    'webhook-triggers:override-owner': {
      label: '覆盖 Webhook 触发规则 owner',
      description: '修改或删除其他用户拥有的 Webhook 触发规则。',
    },
  },
}

const PERMISSION_UI_COPY = {
  'en-US': {
    title: 'Detailed permissions',
    summary: '{{effective}} effective · {{additional}} additional',
    searchLabel: 'Search permissions',
    searchPlaceholder: 'Search permission name, description, or id…',
    noMatches: 'No permissions found',
    noMatchesDescription: 'No permissions match the current search.',
    baselineReason: 'Included by the selected access preset',
    intrinsicReason: 'Intrinsic to every signed-in account',
    changeSummary: '{{added}} added · {{removed}} removed',
    criticalWarning: 'Review critical additions carefully.',
    staleTitle: 'Permissions changed elsewhere',
    staleBody: 'Reload the latest access settings before saving again.',
    reloadLatest: 'Reload latest',
    groups: {
      resources: 'Resources',
      tasks: 'Tasks',
      'memory-intent': 'Memory and Intent',
      webhooks: 'Webhooks',
      repositories: 'Repositories',
      'privileged-authoring': 'Privileged authoring',
      platform: 'Platform administration',
    },
    source: {
      baseline: 'Access preset',
      additional: 'Additional grant',
      available: 'Available',
      intrinsic: 'Intrinsic',
    },
    risk: { standard: 'Standard', elevated: 'Elevated', critical: 'Critical' },
    token: {
      matrix: 'Available to PAT matrix',
      'account-range': 'Account range; PAT follows account',
      never: 'Never available to PATs',
    },
    constraints: {
      'resource-acl': 'Resource ACL still applies',
      'task-membership': 'Task membership still applies',
      'task-global-range': 'Extends task visibility globally',
      'owner-or-override': 'Owner or explicit owner override',
    },
  },
  'zh-CN': {
    title: '详细权限清单',
    summary: '{{effective}} 项生效 · {{additional}} 项附加授权',
    searchLabel: '搜索权限',
    searchPlaceholder: '搜索权限名称、说明或标识…',
    noMatches: '没有匹配的权限',
    noMatchesDescription: '当前搜索条件下没有匹配的权限。',
    baselineReason: '由当前权限预设提供',
    intrinsicReason: '每个已登录账户固有',
    changeSummary: '新增 {{added}} 项 · 移除 {{removed}} 项',
    criticalWarning: '请仔细核对高风险新增权限。',
    staleTitle: '权限已在其他位置变更',
    staleBody: '请重新载入最新权限后再保存。',
    reloadLatest: '载入最新权限',
    groups: {
      resources: '资源',
      tasks: '任务',
      'memory-intent': '记忆与 Intent',
      webhooks: 'Webhook',
      repositories: '仓库',
      'privileged-authoring': '高风险编写能力',
      platform: '平台管理',
    },
    source: {
      baseline: '权限预设',
      additional: '附加授权',
      available: '可授予',
      intrinsic: '账户固有',
    },
    risk: { standard: '常规', elevated: '较高风险', critical: '高风险' },
    token: {
      matrix: '可进入 PAT 权限矩阵',
      'account-range': '账户范围；PAT 随账户变化',
      never: 'PAT 永不可持有',
    },
    constraints: {
      'resource-acl': '仍受资源 ACL 约束',
      'task-membership': '仍受任务成员范围约束',
      'task-global-range': '扩展为全部任务范围',
      'owner-or-override': '仅 owner 或显式 owner 覆盖权限',
    },
  },
} as const

function genericTranslation(permission: Permission, locale: Locale): PermissionCatalogTranslation {
  const [resource, action, range] = permission.split(':') as [
    PermissionResource,
    PermissionAction,
    string | undefined,
  ]
  const resources = locale === 'zh-CN' ? ZH_RESOURCES : EN_RESOURCES
  const actions = locale === 'zh-CN' ? ZH_ACTIONS : EN_ACTIONS
  const resourceLabel = resources[resource]
  const actionLabel = actions[action]
  const rangeSuffix =
    range === undefined ? '' : locale === 'zh-CN' ? `（${range} 范围）` : ` (${range})`
  if (locale === 'zh-CN') {
    return {
      label: `${actionLabel}${resourceLabel}${rangeSuffix}`,
      description: `允许${actionLabel}${resourceLabel}；实际对象范围仍受该行列出的 ACL、成员或身份约束。`,
    }
  }
  return {
    label: `${actionLabel} ${resourceLabel}${rangeSuffix}`,
    description: `${actionLabel} ${resourceLabel}; the row-level ACL, membership or identity constraints shown here still apply.`,
  }
}

export function buildPermissionCatalogResources(locale: Locale) {
  return {
    ...PERMISSION_UI_COPY[locale],
    catalog: Object.fromEntries(
      PERMISSIONS.map((permission) => [
        permission.replaceAll(':', '_'),
        SPECIAL[locale][permission] ?? genericTranslation(permission, locale),
      ]),
    ),
  }
}

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
  onboarding: {
    title: string
    intro: string
    step1Title: string
    step1Body: string
    step1Cta: string
    step2Title: string
    step2Body: string
    step2Cta: string
    step3Title: string
    step3Body: string
    step3Import: string
    step3ImportRunning: string
    step3Manual: string
    step4Title: string
    step4Body: string
    step4Cta: string
    importedHint: string
    skipLink: string
  }
  common: {
    loading: string
    open: string
    delete: string
    save: string
    saved: string
    saving: string
    creating: string
    unknownError: string
    yes: string
    no: string
    details: string
    emDash: string
    copy: string
    copied: string
    empty: string
    optionalPlaceholder: string
    confirmPrompt: string
  }
  agents: {
    title: string
    hint: string
    newButton: string
    emptyList: string
    colName: string
    colDescription: string
    colOutputs: string
    colReadonly: string
    loadingAgent: string
    detailHint: string
    saveButton: string
    newTitle: string
    newHint: string
    createButton: string
  }
  skills: {
    title: string
    hintBefore: string
    hintManaged: string
    hintMid: string
    hintManagedPath: string
    hintBetween: string
    hintExternal: string
    hintAfter: string
    newButton: string
    emptyList: string
    colName: string
    colSource: string
    colDescription: string
    colPath: string
    newTitle: string
    newHintBefore: string
    newHintManaged: string
    newHintMid: string
    newHintExternal: string
    newHintAfter: string
    tabManaged: string
    tabExternal: string
    fieldName: string
    fieldNameHint: string
    fieldDescription: string
    fieldBody: string
    fieldExternalPath: string
    fieldExternalPathHint: string
    externalPathPlaceholder: string
    createButton: string
    deleteButton: string
    saveDescription: string
    saveBody: string
    emptyBody: string
    bodySection: string
    filesSection: string
    descHintManaged: string
    descHintExternal: string
  }
  workflows: {
    title: string
    hint: string
    newButton: string
    importButton: string
    emptyList: string
    importedAsNew: string
    workflowOverwritten: string
    importCanceled: string
    conflictPrompt: string
    colName: string
    colVersion: string
    colId: string
  }
  tasks: {
    title: string
    hint: string
    filterAll: string
    emptyList: string
    colId: string
    colStatus: string
    colStarted: string
    colRepo: string
    colError: string
    loadingTask: string
    metaWorkflow: string
    metaRepo: string
    metaWorktree: string
    metaBranch: string
    metaStarted: string
    metaFinished: string
    metaError: string
    cancelButton: string
    failedBanner: string
    jumpToFailed: string
    worktreePreserved: string
    sectionWorkflowStatus: string
    sectionNodeRuns: string
    sectionWorktreeDiff: string
    noWorkflowSnapshot: string
    noBaseCommit: string
    loadingDiff: string
    noNodeRuns: string
    colNode: string
    colIteration: string
    colRetry: string
    colDuration: string
    secondsAgo: string
    minutesAgo: string
    hoursAgo: string
  }
  editor: {
    newTitle: string
    newHint: string
    create: string
    creating: string
    fieldName: string
    fieldDescription: string
    loadingWorkflow: string
    statusSaving: string
    statusUnsaved: string
    statusSaved: string
    launch: string
    validate: string
    validating: string
    exportYaml: string
    exportTitle: string
    remoteUpdated: string
    remoteDeleted: string
    remoteDismiss: string
    validationOk: string
    validationIssues: string
    paletteFilter: string
    paletteNoMatches: string
    paletteAgents: string
    paletteFanOut: string
    paletteFanOutDesc: string
    paletteAgentFallbackDesc: string
    paletteWrappers: string
    paletteWrapperGitLabel: string
    paletteWrapperGitDesc: string
    paletteWrapperLoopLabel: string
    paletteWrapperLoopDesc: string
    paletteIo: string
    paletteInputLabel: string
    paletteInputDesc: string
    paletteOutputLabel: string
    paletteOutputDesc: string
    menuPaste: string
    menuSelectAll: string
    menuDuplicate: string
    menuCopy: string
    menuWrapGit: string
    menuWrapLoop: string
    menuDecompose: string
  }
  launch: {
    title: string
    hintBefore: string
    hintCode: string
    hintAfter: string
    backToEditor: string
    fieldRepo: string
    fieldRepoHint: string
    pickRepoPlaceholder: string
    pasteRepoPath: string
    fieldBaseBranch: string
    baseBranchHint: string
    pickBranchPlaceholder: string
    baseBranchPlaceholder: string
    noInputs: string
    start: string
    starting: string
  }
  inspector: {
    closeAria: string
    tabEdit: string
    tabPreview: string
    previewOnlyAgent: string
    resolvedInbound: string
    fieldInputKey: string
    fieldInputKeyHint: string
    fieldOutputPorts: string
    fieldOutputPortsHint: string
    portNamePlaceholder: string
    upstreamPlaceholder: string
    portPlaceholder: string
    remove: string
    addPort: string
    innerNodeIds: string
    innerNodeIdsHint: string
    none: string
    loopBanner: string
    fieldMaxIterations: string
    fieldExitConditionKind: string
    fieldExitConditionKindHint: string
    fieldExitConditionTarget: string
    fieldExitConditionTargetHint: string
    fieldExitConditionValue: string
    fieldExitConditionN: string
    fieldExitConditionSeparator: string
    fieldOutputBindings: string
    fieldOutputBindingsHint: string
    outputNamePlaceholder: string
    innerNodeIdPlaceholder: string
    addBinding: string
    fieldAgent: string
    fieldAgentHint: string
    pickAgent: string
    fieldSourcePort: string
    fieldPromptTemplate: string
    fieldPromptTemplateHint: string
    fieldRetries: string
    fieldRetriesHint: string
    fieldTimeoutMs: string
    fieldTimeoutMsHint: string
    fieldModelOverride: string
    modelPlaceholder: string
    fieldVariant: string
    fieldTemperatureOverride: string
    sourcePortNodePlaceholder: string
    sourcePortPlaceholder: string
  }
  promptPreview: {
    mockTitle: string
    noPorts: string
    assembledTitle: string
  }
  agentForm: {
    fieldName: string
    fieldNameHint: string
    fieldNamePlaceholder: string
    fieldDescription: string
    fieldDescriptionPlaceholder: string
    fieldOutputs: string
    fieldOutputsHint: string
    fieldOutputsPlaceholder: string
    outputsValidate: string
    fieldSkills: string
    fieldSkillsHint: string
    fieldSkillsPlaceholder: string
    fieldReadonly: string
    fieldReadonlyHint: string
    fieldModel: string
    modelPlaceholder: string
    fieldVariant: string
    fieldTemperature: string
    temperaturePlaceholder: string
    fieldSteps: string
    fieldMaxSteps: string
    fieldPermission: string
    fieldPermissionHint: string
    permissionPlaceholder: string
    fieldFrontmatterExtra: string
    fieldFrontmatterExtraHint: string
    fieldBody: string
    bodyPlaceholder: string
    rawBodySummary: string
  }
  nodeDrawer: {
    kindLabel: string
    tabPrompt: string
    tabEvents: string
    tabOutput: string
    tabStats: string
    shardCount: string
    shardNoKey: string
    tokenPrefix: string
    promptPending: string
    outputNone: string
    statStatus: string
    statStarted: string
    statFinished: string
    statDuration: string
    statExitCode: string
    statIteration: string
    statRetry: string
    statTokensIn: string
    statTokensOut: string
    statTokensTotal: string
    statCacheCreate: string
    statCacheRead: string
    statError: string
    statRetries: string
    attempt: string
    noEventsMatch: string
  }
  taskOutputs: {
    section: string
    pending: string
  }
  settingsForm: {
    opencodePath: string
    opencodePathHint: string
    defaultModel: string
    defaultModelHint: string
    defaultVariant: string
    defaultTemperature: string
    maxConcurrentNodes: string
    multiProcessConc: string
    logLevel: string
    perTaskDuration: string
    perTaskTokens: string
    perNodeTimeout: string
    largeOutputThreshold: string
    zeroUnlimited: string
    autoGcLabel: string
    autoGcHint: string
    olderThanDays: string
    onlyMerged: string
    archivePerNodeRun: string
    archivePerNodeRunHint: string
    archiveGlobal: string
    archiveGlobalHint: string
    bindHost: string
    bindHostHint: string
    bindPort: string
    bindPortHint: string
    daemonUrl: string
    tokenLabel: string
    tokenNone: string
    tokenMask: string
    signOut: string
    runtimeStatusTitle: string
    runtimeStatusProbing: string
    runtimeStatusOk: string
    runtimeStatusIncompatible: string
    runtimeStatusNotFound: string
    runtimeStatusBinary: string
    runtimeStatusReprobe: string
    runtimeStatusMinVersion: string
    runtimeStatusHint: string
    modelLoadFailed: string
    modelLoading: string
    modelRefresh: string
    modelCustom: string
    modelCustomPlaceholder: string
    modelEmpty: string
  }
  enumPicker: {
    otherPlaceholder: string
    add: string
  }
  wrapperNode: {
    innerNodes: string
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
  onboarding: {
    title: '欢迎使用 Agent Workflow',
    intro: '看起来这是新仓 — 还没有任何 agent 或 workflow。跟着下面四步建一条最小流水线。',
    step1Title: '1. 创建第一个 agent',
    step1Body:
      '取名为 coder，把 outputs 设为 [code]，readonly 关闭，把 prompt body 留空或粘一段简单的指令即可。',
    step1Cta: '创建 agent →',
    step2Title: '2. （可选）添加 skill',
    step2Body:
      'Skill 是按需注入的 .md 文件 / 目录，常用于注入 prompt 模板或参考文档；本步骤不是必需的。',
    step2Cta: '管理 skill →',
    step3Title: '3. 创建 workflow',
    step3Body:
      '点下面按钮一键导入 demo（input → coder agent → output 的三节点流水线），或从空白开始自己拼。',
    step3Import: '导入 demo workflow',
    step3ImportRunning: '正在导入…',
    step3Manual: '或者新建空白 workflow →',
    step4Title: '4. 启动任务',
    step4Body:
      '到 workflows 列表点 Launch，选一个本地 git 仓 + 分支，填好 inputs，提交。任务详情页会显示节点状态、prompt、产物和 diff。',
    step4Cta: '前往 workflow 列表 →',
    importedHint: '已导入；继续前往 workflow 列表去 Launch。',
    skipLink: '跳过引导，直接打开 agent 列表 →',
  },
  common: {
    loading: '加载中…',
    open: '打开',
    delete: '删除',
    save: '保存',
    saved: '已保存',
    saving: '保存中…',
    creating: '创建中…',
    unknownError: '未知错误',
    yes: '是',
    no: '否',
    details: '详情',
    emDash: '—',
    copy: '复制',
    copied: '已复制！',
    empty: '（空）',
    optionalPlaceholder: '（可选）',
    confirmPrompt: '确认？',
  },
  agents: {
    title: '代理',
    hint: '虚拟代理；通过 OPENCODE_CONFIG_CONTENT 在 per-run 注入。',
    newButton: '+ 新建代理',
    emptyList: '还没有代理。创建一个开始吧。',
    colName: '名称',
    colDescription: '描述',
    colOutputs: '输出端口',
    colReadonly: '只读',
    loadingAgent: '加载代理中…',
    detailHint: '代理定义；保存会写入数据库。',
    saveButton: '保存修改',
    newTitle: '新建代理',
    newHint: '数据库是唯一真值源；这不是文件路径。',
    createButton: '创建代理',
  },
  skills: {
    title: '技能',
    hintBefore: '文件系统是真值源。',
    hintManaged: 'managed',
    hintMid: ' 类型存放于 ',
    hintManagedPath: '~/.agent-workflow/skills/',
    hintBetween: '；',
    hintExternal: 'external',
    hintAfter: ' 类型按 task 运行时 symlink 进来。',
    newButton: '+ 新建技能',
    emptyList: '还没有技能。',
    colName: '名称',
    colSource: '来源',
    colDescription: '描述',
    colPath: '路径',
    newTitle: '新建技能',
    newHintBefore: '选 ',
    newHintManaged: 'managed',
    newHintMid: ' 让框架完整托管，或选 ',
    newHintExternal: 'external',
    newHintAfter: ' 注册一个已存在的技能目录。',
    tabManaged: '托管',
    tabExternal: '外部',
    fieldName: '名称',
    fieldNameHint: 'kebab-case；用于 /skills/:name URL。',
    fieldDescription: '描述',
    fieldBody: 'SKILL.md 正文 (Markdown)',
    fieldExternalPath: '外部路径',
    fieldExternalPathHint: '指向一个已存在的技能目录的绝对路径。',
    externalPathPlaceholder: '/abs/path/to/skill-dir',
    createButton: '创建技能',
    deleteButton: '删除技能',
    saveDescription: '保存描述',
    saveBody: '保存正文',
    emptyBody: '（空）',
    bodySection: 'SKILL.md 正文',
    filesSection: '文件',
    descHintManaged: '可编辑；写入 SKILL.md frontmatter。',
    descHintExternal: '外部技能描述（仅写库）。',
  },
  workflows: {
    title: '工作流',
    hint: '由 agents 与 wrapper 构成的 DAG。每次启动 task 会快照当前 definition。',
    newButton: '+ 新建工作流',
    importButton: '导入 YAML',
    emptyList: '还没有工作流。',
    importedAsNew: '已作为新工作流导入。',
    workflowOverwritten: '工作流已覆盖。',
    importCanceled: '导入已取消。',
    conflictPrompt: 'Workflow id 冲突。输入 "overwrite" 覆盖，或 "new" 作为新工作流导入。',
    colName: '名称',
    colVersion: '版本',
    colId: 'ID',
  },
  tasks: {
    title: '任务',
    hint: '任务在隔离的 git worktree 中运行。点击行查看节点状态与 worktree diff。',
    filterAll: '全部',
    emptyList: '没有匹配当前过滤的任务。',
    colId: 'ID',
    colStatus: '状态',
    colStarted: '开始',
    colRepo: '仓库',
    colError: '错误',
    loadingTask: '加载任务中…',
    metaWorkflow: '工作流',
    metaRepo: '仓库',
    metaWorktree: 'Worktree',
    metaBranch: '分支',
    metaStarted: '开始',
    metaFinished: '完成',
    metaError: '错误',
    cancelButton: '取消任务',
    failedBanner: '任务失败。',
    jumpToFailed: '跳到失败节点 ({{nodeId}})',
    worktreePreserved:
      'Worktree 仍保留在 {{path}}。可手动检查；结束后执行 git worktree remove 清理。',
    sectionWorkflowStatus: '工作流状态',
    sectionNodeRuns: '节点运行',
    sectionWorktreeDiff: 'Worktree diff',
    noWorkflowSnapshot: '没有工作流快照。',
    noBaseCommit: '未记录 base commit；diff 不可用。',
    loadingDiff: '加载 diff 中…',
    noNodeRuns: '还没有节点运行；调度器还未触达任何节点。',
    colNode: '节点',
    colIteration: '轮次',
    colRetry: '重试',
    colDuration: '耗时',
    secondsAgo: '{{n}} 秒前',
    minutesAgo: '{{n}} 分钟前',
    hoursAgo: '{{n}} 小时前',
  },
  editor: {
    newTitle: '新建工作流',
    newHint: '从左侧面板拖拽节点到画布即可创建。',
    create: '创建',
    creating: '创建中…',
    fieldName: '名称',
    fieldDescription: '描述',
    loadingWorkflow: '加载工作流中…',
    statusSaving: '保存中…',
    statusUnsaved: '未保存',
    statusSaved: '已保存',
    launch: '启动任务 →',
    validate: '校验',
    validating: '校验中…',
    exportYaml: '导出 YAML',
    exportTitle: '下载为 YAML',
    remoteUpdated: '该工作流在其它端被更新（v{{version}}）；当前视图即将刷新。',
    remoteDeleted: '该工作流在其它端被删除。',
    remoteDismiss: '关闭',
    validationOk: '✓ 校验通过',
    validationIssues: '{{n}} 个问题',
    paletteFilter: '过滤面板…',
    paletteNoMatches: '没有匹配项。',
    paletteAgents: '代理',
    paletteFanOut: 'Fan-out',
    paletteFanOutDesc: '多进程（按 sourcePort 分片）',
    paletteAgentFallbackDesc: 'agent',
    paletteWrappers: '包装器',
    paletteWrapperGitLabel: 'git wrapper',
    paletteWrapperGitDesc: '在子节点前后快照 diff',
    paletteWrapperLoopLabel: 'loop wrapper',
    paletteWrapperLoopDesc: '重复执行子节点直到退出条件满足',
    paletteIo: 'IO',
    paletteInputLabel: 'input',
    paletteInputDesc: 'launcher 表单值',
    paletteOutputLabel: 'output',
    paletteOutputDesc: '任务详情页输出面板',
    menuPaste: '粘贴',
    menuSelectAll: '全选',
    menuDuplicate: '复制为新节点',
    menuCopy: '复制',
    menuWrapGit: '用 git wrapper 包装',
    menuWrapLoop: '用 loop wrapper 包装',
    menuDecompose: '解组 wrapper',
  },
  launch: {
    title: '启动：{{name}}',
    hintBefore: '选好仓库 + 分支，填好工作流 inputs，然后提交。提交时会在 ',
    hintCode: '~/.agent-workflow/worktrees/<repo>/<taskId>',
    hintAfter: ' 处创建一个 worktree。',
    backToEditor: '← 返回编辑器',
    fieldRepo: '仓库',
    fieldRepoHint: '从最近列表选一个，或粘贴绝对路径。',
    pickRepoPlaceholder: '— 选一个仓库 —',
    pasteRepoPath: '或粘贴绝对路径',
    fieldBaseBranch: '基线分支',
    baseBranchHint: '用作 worktree 的起点',
    pickBranchPlaceholder: '— 选一个分支 —',
    baseBranchPlaceholder: 'main',
    noInputs: '该工作流没有声明 inputs。',
    start: '启动任务',
    starting: '启动中…',
  },
  inspector: {
    closeAria: '关闭',
    tabEdit: '编辑',
    tabPreview: '预览',
    previewOnlyAgent: '仅 agent 节点支持预览。',
    resolvedInbound: '入边端口：',
    fieldInputKey: 'Input key',
    fieldInputKeyHint: '工作流内必须唯一。',
    fieldOutputPorts: '输出端口',
    fieldOutputPortsHint: '每个端口 = 任务详情页的一张卡片；绑定到 (nodeId, portName)。',
    portNamePlaceholder: '端口名',
    upstreamPlaceholder: '上游 nodeId',
    portPlaceholder: '端口',
    remove: '移除',
    addPort: '+ 增加端口',
    innerNodeIds: '内部节点 id',
    innerNodeIdsHint: '通过画布右键菜单组装。',
    none: '无',
    loopBanner: '跨轮次状态完全靠 worktree 文件流转。v1 没有反馈端口；agent 之间通过读写文件传递。',
    fieldMaxIterations: '最大迭代次数',
    fieldExitConditionKind: '退出条件类型',
    fieldExitConditionKindHint:
      'port-empty：trim 后为空 · port-equals：完全相等 · port-count-lt：行数 < n',
    fieldExitConditionTarget: '退出条件目标',
    fieldExitConditionTargetHint: '(nodeId, portName)，每轮检查',
    fieldExitConditionValue: '相等值',
    fieldExitConditionN: 'n',
    fieldExitConditionSeparator: "分隔符（默认 '\\n'）",
    fieldOutputBindings: '输出绑定',
    fieldOutputBindingsHint: '把内部端口暴露为 wrapper 的输出端口。',
    outputNamePlaceholder: '输出名',
    innerNodeIdPlaceholder: '内部 nodeId',
    addBinding: '+ 增加绑定',
    fieldAgent: '代理',
    fieldAgentHint: 'Fan-out 会按 sourcePort 把子运行切片。',
    pickAgent: '— 选一个代理 —',
    fieldSourcePort: 'sourcePort (nodeId.portName)',
    fieldPromptTemplate: 'Prompt 模板',
    fieldPromptTemplateHint: '使用 {{port_name}} 引用入边端口；内置变量如 {{__repo_path__}}。',
    fieldRetries: '重试次数',
    fieldRetriesHint: '默认 0',
    fieldTimeoutMs: '超时 (ms)',
    fieldTimeoutMsHint: '缺省走 settings.defaultPerNodeTimeoutMs',
    fieldModelOverride: '模型覆盖',
    modelPlaceholder: 'anthropic/claude-sonnet-4-6',
    fieldVariant: 'Variant',
    fieldTemperatureOverride: 'Temperature 覆盖',
    sourcePortNodePlaceholder: '上游 node id',
    sourcePortPlaceholder: '端口名',
  },
  promptPreview: {
    mockTitle: '模拟端口值',
    noPorts: '没有入边端口。增加一条入边后此处会列出。',
    assembledTitle: '拼好的 prompt',
  },
  agentForm: {
    fieldName: '名称',
    fieldNameHint: 'kebab-case；用于 /agents/:name URL。',
    fieldNamePlaceholder: '例如 code-fixer',
    fieldDescription: '描述',
    fieldDescriptionPlaceholder: '一行简介，会显示在列表中',
    fieldOutputs: '输出端口',
    fieldOutputsHint: '在 <port> envelope 中声明的端口名。',
    fieldOutputsPlaceholder: '输入端口名后按 Enter',
    outputsValidate: '只允许小写字母 + 下划线',
    fieldSkills: '技能',
    fieldSkillsHint: '框架运行时注入的技能名。',
    fieldSkillsPlaceholder: '输入技能名后按 Enter',
    fieldReadonly: '只读',
    fieldReadonlyHint: '只读 agent 可在同一 task 中并发；可写 agent 会串行。',
    fieldModel: 'Model',
    modelPlaceholder: 'anthropic/claude-sonnet-4-6',
    fieldVariant: 'Variant',
    fieldTemperature: 'Temperature',
    temperaturePlaceholder: '0–2',
    fieldSteps: 'Steps',
    fieldMaxSteps: 'Max steps',
    fieldPermission: 'Permission JSON',
    fieldPermissionHint: 'opencode permission 对象，透传。',
    permissionPlaceholder: '{"edit":"allow","webfetch":"deny"}',
    fieldFrontmatterExtra: '额外 frontmatter (JSON)',
    fieldFrontmatterExtraHint:
      '除 name/description/outputs/readonly/model/variant/temperature/steps/permission/skills 之外的其它键。',
    fieldBody: '正文 (Markdown)',
    bodyPlaceholder: 'Agent 系统提示词；Markdown。',
    rawBodySummary: '裸 markdown（无预览）',
  },
  nodeDrawer: {
    kindLabel: 'node_run',
    tabPrompt: 'Prompt',
    tabEvents: '事件',
    tabOutput: '输出',
    tabStats: '统计',
    shardCount: '{{n}} 个 shard',
    shardNoKey: '(无 key)',
    tokenPrefix: 'tok',
    promptPending: '该节点还没拼完 prompt（仍 pending）。',
    outputNone: '还没有捕获到输出。',
    statStatus: '状态',
    statStarted: '开始',
    statFinished: '完成',
    statDuration: '耗时',
    statExitCode: '退出码',
    statIteration: '轮次',
    statRetry: '重试',
    statTokensIn: '输入 tokens',
    statTokensOut: '输出 tokens',
    statTokensTotal: '总 tokens',
    statCacheCreate: '缓存创建',
    statCacheRead: '缓存读取',
    statError: '错误',
    statRetries: '重试列表',
    attempt: '第 {{n}} 次',
    noEventsMatch: '没有事件匹配当前过滤。',
  },
  taskOutputs: {
    section: '产出',
    pending: '等待中…',
  },
  settingsForm: {
    opencodePath: 'opencode 路径',
    opencodePathHint: '缺省走 PATH 上的 `which opencode`。',
    defaultModel: '默认 model',
    defaultModelHint: '没声明 model 的 agent 使用。',
    defaultVariant: '默认 variant',
    defaultTemperature: '默认 temperature',
    maxConcurrentNodes: '最大并发节点数',
    multiProcessConc: 'Multi-process 子进程并发',
    logLevel: '日志级别',
    perTaskDuration: '单 task 最大时长 (ms)',
    perTaskTokens: '单 task 最大 token 数',
    perNodeTimeout: '单节点超时 (ms)',
    largeOutputThreshold: '大输出阈值 (bytes)',
    zeroUnlimited: '0 = 无限制。',
    autoGcLabel: '自动 GC 已合并的 worktree',
    autoGcHint: '后台周期性任务；v1 默认关闭也无碍。',
    olderThanDays: 'GC 时间窗（天）',
    onlyMerged: '仅 GC 已合并分支',
    archivePerNodeRun: '事件归档 — 单 node_run 行数',
    archivePerNodeRunHint: '当某个 node_run 累计到此行数，归档为 JSONL。',
    archiveGlobal: '事件归档 — 全局行数',
    archiveGlobalHint: 'DB 全表事件行数上限；超过会触发归档。',
    bindHost: '监听 host',
    bindHostHint: '需要重启。默认 127.0.0.1 使 daemon 仅本机可达。',
    bindPort: '监听 port',
    bindPortHint: '需要重启。0 让启动时自动挑空闲端口。',
    daemonUrl: 'Daemon URL',
    tokenLabel: 'Token',
    tokenNone: '无',
    tokenMask: '{{prefix}}…{{suffix}}（共 {{len}} 字符）',
    signOut: '登出 / 重新输入 token',
    runtimeStatusTitle: 'opencode 运行状态',
    runtimeStatusProbing: '正在探测 opencode…',
    runtimeStatusOk: '兼容 — {{version}}',
    runtimeStatusIncompatible: '版本 {{version}} 低于最低要求 {{minVersion}}',
    runtimeStatusNotFound: '未找到 opencode 二进制或无法执行',
    runtimeStatusBinary: '二进制：{{path}}',
    runtimeStatusReprobe: '重新探测',
    runtimeStatusMinVersion: '最低 {{version}}',
    runtimeStatusHint: '红色状态请检查 opencode 路径字段。',
    modelLoadFailed: '模型列表加载失败 — 已降级为手动输入。',
    modelLoading: '加载模型列表…',
    modelRefresh: '刷新',
    modelCustom: '自定义…',
    modelCustomPlaceholder: 'provider/modelID',
    modelEmpty: '（空）',
  },
  enumPicker: {
    otherPlaceholder: '其它（自定义）…',
    add: '添加',
  },
  wrapperNode: {
    innerNodes: '{{n}} 个内部节点',
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

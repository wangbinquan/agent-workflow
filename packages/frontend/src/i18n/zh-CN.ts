// P-5-03 stage 1: zh-CN resource bundle.
//
// Source of truth for the Chinese UI. Keep keys flat under top-level sections
// (nav / auth / settings / errors). Newer routes can add their own section as
// we migrate them to t() — there is no migration script, but the key tree
// matches en-US 1:1.

export interface Resources {
  tabBar: {
    scrollStart: string
    scrollEnd: string
  }
  nav: {
    agents: string
    skills: string
    mcps: string
    plugins: string
    workflows: string
    workgroups: string
    tasks: string
    scheduled: string
    reviews: string
    clarify: string
    repos: string
    settings: string
    brand: string
    openMenu: string
    // RFC-032 PR1: home + group headers + runtime sub-item + settings gear.
    home: string
    group: {
      agents: string
      workflows: string
      tasks: string
      // RFC-041 PR4 follow-up: single-item "记忆" group header.
      memory: string
    }
    settingsIcon: {
      label: string
      tooltip: string
    }
    inbox: {
      label: string
      subtitle: string
      total: string
      partial: string
      filterAria: string
      tabAll: string
      tabReviews: string
      tabClarify: string
      loading: string
      empty: string
      emptyHint: string
      errorReviews: string
      errorClarify: string
      retry: string
      retryFeed: string
      sourceTask: string
      openReviews: string
      openClarify: string
      clarifyShardOrIter: string
      clarifySubtitle: string
      badgeAria: string
      triggerAriaWithCount: string
      shardLabel: string
      iterLabel: string
      // RFC-164 PR-6: workgroup to-dos third source.
      errorWorkgroups: string
      wgKind: string
      wgRow_one: string
      wgRow_other: string
      wgBreakdown: string
      itemAria: string
      workgroupItemAria: string
    }
    // RFC-041 PR4: top-level Memory route.
    memory: string
    memoryHint: string
    memoryBadge: string
    memoryPendingAction: string
  }
  home: {
    greet: {
      morning: string
      afternoon: string
      evening: string
    }
    startTask: string
    runtime: {
      checking: string
      noneEnabled: string
      aggregate: string
      aggregateWorst: string
      item: {
        ready: string
        readyNoVersion: string
        missing: string
      }
    }
    section: {
      running: string
      inbox: string
      recent: string
      viewAll: string
      openInbox: string
      viewTasks: string
      empty: {
        running: string
        inbox: string
        recent: string
      }
      error: {
        generic: string
        retry: string
      }
    }
    taskRow: {
      // RFC-150 PR-1 (W0 补做): status* 键族已并入 tasks.status.*（与
      // <TaskStatusChip> 同源），此处只剩相对时间文案。
      relativeJustNow: string
      relativeMinAgo: string
      relativeHourAgo: string
      relativeDayAgo: string
    }
    // RFC-190：能力门户首页——管线 hero / 脉搏行 / 能力卡片 / 任务动态。
    // 验收修订：管线图按真实业务流重画——快照/聚合是框架机制不是业务节点
    // （git wrapper 容器取 diff、多进程节点内建聚合），改为输入/输出 IO 节点
    // + GIT wrapper 框内编码 + 三审计扇入直进修复。
    pipeline: {
      input: string
      code: string
      audit: string
      fix: string
      output: string
      caption: string
      open: string
    }
    pulse: {
      line: string
      lineNoRate: string
    }
    newWorkflow: string
    cap: {
      agents: {
        title: string
        desc: string
        // 副行三段各自独立成键：某段计数为 null（无权限）时单独丢弃该段。
        sub: { skills: string; mcps: string; plugins: string }
      }
      workflows: { title: string; desc: string }
      workgroups: { title: string; desc: string }
      memory: { title: string; desc: string }
      scheduled: { title: string; desc: string }
      repos: { title: string; desc: string }
      countUnavailable: string
    }
    feed: {
      title: string
    }
  }
  mcps: {
    title: string
    newButton: string
    emptyList: string
    emptyDescription: string
    colName: string
    colType: string
    colDescription: string
    colEnabled: string
    typeLocal: string
    typeRemote: string
    disabledChip: string
    detailTabConfig: string
    detailTabProbe: string
    deleteButton: string
    deleteConfirm: string
    deleteReferenced: string
    newTitle: string
    fieldName: string
    fieldNameHint: string
    fieldDescription: string
    fieldType: string
    fieldEnabled: string
    fieldEnabledHint: string
    fieldCommand: string
    fieldCommandHint: string
    fieldEnv: string
    fieldEnvHint: string
    fieldTimeoutMs: string
    fieldUrl: string
    fieldUrlHint: string
    fieldHeaders: string
    fieldHeadersHint: string
    fieldOauth: string
    fieldOauthHint: string
    saveButton: string
    createButton: string
    toolNamingHint: string
    cwdHint: string
    oauthCliHint: string
    oauthModeAuto: string
    oauthModeDisabled: string
    errors: {
      nameRequired: string
      commandRequired: string
      urlRequired: string
      urlScheme: string
      timeoutInvalid: string
    }
    // RFC-030 — probe columns + expand block.
    colStatus: string
    colLatency: string
    colToolCount: string
    probe: {
      latencyMs: string
      latencySec: string
      btnRun: string
      btnRunning: string
      saveAndRun: string
      useSaved: string
      basisSavedTitle: string
      basisSavedBody: string
      basisDirtyTitle: string
      basisDirtyBody: string
      basisUnavailable: string
      resultStale: string
      savedResultExpired: string
      savedResultExpiredHint: string
      draftChangedDuringSave: string
      viewFull: string
      expandRow: string
      collapseRow: string
      expandNotProbed: string
      expandNoTools: string
      moreCount: string
      status: {
        unknown: string
        probing: string
        ok: string
        error: string
      }
      // Inventory panel (T9)
      lastProbed: string
      neverProbed: string
      neverProbedHint: string
      section: {
        tools: string
        resources: string
        prompts: string
        capabilities: string
      }
      tools: {
        empty: string
        descriptionEmpty: string
        showSchema: string
        hideSchema: string
        noInputSchema: string
      }
      resources: {
        empty: string
        templatesHeading: string
      }
      prompts: {
        empty: string
        argumentsHeading: string
        argumentRequired: string
      }
      capabilities: {
        empty: string
      }
      error: {
        title: string
        showDetail: string
        hideDetail: string
        // Mirror McpProbeErrorCode enum values.
        codeConnectFailed: string
        codeHandshakeFailed: string
        codeAuthRequired: string
        codeTimeout: string
        codePartial: string
        codeInternalError: string
        codeMcpDisabled: string
      }
    }
  }
  plugins: {
    title: string
    newButton: string
    emptyList: string
    emptyDescription: string
    colName: string
    colSpec: string
    colSource: string
    colVersion: string
    colEnabled: string
    disabledChip: string
    updateAvailableChip: string
    detailTabConfig: string
    detailTabUpdates: string
    formTitleNew: string
    formTitleEdit: string
    newTitle: string
    fieldName: string
    fieldSpec: string
    fieldSpecHint: string
    fieldDescription: string
    fieldOptions: string
    fieldOptionsHint: string
    fieldEnabled: string
    createButton: string
    creating: string
    saveButton: string
    saving: string
    cancelEdit: string
    checkUpdateButton: string
    saveAndCheckButton: string
    checking: string
    upgradeButton: string
    reinstallBaselineButton: string
    upgrading: string
    executionBasisDirtyTitle: string
    executionBasisDirtyBody: string
    executionBasisSavedTitle: string
    executionBasisSavedBody: string
    externalManagedTitle: string
    externalManagedBody: string
    notCheckedTitle: string
    notCheckedBody: string
    updateReadyTitle: string
    updateReadyBody: string
    noUpdateAvailable: string
    identityUnknownTitle: string
    identityUnknownBody: string
    draftChangedDuringSave: string
    staleOperationResult: string
    upgradeSuccess: string
    errorOptionsJson: string
    errors: {
      nameInvalid: string
      specRequired: string
      specTooLong: string
    }
    sourceKind: {
      npm: string
      file: string
      git: string
    }
  }
  reviews: {
    title: string
    emptyList: string
    emptyDescription: string
    filterPending: string
    filterAll: string
    filterApproved: string
    filterRejected: string
    filterIterated: string
    taskNameLabel: string
    colNode: string
    colStatus: string
    colVersion: string
    colCreated: string
    openButton: string
    statusAwaiting: string
    sidebarTitle: string
    sidebarEmpty: string
    sidebarCountLabel: string
    sidebarCollapse: string
    sidebarExpand: string
    sidebarJumpPrev: string
    sidebarJumpNext: string
    commentEdit: string
    commentCopy: string
    commentCopied: string
    commentCopyFailed: string
    commentSave: string
    commentEditCancel: string
    lineRef: string
    lineRefRange: string
    approveButton: string
    rejectButton: string
    iterateButton: string
    detailHint: string
    rejectPrompt: string
    rejectReasonRequired: string
    iterateConfirm: string
    iterateNoCommentsWarning: string
    approveDraftWarning: string
    approveDraftConfirm: string
    approveCommentWarning: string
    popoverPlaceholder: string
    popoverSubmit: string
    popoverCancel: string
    crossHeadingHint: string
    diffToggle: string
    diffOff: string
    diffGranularityWord: string
    diffGranularityLine: string
    diffGranularityBlock: string
    diffLeftLabel: string
    diffRightLabel: string
    // RFC-013: historical-version expand + read-only view.
    expand: string
    collapse: string
    historyHeader: string
    sidebarEmptyReadonly: string
    historicalBanner: string
    backToCurrent: string
    loadVersionsFailed: string
    retry: string
    currentTag: string
    unknownVersion: string
    downloadMarkdown: string
    downloadMarkdownTitle: string
    // Decision dialogs (replaces window.confirm / prompt / alert).
    approveDialogTitle: string
    iterateDialogTitle: string
    rejectDialogTitle: string
    rejectReasonLabel: string
    dialogConfirm: string
    dialogCancel: string
    // RFC-079: multi-document review mode.
    multiDoc: {
      documents: string
      accept: string
      notAccept: string
      pending: string
      accepted: string
      notAccepted: string
      approveProgress: string
      approveBlocked: string
      noComments: string
      badge: string
      acceptHint: string
      notAcceptHint: string
      shortcutHint: string
      changed: string
      changedHint: string
    }
    decision: {
      approved: string
      rejected: string
      iterated: string
      pending: string
      superseded: string
    }
    // RFC-142: 决策信息块（详情视图，历史 + 当前已决策版本）。
    decisionInfo: {
      decidedAt: string
      rejectReason: string
      supersededReason: string
      reasonMissing: string
      systemDecider: string
    }
    // RFC-142: 多文档评审分轮历史。
    roundLabel: string
    roundHistoryHeader: string
    roundDocCount: string
    historicalRoundBanner: string
    backToCurrentRound: string
    unknownRound: string
    rerunDirectUpstream: string
    decisionActionsAria: string
    plantumlUnknownError: string
    plantumlSyntaxErrorAtLine: string
    plantumlSyntaxErrorLineAndReason: string
    plantumlSyntaxErrorReasonOnly: string
    plantumlSyntaxErrorGeneric: string
    plantumlSeeSourceSuffix: string
    plantumlUnconfigured: string
    plantumlRendering: string
    plantumlRenderFailed: string
    plantumlPrivacyNotice: string
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
    // RFC-036 — multi-entrance login screen.
    subtitle: string
    username: string
    usernamePlaceholder: string
    password: string
    passwordPlaceholder: string
    signIn: string
    invalidCredentials: string
    or: string
    loginWith: string
    providerButtonHint: string
    useDaemonToken: string
    tabPassword: string
    tabOidc: string
    tabToken: string
    oidcHint: string
    oidcDiscoveryLoading: string
    oidcDiscoveryError: string
    oidcDiscoveryEmpty: string
    tokenHint: string
    brandTagline: string
    brandDescription: string
    localControl: string
    identityReady: string
    securityFooter: string
    secureAccess: string
    methodLabel: string
    passwordHint: string
    bootstrapTokenRequired: string
    bootstrapTokenHint: string
    continueSetup: string
    setupComplete: string
    noLoginMethod: string
    bootstrapStep: string
    bootstrapTitle: string
    bootstrapDescription: string
    bootstrapStepsLabel: string
    bootstrapStepAccount: string
    bootstrapStepRetire: string
    bootstrapStepLogin: string
    bootstrapOneWay: string
    confirmPassword: string
    passwordMismatch: string
    creatingAdmin: string
    completeHandoff: string
    bootstrapLoginTitle: string
    bootstrapLoginSubtitle: string
  }
  // RFC-036 — sidebar UserMenu dropdown.
  userMenu: {
    account: string
    users: string
    settings: string
    logout: string
    daemonAccess: string
    daemonRole: string
    tokenIssue: string
    signedOutHint: string
  }
  // RFC-036 — /account self-service page.
  account: {
    title: string
    profile: string
    username: string
    displayName: string
    role: string
    status: string
    source: string
    password: string
    passwordDesc: string
    oldPassword: string
    newPassword: string
    update: string
    passwordChanged: string
    pats: string
    patsDesc: string
    patName: string
    patNamePlaceholder: string
    patNameCol: string
    patScopes: string
    patStatus: string
    patShownOnce: string
    copy: string
    generate: string
    revoke: string
    unlink: string
    noPats: string
    sessions: string
    sessionsDesc: string
    sessionId: string
    userAgent: string
    noSessions: string
    linkedIdentities: string
    identitiesDesc: string
    provider: string
    subject: string
    noIdentities: string
    patScopesLabel: string
    patSelectAll: string
    patSelectDefault: string
    patSelectNone: string
    patNoScopes: string
    patStatusActive: string
    patStatusRevoked: string
    patGroup: {
      spa: string
      tasks: string
      resourceRead: string
      admin: string
    }
    patScope: {
      accountSelf: { label: string; desc: string }
      usersSearch: { label: string; desc: string }
      runtimeRead: { label: string; desc: string }
      tasksLaunch: { label: string; desc: string }
      tasksReadOwn: { label: string; desc: string }
      tasksCancelOwn: { label: string; desc: string }
      agentsRead: { label: string; desc: string }
      skillsRead: { label: string; desc: string }
      mcpsRead: { label: string; desc: string }
      pluginsRead: { label: string; desc: string }
      workflowsRead: { label: string; desc: string }
      reposRead: { label: string; desc: string }
      usersRead: { label: string; desc: string }
      usersWrite: { label: string; desc: string }
      settingsRead: { label: string; desc: string }
      settingsWrite: { label: string; desc: string }
      tasksReadAll: { label: string; desc: string }
    }
    pleaseSignIn: string
    pleaseSignInDescription: string
    sectionGroup: string
    sectionNavLabel: string
    sections: {
      overview: string
      security: string
      tokens: string
    }
    sectionDescriptions: {
      overview: string
      security: string
      tokens: string
    }
    oidcManaged: string
    localAccount: string
    sources: {
      session: string
      pat: string
      daemon: string
    }
    localIdentityTitle: string
    localIdentityDescription: string
    linkedAt: string
    technicalIdentity: string
    oidcPasswordTitle: string
    oidcPasswordDescription: string
    noSessionsDescription: string
    unknownClient: string
    lastActive: string
    expires: string
    revokeSessionTitle: string
    revokeSessionDescription: string
    tokensRetiredTitle: string
    tokensRetiredDescription: string
    noPatsDescription: string
    created: string
    lastUsed: string
    neverUsed: string
    noExpiry: string
    scopeCount: string
    viewScopes: string
    revokePatTitle: string
    revokePatDescription: string
    roles: {
      admin: string
      user: string
    }
  }
  // RFC-036 — /users admin page.
  users: {
    title: string
    new: string
    summary: string
    empty: string
    emptyDescription: string
    filteredEmpty: string
    filteredEmptyDescription: string
    filtersLabel: string
    searchLabel: string
    searchPlaceholder: string
    statusFilterLabel: string
    roleFilterLabel: string
    filterAll: string
    allRoles: string
    directoryLabel: string
    username: string
    displayName: string
    email: string
    noEmail: string
    role: string
    status: string
    manage: string
    you: string
    neverSignedIn: string
    signedInSuffix: string
    ownership: {
      oidc: string
      awaitingOidc: string
      local: string
    }
    systemTitle: string
    systemDescription: string
    systemTokenRetired: string
    disable: string
    enable: string
    cancel: string
    password: string
    saving: string
    create: {
      title: string
      submit: string
      accountType: string
      passwordMode: string
      passwordModeDescription: string
      ssoMode: string
      ssoModeDescription: string
      ssoEmailHint: string
      localEmailHint: string
      passwordHint: string
      ssoNoEmailNotice: string
    }
    edit: {
      title: string
    }
    roleOption: {
      user: string
      admin: string
      manager: string
      userDesc: string
      adminDesc: string
      managerDesc: string
    }
    statusOption: {
      active: string
      invited: string
      disabled: string
    }
    selfRoleLocked: string
    selfDisableLocked: string
    credentialsTitle: string
    credentialsOidcDescription: string
    credentialsLocalDescription: string
    oidcResetUnavailable: string
    resetPassword: string
    setPasswordAndActivate: string
    accessTitle: string
    disableDescription: string
    enableDescription: string
    passwordLoginDisabledNotice: string
    reset: {
      title: string
      activateTitle: string
      submit: string
      newPassword: string
      confirmPassword: string
      passwordMismatch: string
      forceChange: string
      forceChangeHint: string
      sessionsWarning: string
    }
    disableTitle: string
    disableConfirm: string
    enableTitle: string
    enableConfirm: string
    notice: {
      'created-password': string
      'created-sso': string
      updated: string
      reset: string
      disabled: string
      enabled: string
    }
    noPermission: {
      title: string
      body: string
    }
  }
  repos: {
    title: string
    loading: string
    empty: string
    emptyDescription: string
    colUrl: string
    colLocalPath: string
    colLastFetched: string
    colLastAutoRefresh: string
    colRefs: string
    colActions: string
    refresh: string
    delete: string
    cancel: string
    confirmDelete: string
    deleteConfirmTitle: string
    deleteConfirmBody: string
    batchImport: {
      button: string
      title: string
      placeholder: string
      start: string
      cancel: string
      close: string
      again: string
      colIndex: string
      colUrl: string
      colStatus: string
      colDetail: string
      colActions: string
      statusQueued: string
      statusCloning: string
      statusDoneCold: string
      statusDoneHit: string
      statusDoneHitFetchFail: string
      statusFailed: string
      retry: string
      retryWithEdit: string
      batchEmpty: string
      batchTooLarge: string
      promptOverrideUrl: string
    }
    submodule: {
      labelOk: string
      labelError: string
      titleOk: string
      labelPending: string
      titlePending: string
      errorFallback: string
    }
  }
  settings: {
    title: string
    sectionNavLabel: string
    sectionGroups: {
      execution: string
      reliability: string
      access: string
      interface: string
    }
    sectionDescriptions: {
      runtime: string
      systemAgents: string
      limits: string
      recovery: string
      gc: string
      git: string
      network: string
      appearance: string
      rendering: string
      authentication: string
    }
    tabRuntime: string
    tabSystemAgents: string
    tabLimits: string
    tabRecovery: string
    tabGc: string
    tabGit: string
    tabNetwork: string
    tabAppearance: string
    tabMemory: string
    tabRendering: string
    tabAuthentication: string
    loading: string
    saving: string
    saved: string
    save: string
    noChanges: string
    invalidChanges: string
    outcomeUnknown: string
    outcomeUnknownBody: string
    outcomeUnknownReconcile: string
    writeBlockedBody: string
    staleTitle: string
    staleBody: string
    staleDiscard: string
    backupTitle: string
    backupHint: string
    backupCreate: string
    backupRunning: string
    backupSavedAs: string
    restoreHint: string
    restoreButton: string
    restoreBusy: string
    restoreStaged: string
    restoreConfirmTitle: string
    restoreConfirmBody: string
    restoreConfirmAction: string
    restorePendingTitle: string
    restorePendingBody: string
    restorePendingSizeUnknown: string
    restorePendingCancel: string
    restoreFailedTitle: string
    restoreFailedBody: string
    restoreFailedNoError: string
    restoreFailedDirHint: string
    themeLabel: string
    themeHint: string
    themeSystem: string
    themeLight: string
    themeDark: string
    languageLabel: string
    languageHint: string
    languageZhCN: string
    languageEnUS: string
    commitPushLangLabel: string
    commitPushLangHint: string
    commitPushLangDefault: string
    commitPushLangZhCN: string
    commitPushLangEnUS: string
    memoryDistillLangLabel: string
    memoryDistillLangHint: string
    memoryDistillLangDefault: string
    memoryDistillLangZhCN: string
    memoryDistillLangEnUS: string
    memoryDistillModelLabel: string
    memoryDistillModelHint: string
    memoryDistillRuntimeLabel: string
    memoryDistillRuntimeHint: string
    runtimeInherit: string
    // RFC-156 — "System agents" tab: per-card titles + one-line role hints for the
    // internal framework agents, plus the fusion card's own runtime field.
    systemAgents: {
      commitPushTitle: string
      commitPushHint: string
      memoryTitle: string
      memoryHint: string
      mergeTitle: string
      mergeHint: string
      fusionTitle: string
      fusionHint: string
      fusionRuntime: string
      fusionRuntimeHint: string
    }
    restartRequiredTitle: string
    restartRequiredHint: string
    renderingPlantumlEndpointLabel: string
    renderingPlantumlEndpointHint: string
    renderingPlantumlEndpointPlaceholder: string
    renderingPlantumlAuthLabel: string
    renderingPlantumlAuthHint: string
    renderingPlantumlAuthPlaceholder: string
    renderingTestButton: string
    renderingTestRunning: string
    renderingTestSuccess: string
    renderingTestFailure: string
    renderingTestEmptyEndpoint: string
    renderingTestUnknownError: string
    renderingTestTimeout: string
    // RFC-036 — Authentication tab (OIDC providers admin).
    auth: {
      loginMethodsTitle: string
      loginMethodsHint: string
      passwordLoginLabel: string
      passwordLoginHint: string
      passwordLoginLockedHint: string
      bootstrapTokenLabel: string
      bootstrapTokenHint: string
      bootstrapPending: string
      bootstrapRetired: string
      lastProviderRequired: string
      disablePasswordTitle: string
      disablePasswordDescription: string
      disablePasswordConfirm: string
      providersTitle: string
      providersHint: string
      add: string
      empty: string
      colSlug: string
      colName: string
      colIssuer: string
      colProvisioning: string
      colEnabled: string
      enabled: string
      disabled: string
      edit: string
      delete: string
      deleteConfirm: string
      addTitle: string
      editTitle: string
      testConnection: string
      cancel: string
      save: string
      groupProvider: string
      groupProviderHint: string
      slug: string
      slugHint: string
      displayName: string
      displayNameHint: string
      issuerUrl: string
      issuerUrlHint: string
      groupManualEndpoints: string
      groupManualEndpointsHint: string
      authorizationEndpoint: string
      tokenEndpoint: string
      userinfoEndpoint: string
      userinfoRequestStyle: string
      userinfoRequestStyleHint: string
      userinfoStyleGet: string
      userinfoStylePost: string
      jwksUri: string
      groupCreds: string
      groupCredsHint: string
      clientId: string
      clientSecret: string
      clientSecretEditHint: string
      scopes: string
      scopesHint: string
      groupBehavior: string
      provisioning: string
      optInvite: string
      optAllowlist: string
      optAuto: string
      inviteDesc: string
      allowlistDesc: string
      autoDesc: string
      allowedDomains: string
      allowedDomainsHint: string
      trustEmailLabel: string
      trustEmailHint: string
      usernameClaim: string
      usernameClaimHint: string
      subjectClaim: string
      subjectClaimHint: string
      enabledLabel: string
      enabledHint: string
      testOk: string
      testFail: string
      testReady: string
      testNotReady: string
      testDiscoveryOk: string
      testDiscoveryDown: string
      testDiscoveryError: string
      testDetailIssuer: string
      sourceManual: string
      sourceDiscovery: string
      testEndpointMissing: string
      testJwksUnreachable: string
    }
    // RFC-205 T5 — Settings → Runtime sandbox status chip + sandboxMode control.
    sandbox: {
      title: string
      chipActive: string
      chipUnavailable: string
      chipOff: string
      modeLabel: string
      modeEnforce: string
      modeWarn: string
      modeOff: string
      modeHint: string
      enforceUnavailable: string
    }
  }
  onboarding: {
    title: string
    intro: string
    // RFC-190：首跑 hero（管线动画 + 平台能力开场白）。
    heroTitle: string
    heroIntro: string
    // RFC-211：首跑卡片只保留唯一主行动——进入引导。
    startCta: string
    tracksIntro: string
    skipLink: string
  }
  // RFC-211 §12 手把手 spotlight tour。
  tour: {
    ariaLabel: string
    progress: string
    goToPage: string
    skip: string
    back: string
    next: string
    done: string
    firstTask: {
      openAgents: { title: string; body: string }
      newAgent: { title: string; body: string }
      name: { title: string; body: string }
      portsTab: { title: string; body: string }
      addPort: { title: string; body: string }
      saveAgent: { title: string; body: string }
      launch: { title: string; body: string }
      submit: { title: string; body: string }
      result: { title: string; body: string }
      seedTaskName: string
      seedTaskPrompt: string
    }
    buildWorkflow: {
      openWorkflows: { title: string; body: string }
      newWorkflow: { title: string; body: string }
      template: { title: string; body: string }
    }
    useWorkgroup: {
      openWorkgroups: { title: string; body: string }
      newWorkgroup: { title: string; body: string }
      addMember: { title: string; body: string }
      launch: { title: string; body: string }
    }
  }
  // RFC-211 引导式沙盒。
  guide: {
    title: string
    handholdIntro: string
    startTour: string
    track: {
      agent: string
      agentDesc: string
      workflow: string
      workflowDesc: string
      workgroup: string
      workgroupDesc: string
    }
  }
  common: {
    searchEllipsis: string
    searchCards: string
    noMatches: string
    retry: string
    clearSearch: string
    clearFilters: string
    backToList: string
    redirectingToLogin: string
    itemsCount_one: string
    itemsCount_other: string
    loading: string
    open: string
    edit: string
    delete: string
    save: string
    saved: string
    saving: string
    creating: string
    unknownError: string
    resumeFailedAfterSubmit: string
    yes: string
    no: string
    details: string
    emDash: string
    shaRangeLabel: string
    updated: string
    /** RFC-191: <RelativeTime> tokens（列表层相对时间口径，双向）。 */
    relTime: {
      justNow: string
      minAgo: string
      hourAgo: string
      dayAgo: string
      inMin: string
      inHour: string
      inDay: string
    }
    /** RFC-192: duration tokens（任务耗时列）。 */
    dur: {
      sec: string
      min: string
      hourMin: string
      dayHour: string
    }
    /** RFC-191: gallery card行内主动作（工作流/工作组「启动」）。 */
    launch: string
    launchResource: string
    /** A stable-id subject link landed on a missing/invisible resource. */
    resourceUnavailable: string
    copy: string
    copied: string
    empty: string
    optionalPlaceholder: string
    confirmPrompt: string
    confirmDelete: string
    deleteConfirm: {
      title: string
      body: string
      inputLabel: string
    }
    close: string
    cancel: string
    selectAnOption: string
    ariaActions: string
    ariaExpandColumn: string
    removeAria: string
    duplicateError: string
    invalidJson: string
    jsonMustBeObject: string
    emptyResource: string
    startedAt: string
    finishedAt: string
    // Shared <ClampedText> fold toggle.
    expandText: string
    collapseText: string
  }
  // RFC-173: shared <MultiSelect> tag combobox (resource pickers).
  multiSelect: {
    empty: string
    addCustom: string
    searchHint: string
  }
  splitPage: {
    dirtyDot: string
    noDescription: string
    itemsCount_one: string
    itemsCount_other: string
    kind: {
      agent: string
      skill: string
      mcp: string
      plugin: string
    }
    unsavedTitle: string
    unsavedBody: string
    unsavedBusyBody: string
    unsavedForceLeave: string
    unsavedForceLeaveWarning: string
    unsavedStay: string
    unsavedDiscard: string
    emptyPaneTitle: string
    emptyPaneHint: string
  }
  runtimes: {
    title: string
    subtitle: string
    add: string
    protocolOpencode: string
    protocolClaude: string
    defaultBinary: string
    smokeUntested: string
    test: string
    edit: string
    delete: string
    deleteTitle: string
    deleteDescription: string
    addTitle: string
    editTitle: string
    testBinary: string
    testing: string
    fieldName: string
    fieldNameHint: string
    fieldProtocol: string
    fieldProtocolHint: string
    fieldBinary: string
    fieldBinaryHint: string
    fieldConfigDirEnv: string
    fieldConfigDirEnvHint: string
    fieldConfigDirName: string
    fieldConfigDirNameHint: string
    configDirEnvInvalid: string
    configDirEnvReserved: string
    configDirNameInvalid: string
    fieldModel: string
    fieldModelHint: string
    modelRequired: string
    modelRequiredChip: string
    fieldVariant: string
    fieldTemperature: string
    fieldSteps: string
    fieldMaxSteps: string
    claudeModelOnlyHint: string
    newRuntimeModelHint: string
    claudeStaticModelHint: string
    isDefault: string
    setDefault: string
    enable: string
    disable: string
    disabled: string
    defaultCannotDisable: string
    smoke: {
      conforms: string
      'spawn-failed': string
      'auth-missing': string
      'network-blocked': string
      'model-call-failed': string
      'stream-nonconforming': string
      'execution-identity-failed': string
    }
  }
  agents: {
    title: string
    newButton: string
    emptyList: string
    emptyDescription: string
    cardPorts: string
    colName: string
    colDescription: string
    colOutputs: string
    colRuntime: string
    runtimeDefaultTag: string
    builtin: string
    loadingAgent: string
    saveButton: string
    newTitle: string
    createButton: string
  }
  skills: {
    title: string
    newButton: string
    emptyList: string
    emptyDescription: string
    cardVersion: string
    colName: string
    colSource: string
    colDescription: string
    colPath: string
    newTitle: string
    tabManaged: string
    tabExternal: string
    detailTabEdit: string
    detailTabFiles: string
    detailTabHistory: string
    technicalInformation: string
    managedPath: string
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
    tabFolder: string
    fieldFolderPath: string
    fieldFolderPathHint: string
    fieldFolderLabel: string
    fieldFolderLabelHint: string
    folderPathPlaceholder: string
    createFolderButton: string
    sourcesTitle: string
    sourcesEmpty: string
    sourceChildCount: string
    sourceLastScannedAt: string
    sourceNeverScanned: string
    sourceRescan: string
    sourceRemove: string
    sourceRemoveConfirmTitle: string
    sourceRemoveConfirmBlocked: string
    sourceSkippedBanner: string
    sourceConflictReplace: string
    sourceConflictNoPermission: string
    sourceSkippedDetails: string
    sourceFromPill: string
    sourceReadonlyHint: string
    tabZip: string
    importTitle: string
    importSubtitle: string
    zipDropTitle: string
    zipDropHint: string
    zipChoose: string
    zipReplace: string
    zipRemove: string
    zipStructureTitle: string
    zipManagedHint: string
    zipWrongType: string
    zipTooLarge: string
    zipCheck: string
    zipChecking: string
    zipCheckingStatus: string
    zipRetry: string
    zipImportButton: string
    zipImporting: string
    zipReviewSummary: string
    zipCandidatesCount: string
    zipConflictsCount: string
    zipArchiveErrorsCount: string
    zipArchiveErrorsTitle: string
    zipNoCandidatesTitle: string
    zipNoCandidates: string
    zipStatusReady: string
    zipDescriptionEmpty: string
    zipCandidateFacts: string
    zipActionFor: string
    zipRenameFor: string
    zipActionImport: string
    zipActionSkip: string
    zipActionOverwrite: string
    zipActionRename: string
    zipOverwriteTargetFor: string
    zipOverwriteTargetPlaceholder: string
    zipOverwriteTargetOption: string
    zipVisibilityPublic: string
    zipVisibilityPrivate: string
    zipRenameTo: string
    zipRenameEmpty: string
    zipRenameInvalid: string
    zipRenameDup: string
    zipRenameConflict: string
    zipConflictManaged: string
    zipConflictManagedReadonly: string
    zipNamesLoading: string
    zipNamesUnavailable: string
    zipNamesStale: string
    zipActionSummary: string
    zipOverwriteWarning: string
    zipBack: string
    zipResultSuccess: string
    zipResultPartial: string
    zipResultNoWrite: string
    zipResultFile: string
    zipResultCreatedCount: string
    zipResultUpdatedCount: string
    zipResultSkippedCount: string
    zipResultFailedCount: string
    zipResultFailures: string
    zipResultCreated: string
    zipResultUpdated: string
    zipResultSkipped: string
    zipResultFailed: string
    zipResultCreatedChip: string
    zipResultUpdatedChip: string
    zipContinue: string
    zipReturnList: string
    zipOpenSkill: string
    fileDiscardConfirm: string
    fileTargetUnavailable: string
    fileErrPathRequired: string
    fileErrRelativeOnly: string
    fileErrMainFileProtected: string
    fileErrAlreadyExists: string
    fileTreeHeader: string
    fileTreeEmpty: string
    fileNewPathPlaceholder: string
    fileAddButton: string
    fileStageAddButton: string
    fileEditorEmpty: string
    fileLoadingNamed: string
    fileDeleteButton: string
    fileStageDeleteButton: string
    filePendingCreate: string
    filePendingUpdate: string
    filePendingDelete: string
    fileUndoPending: string
    fileDeleteStagedTitle: string
    fileDeleteStagedDescription: string
    fileStaleWarning: string
    saveAllChanges: string
    saveNothingToSave: string
    saveStageNewPathFirst: string
    saveBusy: string
    saveTokenMissing: string
    saveOutcomeUnknown: string
    saveOutcomeUnknownDescription: string
    saveOutcomeStillUnknown: string
    recheckOutcome: string
    recheckingOutcome: string
    saveRemoteDifferent: string
    saveStaleWarning: string
    saveAllComplete: string
    savePartial: string
    discardAllChanges: string
    historyBlockedTitle: string
    historyBlockedDirty: string
    historyBlockedBusy: string
    historyBlockedOutcomeUnknown: string
    zipParseFailedFallback: string
    zipCommitFailedFallback: string
    zipErrorWholeArchiveLabel: string
    versionsSection: string
    versionsEmpty: string
    versionLabel: string
    versionCurrent: string
    versionSourceInitial: string
    versionSourceEditor: string
    versionSourceFusion: string
    versionSourceRestore: string
    versionRestoredFrom: string
    versionCompare: string
    versionRestore: string
    versionRestoreConfirm: string
    versionDiffTitle: string
    versionBy: string
    versionRestoreReasonPlaceholder: string
    versionRestoreFusionNote: string
  }
  fusion: {
    launchButton: string
    launchFromSkillButton: string
    launchTitle: string
    fieldSkill: string
    fieldSkillHint: string
    pickSkillPlaceholder: string
    noManagedSkills: string
    fieldMemories: string
    fieldMemoriesHint: string
    noSelectableMemories: string
    selectedCount: string
    fieldIntent: string
    fieldIntentHint: string
    intentPlaceholder: string
    submit: string
    submitting: string
    needSkill: string
    needMemories: string
    detailTitle: string
    backToSkill: string
    status: {
      running: string
      awaiting_approval: string
      applying: string
      done: string
      rejected: string
      canceled: string
      failed: string
    }
    iteration: string
    runningHint: string
    clarifyLink: string
    proposedHeading: string
    changelogHeading: string
    incorporatedHeading: string
    skippedHeading: string
    approve: string
    approving: string
    reject: string
    rejectTitle: string
    rejectFeedbackPlaceholder: string
    rejectSubmit: string
    cancel: string
    cancelConfirm: string
    appliedVersion: string
    fusedChip: string
    errorHeading: string
  }
  workflows: {
    title: string
    cardKind: string
    newButton: string
    createButton: string
    fieldNameHint: string
    importButton: string
    emptyList: string
    emptyDescription: string
    importedAsNew: string
    workflowOverwritten: string
    importCanceled: string
    conflictPrompt: string
    importDialog: {
      title: string
      dropTitle: string
      dropDescription: string
      chooseFile: string
      replaceFile: string
      removeFile: string
      import: string
      importing: string
      retry: string
      refreshConflict: string
      another: string
      chooseAnother: string
      conflictTitle: string
      conflictDescription: string
      conflictChoiceLabel: string
      choiceNew: string
      choiceOverwrite: string
      resolveReferences: string
      resolveReferencesHint: string
      resultTitle: string
    }
    /** RFC-191 gallery card meta —「{{count}} 节点」chip. */
    cardNodes_one: string
    cardNodes_other: string
    /** RFC-191 — italic placeholder when a workflow has no description. */
    noDescription: string
    errors: {
      nameRequired: string
      nameInvalid: string
    }
  }
  // RFC-164 — workgroup resource pages (list + quick-create dialog / detail).
  workgroups: {
    title: string
    cardKind: string
    newButton: string
    emptyList: string
    emptyDescription: string
    modeLeaderWorker: string
    modeFreeCollab: string
    modeDynamicWorkflow: string
    /** RFC-191 gallery card meta —成员数 / Leader / 全自动。 */
    cardMembers_one: string
    cardMembers_other: string
    cardLeader: string
    humanMemberChip: string
    cardAddAgent: string
    cardSelectLeader: string
    cardNoWorkers: string
    noDescription: string
    newTitle: string
    createButton: string
    renameButton: string
    renameTitle: string
    renameField: string
    sectionBasics: string
    sectionMode: string
    sectionMembers: string
    sectionSwitches: string
    fieldName: string
    fieldNameHint: string
    fieldDescription: string
    fieldInstructions: string
    fieldInstructionsHint: string
    fieldMode: string
    modeHintLeaderWorker: string
    modeHintFreeCollab: string
    modeHintDynamicWorkflow: string
    // Launch-readiness banner (shared workgroupLaunchReadiness reasons).
    readiness: {
      noAgentMember: string
      agentMissing: string
      leaderMissing: string
      noNonLeaderWorker: string
    }
    // Member gallery + context panel (detail page, RFC-168).
    membersEmpty: string
    memberTypeAgent: string
    memberTypeHuman: string
    memberRemove: string
    setLeaderButton: string
    leaderBadge: string
    addAgentMember: string
    addHumanMember: string
    addAgentTitle: string
    addHumanTitle: string
    addMemberConfirm: string
    panelConfigTitle: string
    panelAria: string
    panelClose: string
    actionsTitle: string
    renameActionHint: string
    aclActionHint: string
    deleteActionHint: string
    memberSave: string
    saveAll: string
    finishAddingBeforeSave: string
    editAgentDefinition: string
    agentMissing: string
    portsIn: string
    portsOut: string
    portsCountBadge_one: string
    portsCountBadge_other: string
    configSaved: string
    autosave: {
      groupLabel: string
      phaseBlocked: string
      invalidTitle: string
      invalidBody: string
      transientTitle: string
      transientBody: string
      errorTitle: string
      errorBody: string
      inaccessibleTitle: string
      inaccessibleBody: string
      deletedTitle: string
      deletedBody: string
      returnToList: string
    }
    memberFieldAgent: string
    memberFieldUser: string
    memberFieldDisplayName: string
    memberFieldRole: string
    memberAgentPlaceholder: string
    memberUserPlaceholder: string
    memberDisplayNamePlaceholder: string
    memberRolePlaceholder: string
    fieldShareOutputs: string
    fieldShareOutputsHint: string
    fieldDirectMessages: string
    fieldDirectMessagesHint: string
    fieldBlackboard: string
    fieldBlackboardHint: string
    fcSwitchesNotice: string
    fieldMaxRounds: string
    fieldMaxRoundsHint: string
    fieldCompletionGate: string
    fieldCompletionGateHint: string
    fieldCompletionGateNoHumanHint: string
    fieldClarifyBudget: string
    fieldClarifyBudgetHint: string
    fieldClarifyBudgetNoHumanHint: string
    fieldFanOut: string
    fieldFanOutHint: string
    // RFC-164 PR-4 — detail-page launch entry + /workgroups/launch page.
    launchButton: string
    launch: {
      title: string
      backToGroup: string
      missingGroup: string
      fieldGoal: string
      fieldGoalHint: string
      advanced: string
      maxDurationMin: string
      maxDurationMinHint: string
      maxTotalTokens: string
      maxTotalTokensHint: string
      start: string
      notReady: string
      humanMembersUnsupported: string
      invalidPayload: string
    }
    // RFC-167 PR-3 — dynamic-workflow orchestration panel (tasks.detail).
    dw: {
      title: string
      generating: string
      rejectionFeedback: string
      awaiting: string
      attemptsUsed: string
      gateTitle: string
      approve: string
      reject: string
      rejectTitle: string
      rejectCommentLabel: string
      rejectCommentHint: string
      rejectSubmit: string
      saveAs: string
      saveAsTitle: string
      saveAsNameLabel: string
      saveAsDescLabel: string
      saveAsSubmit: string
      saved: string
      executing: string
      executingDone: string
      executingFailed: string
      canceledNotice: string
      exhausted: string
      previewEmpty: string
      canvasPending: string
    }
    // RFC-164 PR-4 — workgroup task chat room (tasks.detail default tab).
    room: {
      empty: string
      roundDivider: string
      authorSystem: string
      assignedTo: string
      resultSummary: string
      viewRun: string
      cancelCard: string
      composerPlaceholder: string
      send: string
      sending: string
      terminalNotice: string
      mentionsAria: string
      composerShortcutHint: string
      deliverShortcutHint: string
      membersTitle: string
      working: string
      idle: string
      openMemberSession: string
      executing: string
      memberExecuting: string
      presenceQueued: string
      presenceAwaiting: string
      activeRunsBadge: string
      turnKindLeader: string
      turnKindMessage: string
      turnKindAssignment: string
      removedMember: string
      clarifySuppressedNote: string
      clarifyStopped: string
      clarifyResume: string
      runLogTitle: string
      runLogEmpty: string
      backToLatest: string
      // 2026-07-21 —— awaiting_human 成因说明卡（wgPause 槽 → room.pauseReason）。
      pauseTitle: string
      pause: {
        maxRoundsWrapup: string
        leaderIdle: string
        leaderClarify: string
        clarifyOrDelivery: string
        engineStall: string
      }
      gateTitle: string
      gateAwaiting: string
      gateConfirm: string
      gateReject: string
      // PR-5: live gate — reject requires a comment (dialog).
      gateRejectTitle: string
      gateRejectCommentLabel: string
      gateRejectCommentHint: string
      gateRejectSubmit: string
      // PR-5: human delivery (拍板 #16 双形态).
      deliverTodo: string
      deliverQuick: string
      deliverQuickPlaceholder: string
      deliverForm: string
      deliverFormTitle: string
      deliverSummaryLabel: string
      deliverDetailLabel: string
      deliverSubmit: string
      // PR-5: mid-run config dialog.
      configButton: string
      configTitle: string
      configSubmit: string
      configEmptyHint: string
      configMembersTitle: string
      configWillRemove: string
      configUndoRemove: string
      configNewChip: string
      // PR-5: free_collab task-list panel.
      fcListTitle: string
      fcOpen: string
      fcActive: string
      fcDone: string
      fcEmpty: string
      fcBatch: string
      infoTitle: string
      infoGoal: string
      infoMode: string
      infoMaxRounds: string
      infoMemberTurnBudget: string
      memberTurnBudgetValue: string
      memberTurnBudgetHint: string
      infoSwitches: string
      assignmentStatus: {
        open: string
        dispatched: string
        running: string
        awaiting_human: string
        delivered: string
        done: string
        failed: string
        canceled: string
      }
      source: {
        leader: string
        human: string
        self_claim: string
        system: string
      }
    }
    errors: {
      nameRequired: string
      nameInvalid: string
      agentNameRequired: string
      userRequired: string
      displayNameRequired: string
      displayNameInvalid: string
      displayNameTooLong: string
      displayNameDuplicate: string
      leaderMustBeAgent: string
      maxRoundsInvalid: string
      dynamicNoHumanMembers: string
    }
  }
  scheduled: {
    repairBadge: string
    title: string
    empty: string
    emptyDescription: string
    new: string
    colName: string
    colSchedule: string
    colNext: string
    colStatus: string
    colEnabled: string
    enabledYes: string
    enabledNo: string
    lastNever: string
    last_launched: string
    last_failed: string
    /** RFC-192: list row —— last-run task link + consecutive-failure chip. */
    lastTaskLink: string
    consecutiveChip: string
    saveAsScheduled: string
    dialogTitle: string
    fieldName: string
    fieldMode: string
    fieldEvery: string
    fieldUnit: string
    fieldAt: string
    fieldDays: string
    fieldDayOfMonth: string
    dayOfMonthHint: string
    tzNote: string
    modeInterval: string
    modeDaily: string
    modeWeekly: string
    modeMonthly: string
    unitMinutes: string
    unitHours: string
    unitDays: string
    dow: { 0: string; 1: string; 2: string; 3: string; 4: string; 5: string; 6: string }
    preview: string
    save: string
    saving: string
    cancel: string
    runHistory: string
    noRuns: string
    autoDisabled: string
    runNow: string
    edit: string
    editTitle: string
    enable: string
    disable: string
    delete: string
    deleteConfirm: string
    uploadUnsupported: string
    editConfig: string
    degradedBanner: string
    editConfigTitle: string
    saveConfig: string
    backToSchedule: string
    collabLoadError: string
  }
  tasks: {
    failure: Record<string, string | Record<string, string>>
    title: string
    newButton: string
    filterAll: string
    emptyList: string
    emptyDescription: string
    colId: string
    colName: string
    /** RFC-192: the execution-subject column (工作流/工作组/单代理). */
    colSubject: string
    colStatus: string
    colStarted: string
    colRepo: string
    colError: string
    /** RFC-192: duration-cell prefixes + repo-count / scheduled-origin chips. */
    durationRunning: string
    durationWaiting: string
    repoCountChip: string
    scheduledChip: string
    /** RFC-192: subject Segmented filter labels. */
    subjectFilter: {
      all: string
      workflow: string
      workgroup: string
      agent: string
    }
    detailTitleIdLabel: string
    loadingTask: string
    metaWorkflow: string
    metaRepo: string
    metaRepoUrl: string
    metaRepoCachePath: string
    metaWorktree: string
    metaBranch: string
    metaBaseBranch: string
    metaWorkingBranch: string
    metaWorkingBranchNone: string
    metaAutoCommitPushOn: string
    commitPushNode: string
    commitViewSession: string
    commitSessionTitle: string
    commitOutcomePushed: string
    commitOutcomeLocalAuth: string
    commitOutcomeLocalFailed: string
    commitOutcomeSubrepoFailed: string
    subrepoPushed: string
    subrepoNotPushed: string
    commitOutcomeSkippedEmpty: string
    commitFiles: string
    metaStarted: string
    metaFinished: string
    metaError: string
    /** RFC-066: multi-repo summary `<details>` label on the task detail page. */
    multiRepoSummary: string
    cancelButton: string
    relaunchButton: string
    resumeButton: string
    resuming: string
    syncWorkflow: {
      bannerTitle: string
      bannerHint: string
      button: string
      dialogTitle: string
      versionLabel: string
      unknownVersion: string
      confirm: string
      cancel: string
      syncing: string
      invalidTitle: string
      blockerTitle: string
      sectionAdded: string
      sectionRemoved: string
      sectionModified: string
      sectionWarnings: string
      warn: {
        'removed-node-feeds-downstream': string
        'dangling-input-port': string
        'new-upstream-into-completed-node': string
      }
      blocker: {
        'wrapper-structure-changed-with-live-state': string
      }
    }
    resumeUnavailableNoWorktree: string
    /** RFC-164/167: turn-engine group tasks (lw / fc) can't resume in place — relaunch instead. */
    resumeUnavailableWorkgroup: string
    resumeLaunchLink: string
    failedBanner: string
    jumpToFailed: string
    diagnose: {
      bannerErrorTitle: string
      bannerWarningTitle: string
      bannerCount_one: string
      bannerCount_other: string
      bannerRulesSummary: string
      bannerButton: string
      panelTitle: string
      rescan: string
      rescanning: string
      close: string
      loading: string
      empty: string
      detailDisclosureLabel: string
      col: {
        rule: string
        severity: string
        detectedAt: string
        detail: string
        actions: string
      }
      severity: {
        warning: string
        error: string
      }
      rule: {
        R1: string
        R2: string
        C1: string
        T1: string
        T2: string
        T3: string
        U1: string
        'CR-1': string
        S1: string
        S2: string
        S3: string
        S4: string
        S5: string
        S6: string
      }
      // RFC-057: UI strings for the repair dialog + confirm modal. The
      // option-specific labels (R1.approveRun.label / etc.) live at root
      // `diagnose.repair.*` to match what backend emits.
      repair: {
        openButton: string
        dialogTitle: string
        confirmTitle: string
        confirmLead: string
        confirmApply: string
        applying: string
        closeAfterFailure: string
        applyFailedBanner: string
        applyFailedDetail: string
        cancel: string
        next: string
        loading: string
        empty: string
        optionPickerLabel: string
        destructive: string
        risk: {
          low: string
          medium: string
          high: string
        }
        unavailable: {
          generic: string
        }
      }
    }
    reviewButton: string
    clarifyButton: string
    worktreePreserved: string
    recovery: {
      title: string
      quarantineTitle: string
      quarantined: string
      clearQuarantine: string
      summary: string
      expand: string
      collapse: string
      kind: {
        'boot-reap': string
        'periodic-reap': string
        'shutdown-flip': string
        'limit-cancel': string
        'snapshot-lost': string
        'live-child-survived': string
        'auto-resume': string
        'auto-repair': string
        'heartbeat-kill': string
        quarantine: string
      }
    }
    stuckBadge: string
    sectionWorkflowStatus: string
    sectionNodeRuns: string
    sectionWorktreeDiff: string
    /** RFC-021 tab labels (replace the `section*` headings inside the new
     *  tab bar). Old keys stay in the type because i18n consumers may
     *  still reference them as fallback strings. */
    tabWorkflowStatus: string
    tabNodeRuns: string
    tabDetails: string
    tabOutputs: string
    tabWorktreeFiles: string
    tabWorktreeDiff: string
    tabWorktreeStructure: string
    sectionNavLabel: string
    sectionGroupOverview: string
    sectionGroupExecution: string
    sectionGroupArtifacts: string
    sectionGroupCollaboration: string
    structScopeLabel: string
    structScopeTask: string
    structPruned: string
    structReadonlyNode: string
    structEmpty: string
    structDegradedBanner: string
    structDegradedChip: string
    structParseError: string
    structFileNoSymbolChanges: string
    structCardFiles: string
    structCardClasses: string
    structCardMethods: string
    structCardFields: string
    structCardImports: string
    structCardDependencies: string
    structDepsHeader: string
    structImpactHeader: string
    structImpactInferred: string
    structImpactExtracted: string
    structEngineLabel: string
    structEngineBaseline: string
    structEngineDeep: string
    structDegradedDeepFallback: string
    structViewLabel: string
    structViewTree: string
    structViewGraph: string
    structViewImpact: string
    structViewDeps: string
    structViewCallChain: string
    structCallChainEntry: string
    structCallPick: string
    structCallNoCalls: string
    structCallExternal: string
    structCallUnresolved: string
    structCallCycle: string
    structCallTruncated: string
    structCallExpand: string
    structCallCollapse: string
    structCallMode: string
    structCallModeTree: string
    structCallModeSequence: string
    structSeqTitle: string
    structCallSeqTruncated: string
    structBodyDeltaTitle: string
    structGraphEmpty: string
    structGraphLegendAdded: string
    structGraphLegendModified: string
    structGraphLegendRemoved: string
    structGraphLegendCaller: string
    structGraphLegendHint: string
    structGraphEdgeInherits: string
    structGraphEdgeReferences: string
    structGraphEdgeCalls: string
    structGraphLevelLabel: string
    structGraphLevelPackage: string
    structGraphLevelClass: string
    structGraphPkgClasses: string
    structGraphCallers: string
    structViaImportManifest: string
    structRenamedFrom: string
    structSigChanged: string
    structJumpToDiff: string
    structExplainAdded: string
    structExplainRemovedPublic: string
    structExplainRemovedPrivate: string
    structExplainRenamed: string
    structExplainMoved: string
    structExplainSig: string
    structExplainBody: string
    structSevBreaking: string
    structSevRisky: string
    structSevSafe: string
    structSevUnknownVis: string
    structSortLabel: string
    structSortName: string
    structSortSeverity: string
    structFilterLabel: string
    structCardBreaking: string
    structWalkthroughTitle: string
    structWalkthroughMore: string
    tabFeedback: string
    tabQuestions: string
    // RFC-164 PR-4: workgroup chat room tab + tasks-list workgroup badge.
    tabChatroom: string
    // RFC-167 PR-3: dynamic-workflow orchestration tab.
    tabDwOrchestration: string
    workgroupBadge: string
    /** RFC-165: single-agent task subject badge (mirror of workgroupBadge). */
    agentBadge: string
    /** Workflow task subject badge — the third kind, so the column labels all
     *  three subjects instead of leaving workflow rows bare. */
    workflowBadge: string
    worktreeFilesEmpty: string
    worktreeFilesNoWorktree: string
    worktreeFilesOversized: string
    worktreeFilesTruncated: string
    worktreeFilesLoadError: string
    worktreeFilesFileError: string
    worktreeFilesSizeHeader: string
    worktreeFilesRefresh: string
    worktreeFilesDownload: string
    worktreeFilesDownloading: string
    worktreeFilesDownloadError: string
    worktreeFilesTreeAria: string
    noWorkflowSnapshot: string
    noBaseCommit: string
    loadingDiff: string
    diffNoChanges: string
    diffTruncatedBanner: string
    diffViewedProgress: string
    diffFileSelectorLabel: string
    structFileSelectorLabel: string
    diffMarkViewed: string
    noNodeRuns: string
    colNode: string
    colIteration: string
    colRetry: string
    colDuration: string
    status: {
      pending: string
      running: string
      done: string
      failed: string
      canceled: string
      interrupted: string
      awaiting_review: string
      awaiting_human: string
    }
  }
  editor: {
    newTitle: string
    fieldName: string
    fieldDescription: string
    renameButton: string
    renameTitle: string
    loadingWorkflow: string
    statusSaving: string
    statusUnsaved: string
    statusSaved: string
    launch: string
    preparingLaunch: string
    validate: string
    validating: string
    exportYaml: string
    exporting: string
    exportTitle: string
    actionsTitle: string
    renameActionHint: string
    aclActionHint: string
    deleteActionHint: string
    deleteTitle: string
    deleteDescription: string
    actionDraftChanged: string
    actionRevisionMismatch: string
    remoteUpdated: string
    remoteDeleted: string
    remoteDismiss: string
    validationOk: string
    validationIssues: string
    validationWarnings: string
    validationStaleDraft: string
    validationStaleInventory: string
    validationAutoFitWrapper: string
    validationSummaryOk: string
    validationBadgeErrors: string
    validationBadgeWarnings: string
    validationSummaryErrors: string
    validationSummaryWarnings: string
    validationSummaryStale: string
    validationDetailsTitle: string
    validationRevalidate: string
    validationTargetChanged: string
    validationTargetUnavailable: string
    validationGoToIssue: string
    paletteFilter: string
    paletteNoMatches: string
    emptyCanvas: {
      title: string
      description: string
      addFirst: string
      startTemplate: string
    }
    nodePicker: {
      title: string
      addButton: string
      searchLabel: string
      searchPlaceholder: string
      recommended: string
      recent: string
      all: string
      categoriesLabel: string
      categoryAll: string
      categoryAgent: string
      categoryWrapper: string
      categoryIo: string
      categoryHuman: string
      noMatches: string
      resultsCount: string
      resultsCountInCategory: string
      dragHint: string
    }
    starter: {
      title: string
      standardTitle: string
      standardDescription: string
      auditTitle: string
      auditDescription: string
      blankTitle: string
      blankDescription: string
      apply: string
      applying: string
      confirmReplace: string
      replaceWarning: string
      chooseAgent: string
      preview: string
      validating: string
      valid: string
      invalid: string
      role: {
        coder: string
        auditor: string
        aggregator: string
        fixer: string
      }
      issue: {
        'role-unmapped': string
        'agent-missing': string
        'aggregator-role-required': string
        'data-output-required': string
      }
      copy: {
        requestLabel: string
        artifactLabel: string
        inputTitle: string
        coderTitle: string
        gitTitle: string
        fanoutTitle: string
        auditorTitle: string
        aggregatorTitle: string
        fixerTitle: string
        outputTitle: string
      }
    }
    nodeActions: {
      addNext: string
      connectNext: string
      copy: string
      more: string
      addInside: string
      insertOnEdge: string
    }
    connectionDialog: {
      title: string
      sourcePort: string
      targetNode: string
      inputMode: string
      newInput: string
      reuseInput: string
      targetPort: string
      domainChannel: string
      fanoutInput: string
      fanoutOutput: string
      fanoutEndpoint: string
      fanoutKind: string
      fanoutRole: string
      fanoutShard: string
      fanoutBroadcast: string
      fanoutDemotes: string
      preview: string
      apply: string
      applied: string
      inserted: string
      replaces: string
      incomplete: string
      compatibility: {
        compatible: string
        incompatible: string
        unknown: string
      }
    }
    paletteAgents: string
    paletteFanOut: string
    paletteFanOutDesc: string
    paletteAgentFallbackDesc: string
    paletteWrappers: string
    paletteWrapperGitLabel: string
    paletteWrapperGitDesc: string
    paletteWrapperLoopLabel: string
    paletteWrapperLoopDesc: string
    /** RFC-060 — wrapper-fanout palette entry. */
    paletteWrapperFanoutLabel: string
    paletteWrapperFanoutDesc: string
    paletteIo: string
    paletteInputLabel: string
    paletteInputDesc: string
    paletteOutputLabel: string
    paletteOutputDesc: string
    paletteHuman: string
    paletteReviewLabel: string
    paletteReviewDesc: string
    paletteClarifyLabel: string
    paletteClarifyDesc: string
    menuPaste: string
    menuSelectAll: string
    menuDuplicate: string
    menuCopy: string
    menuWrapGit: string
    menuWrapLoop: string
    menuDecompose: string
    boxSelectHint: string
    layoutToolbar: string
    layoutAll: string
    layoutSelection: string
    menuSelectedCount: string
    nodeTitleUnsetAgent: string
    nodeTitleUnsetKey: string
    history: {
      undo: string
      redo: string
      undoIntent: string
      redoIntent: string
      canvasEdit: string
      delete: string
      connect: string
      paste: string
      duplicate: string
      wrap: string
      unwrap: string
      fitWrapper: string
      insert: string
      applyStarter: string
      autoLayout: string
      move: string
      rename: string
      editInspector: string
    }
    draftStatus: {
      groupLabel: string
      phaseAria: string
      transportAria: string
      phase: {
        clean: string
        dirty: string
        saving: string
        reconciling: string
        error: string
        conflict: string
        inaccessible: string
        deleted: string
      }
      transport: {
        online: string
        degraded: string
        offline: string
      }
      retryNow: string
      offlineTitle: string
      offlineBody: string
      reconcilingTitle: string
      reconcilingBody: string
      errorTitle: string
      errorBody: string
      conflictTitle: string
      conflictBody: string
      saveCopyRecommended: string
      saveCopy: string
      loadRemote: string
      overwriteRemote: string
      loadDialogTitle: string
      loadDialogBody: string
      loadDialogConfirm: string
      overwriteDialogTitle: string
      overwriteDialogBody: string
      overwriteDialogConfirm: string
      inaccessibleTitle: string
      inaccessibleBody: string
      deletedTitle: string
      deletedBody: string
      exportLocal: string
      retryAccess: string
      returnToList: string
    }
  }
  taskWizard: {
    launchEntry: string
    title: string
    titleScheduled: string
    titleEdit: string
    stepMode: string
    stepSpace: string
    stepContent: string
    stepConfirm: string
    kindLabel: string
    kindWorkflow: string
    kindAgent: string
    kindWorkgroup: string
    kindHintWorkflow: string
    kindHintAgent: string
    kindHintWorkgroup: string
    objectWorkflow: string
    objectAgent: string
    objectWorkgroup: string
    objectPlaceholder: string
    objectEmpty: string
    workgroupNotReady: string
    workgroupLeaderOnlyWarning: string
    spaceLabel: string
    spaceRemote: string
    spaceScratch: string
    spaceScratchDesc: string
    spaceRemoteDesc: string
    spaceScratchHint: string
    contentDescription: string
    contentDescriptionHint: string
    agentPortsBlocked: string
    agentNotFound: string
    portKindHint: string
    agentPortBlockedSignal: string
    agentPortBlockedName: string
    advanced: string
    allowClarify: string
    allowClarifyHint: string
    maxDurationMin: string
    maxDurationMinHint: string
    maxTotalTokens: string
    maxTotalTokensHint: string
    edit: string
    launch: string
    saveScheduled: string
    saveConfig: string
    limitInvalid: string
    summaryCollaborators: string
    clarifyOn: string
    kindLocked: string
    degradedBanner: string
    spaceUnresolvedNotice: string
    workflowVersionMismatchTitle: string
    workflowVersionMismatchBody: string
    workflowVersionReturnToEditor: string
    workflowVersionUseLatest: string
    workflowLaunchVersionMismatchBody: string
    scheduledWorkflowLatestTitle: string
    scheduledWorkflowLatestBody: string
  }
  stepper: {
    progress: string
    back: string
    next: string
  }
  launch: {
    title: string
    backToEditor: string
    fieldTaskName: string
    fieldTaskNameHint: string
    errorTaskNameRequired: string
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
    repoNoCommits: string
    upload: {
      dropTitle: string
      chooseFiles: string
      selectedCount_one: string
      selectedCount_other: string
      removeFile: string
      targetDirHint: string
      acceptHint: string
      maxSizeHint: string
      minHint: string
      maxHint: string
    }
    repoSource: {
      bar: string
      path: string
      url: string
      urlField: string
      urlHint: string
      urlPlaceholder: string
      urlInvalid: string
      refField: string
      refHint: string
      refPlaceholder: string
      recentUrlsPlaceholder: string
      cloningHint: string
      /** RFC-068: hint shown under the URL-mode ref field. */
      urlAutoSync: string
      /** RFC-066: + button label and remove button label per row. */
      add: string
      remove: string
      /** RFC-066: "Will mount as <name>/" preview chip shown only in multi-repo mode. */
      previewDirName: string
      /** RFC-066: + button disabled hint at MULTI_REPO_MAX. */
      maxReached: string
      /** RFC-066: banner under the list explaining why multi-repo combos are gated. */
      multiRepoBlocked: {
        'wrapper-git': string
        upload: string
      }
    }
    /** RFC-068 — path-mode opt-in `git fetch` switch (default off). */
    pathFetch: {
      label: string
      switchLabel: string
      switchHint: string
    }
    /**
     * RFC-067 — optional per-task Git commit identity. Toggle is rendered
     * collapsed by default. Both fields blank → daemon default identity;
     * both filled → runner injects GIT_AUTHOR_* / GIT_COMMITTER_*.
     * pairingError / emailInvalid surface as inline alerts.
     */
    gitIdentity: {
      toggle: string
      name: string
      email: string
      hint: string
      pairingError: string
      emailInvalid: string
    }
    workingBranch: {
      label: string
      hint: string
      placeholder: string
      invalid: string
    }
    autoCommitPush: {
      label: string
      hint: string
    }
    rawInputPlaceholder: string
    inputTooLong: string
    filesPicker: {
      pickRepoFirst: string
      loading: string
      filterPlaceholder: string
      selectedCount: string
      minSuffix: string
      maxSuffix: string
      kindSuffix: string
      moreHint: string
      cacheSnapshotHint: string
      urlFallbackHint: string
      extraSelectedHint: string
    }
    gitPicker: {
      branchLabel: string
      fromLabel: string
      toLabel: string
      prLabel: string
      currentRefOption: string
      urlFallbackHint: string
    }
  }
  inspector: {
    closeAria: string
    tabEdit: string
    tabPreview: string
    previewOnlyAgent: string
    resolvedInbound: string
    fieldInputKey: string
    fieldInputKeyHint: string
    fieldInputKeyRequired: string
    fieldInputKeyDuplicate: string
    fieldInputKind: string
    fieldInputKindHint: string
    fieldInputLabel: string
    fieldInputLabelHint: string
    fieldInputRequired: string
    fieldInputDescription: string
    fieldInputDescriptionHint: string
    upload: {
      targetDir: string
      targetDirHint: string
      targetDirError: string
      accept: string
      acceptHint: string
      maxFileSize: string
      maxFileSizeHint: string
      minCount: string
      maxCount: string
    }
    fieldNodeTitle: string
    fieldNodeTitleHint: string
    fieldReviewDescription: string
    fieldReviewDescriptionHint: string
    fieldReviewInputSourceNode: string
    fieldReviewInputSourceNodeHint: string
    fieldReviewInputSourcePort: string
    fieldReviewInputSourcePortHint: string
    fieldReviewRerunReject: string
    fieldReviewRerunRejectHint: string
    fieldReviewRerunIterate: string
    fieldReviewRerunIterateHint: string
    fieldReviewRerunInvalid: string
    fieldReviewRollbackReject: string
    fieldReviewRollbackRejectLabel: string
    fieldReviewRollbackIterate: string
    fieldReviewRollbackIterateLabel: string
    fieldReviewCommentTemplate: string
    fieldReviewCommentTemplateHint: string
    fieldOutputPorts: string
    fieldOutputPortsHint: string
    portNamePlaceholder: string
    upstreamPlaceholder: string
    portPlaceholder: string
    remove: string
    addPort: string
    innerNodeIds: string
    innerNodeIdsHint: string
    /** RFC-060 — wrapper-fanout inspector. */
    fanoutInputs: string
    fanoutInputsHint: string
    fanoutInputNamePlaceholder: string
    fanoutInputShardSource: string
    fanoutInputShardSourceMustBeList: string
    fanoutInputAdd: string
    fanoutInputRemove: string
    /** RFC-060 — placeholder shown on a fanout input row with no inbound edge. */
    fanoutInputUnwired: string
    fanoutDerivedOutputs: string
    fanoutDerivedOutputsHint: string
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
    addBinding: string
    loopExitNodeIdSelect: string
    loopExitPortNameSelect: string
    loopExitInvalidNodeId: string
    loopExitInvalidPortName: string
    fieldAgent: string
    pickAgent: string
    fieldPromptTemplate: string
    fieldPromptTemplateHint: string
    edgeTitle: string
    edgeSourceLabel: string
    edgeTargetLabel: string
    edgePortNameLabel: string
    edgePortFixedHint: string
    edgeConflictMsg: string
    edgeReconnectBtn: string
    edgeDeleteBtn: string
    nodePortSummary: string
    technicalKind: string
    technicalId: string
    sectionBasics: string
    sectionFlow: string
    sectionAdvanced: string
    sectionTechnical: string
    missingRefsLabel: string
    missingRefsHint: string
    // RFC-023 clarify node inspector
    fieldClarifyDescription: string
    fieldClarifyDescriptionHint: string
    fieldClarifyLinkedAgent: string
    clarifyLinkedAgentMissing: string
    clarifyLinkedAgentHint: string
    fieldClarifyInLoop: string
    clarifyInLoopYes: string
    clarifyInLoopNo: string
    // RFC-026 clarify session mode (inline vs isolated)
    fieldClarifySessionMode: string
    clarifySessionModeIsolated: string
    clarifySessionModeInline: string
    clarifySessionModeHint: string
    missingOption: string
  }
  promptPreview: {
    mockTitle: string
    noPorts: string
    assembledTitle: string
  }
  kindSelect: {
    baseLabel: string
    base_string: string
    base_markdown: string
    base_signal: string
    base_path: string
    description_string: string
    description_markdown: string
    description_signal: string
    description_path: string
    extLabel: string
    ext_any: string
    ext_md: string
    listToggle: string
    extPlaceholder: string
    extError: string
    advancedToggle: string
    guidedToggle: string
    parseError: string
    signalHint: string
  }
  capabilityCard: {
    inputs: string
    outputs: string
    prompt: string
    required: string
    noneDeclared: string
  }
  agentForm: {
    /** RFC-169 — right-rail tab labels (replaced the RFC-155 collapsible sections). */
    tabsAria: string
    tabBasics: string
    tabPrompt: string
    tabPorts: string
    tabResources: string
    tabAdvanced: string
    portValidationBadge: string
    resourcesIntro: string
    technicalDetailsSummary: string
    technicalDetailsBody: string
    /** RFC-155 — form-section titles (visible + collapsible groups). */
    sectionBasics: string
    sectionPrompt: string
    sectionOutputs: string
    sectionDependencyGraph: string
    sectionResources: string
    sectionAdvanced: string
    fieldName: string
    fieldNameHint: string
    fieldNamePlaceholder: string
    fieldDescription: string
    fieldDescriptionPlaceholder: string
    fieldInputs: string
    fieldInputsHint: string
    inputKindLabel: string
    inputRequired: string
    inputRequiredLabel: string
    fieldOutputs: string
    fieldOutputsHint: string
    outputKindLabel: string
    outputKind_string: string
    outputKind_markdown: string
    outputKind_markdown_file: string
    ports: {
      direction: {
        input: string
        output: string
      }
      actions: {
        edit: string
        delete: string
        confirmDelete: string
      }
      card: {
        customKind: string
        legacy: string
        duplicate: string
        noDescription: string
        required: string
        wrapperSameName: string
        wrapperDuplicate: string
        normalOutput: string
        inactiveWrapperMap: string
      }
      validation: {
        compactTitle: string
        detailTitle: string
        target: {
          ports: string
          advanced: string
        }
        severity: {
          error: string
          warning: string
        }
        issue: {
          inputNameSchema: string
          inputNameLaunchBlocked: string
          inputNameDuplicate: string
          outputNameDuplicate: string
          outputKindInvalid: string
          wrapperNameDuplicate: string
          reservedPortSidecarKey: string
          orphanOutputKind: string
          orphanWrapperName: string
        }
      }
      inputsTitle: string
      inputsRelation: string
      outputsTitle: string
      outputsRelation: string
      count: string
      addInput: string
      addOutput: string
      inputsEmptyTitle: string
      inputsEmptyDescription: string
      outputsEmptyTitle: string
      outputsEmptyDescription: string
      addInputDialogTitle: string
      editInputDialogTitle: string
      addOutputDialogTitle: string
      editOutputDialogTitle: string
      fieldName: string
      fieldKind: string
      fieldRequired: string
      fieldDescription: string
      fieldDescriptionHint: string
      fieldWrapperName: string
      fieldWrapperNameHint: string
      saveAdd: string
      saveEdit: string
      cancel: string
      editInput: string
      editOutput: string
      deleteInput: string
      deleteOutput: string
      confirmDeleteInput: string
      confirmDeleteOutput: string
      requiredChip: string
      noDescription: string
      wrapperSame: string
      wrapperMapping: string
      legacyChip: string
      duplicateChip: string
      renameWarning: string
      legacyWarning: string
      errorRequired: string
      errorFormat: string
      errorTooLong: string
      errorDuplicate: string
      errorWrapperDuplicate: string
      errorKindInvalid: string
      errorOrphanConflict: string
      errorStale: string
      orphanTitle: string
      orphanDescription: string
      orphanKind: string
      orphanWrapper: string
      cleanupOrphan: string
      confirmCleanupOrphan: string
      validationTitle: string
      validationCompactTitle: string
      navigatePorts: string
      navigateAdvanced: string
      issueInputNameSchema: string
      issueInputNameDuplicate: string
      issueOutputNameDuplicate: string
      issueOutputKindInvalid: string
      issueWrapperNameDuplicate: string
      issueReservedPortSidecarKey: string
      issueOrphanOutputKind: string
      issueOrphanWrapperName: string
    }
    groupCapabilities: string
    groupCapabilitiesHint: string
    groupDependencies: string
    groupDependenciesHint: string
    fieldSkills: string
    fieldSkillsHint: string
    fieldSkillsPlaceholder: string
    skillsPickerLoading: string
    skillsPickerEmpty: string
    skillsPickerLoadFailed: string
    fieldDependsOn: string
    fieldDependsOnHint: string
    fieldDependsOnPlaceholder: string
    dependsPickerLoading: string
    dependsPickerEmpty: string
    dependsPickerLoadFailed: string
    fieldMcps: string
    fieldMcpsHint: string
    fieldMcpsPlaceholder: string
    mcpsPickerLoading: string
    mcpsPickerEmpty: string
    mcpsPickerLoadFailed: string
    fieldPlugins: string
    fieldPluginsHint: string
    fieldPluginsPlaceholder: string
    pluginsPickerLoading: string
    pluginsPickerEmpty: string
    pluginsPickerLoadFailed: string
    fieldSyncOutputsOnIterate: string
    fieldSyncOutputsOnIterateHint: string
    /** RFC-060 PR-B — agent role flavor selector (normal / aggregator). */
    fieldRole: string
    fieldRoleHint: string
    roleNormal: string
    roleAggregator: string
    fieldOutputWrapperPortNames: string
    fieldOutputWrapperPortNamesHint: string
    /** RFC-111 — per-agent runtime selector + opencode-only field hint. */
    fieldRuntime: string
    fieldRuntimeHint: string
    runtimeInherit: string
    runtimeOpencode: string
    runtimeClaudeCode: string
    fieldPermission: string
    fieldPermissionHint: string
    permissionPlaceholder: string
    fieldFrontmatterExtra: string
    fieldFrontmatterExtraHint: string
    jsonSyntaxError: string
    jsonObjectError: string
    jsonValidationTitle: string
    jsonValidationBadge: string
    jsonErrorStatus: string
    jsonFixField: string
    fieldBody: string
    bodyPlaceholder: string
    importButton: string
    autodetect: {
      button: string
      dialogTitle: string
      dialogHint: string
      emptyText: string
      groupLoadFailed: string
      groupName: {
        agents: string
        skills: string
        mcps: string
        plugins: string
      }
      section: {
        agents: string
        skills: string
        mcps: string
        plugins: string
      }
      cancelButton: string
      applyButton: string
      closeButton: string
    }
    importDialog: {
      title: string
      tabUpload: string
      tabPaste: string
      pastePlaceholder: string
      cancelButton: string
      orphanConflict: string
      invalidExtension: string
      fileReadFailed: string
      sourcePaste: string
      sourceUpload: string
      emptyValue: string
      bodySummary: string
      inputSummary: string
      listSummary: string
      mapSummary: string
      ruleSummary: string
      extraLabel: string
      checkButton: string
      checkingFile: string
      backButton: string
      applyDraftButton: string
      importAnother: string
      viewForm: string
      selectTitle: string
      selectDescription: string
      uploadTitle: string
      uploadDescription: string
      chooseFile: string
      replaceFile: string
      removeFile: string
      pasteLabel: string
      pasteHint: string
      draftOnlyTitle: string
      draftOnlyHint: string
      reviewTitle: string
      itemCount: string
      sectionCount: string
      warningCount: string
      fixPortsButton: string
      overwriteTitle: string
      overwriteDescription: string
      warningTitle: string
      resolveReferences: string
      previewEmptyTitle: string
      previewEmptyDescription: string
      resultTitle: string
      resultDescription: string
      resultNextStep: string
      notCreated: string
    }
    markdownEditLabel: string
    markdownPreviewLabel: string
    markdownPreviewEmpty: string
  }
  // RFC-022: shared visual for the agent dependsOn closure (DependencyTree
  // component + buildDependencyTree helper). Used by AgentForm edit preview
  // and node-run Stats tab; keys live in a top-level section so both call
  // sites import them via `t('dependencyTree.X')`.
  dependencyTree: {
    /** Skill names chip — shown only when the agent declares skills[]. */
    skills: string
    /** RFC-030 follow-up: MCP names chip — shown only when the agent declares mcp[]. */
    mcps: string
    /** RFC-031: plugin names chip — shown only when the agent declares plugins[]. */
    plugins: string
    seeAbove: string
    cycleHeading: string
    ariaTreeLabel: string
    missingPrefix: string
    maskedPrefix: string
    openAgentAria: string
  }
  dependencyTreePreview: {
    emptyHint: string
    loading: string
    errorSelf: string
    errorNotFound: string
    errorGeneric: string
  }
  nodeDrawer: {
    kindLabel: string
    tabPrompt: string
    tabSession: string
    tabEvents: string
    tabOutput: string
    tabStats: string
    eventCount: string
    outputCount: string
    sessionPending: string
    sessionNotApplicable: string
    sessionFanoutParent: string
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
    statWgRound: string
    statTokensIn: string
    statTokensOut: string
    statTokensTotal: string
    statCacheCreate: string
    statCacheRead: string
    statError: string
    statHistory: string
    iterLoop: string
    iterReview: string
    iterClarify: string
    iterCrossClarify: string
    iterRetry: string
    iterInitial: string
    statDependencyTree: string
    attempt: string
    noEventsMatch: string
    retryButton: string
    retrying: string
    retryCascadeLabel: string
    promptAttemptLabel: string
    promptAttemptEntry: string
    promptAttemptShard: string
    promptAttemptParent: string
    promptFanoutParent: string
    promptNotApplicable: string
    promptEmpty: string
    injectedMemoriesTitle: string
    injectedMemoriesEmpty: string
    injectedMemoriesNotCaptured: string
    injectedMemoriesInheritedFromAttempt0: string
    injectedMemoriesGroup_agent: string
    injectedMemoriesGroup_workflow: string
    injectedMemoriesGroup_repo: string
    injectedMemoriesGroup_global: string
    injectedMemoriesVersionLabel: string
    inventory: {
      title: string
      pending: string
      empty: string
      chip: { agents: string; skills: string; mcps: string; plugins: string }
      subtitle: { agents: string; skills: string; mcps: string; plugins: string }
      col: {
        name: string
        mode: string
        model: string
        source: string
        path: string
        desc: string
        status: string
        type: string
        hint: string
        specifier: string
      }
      source: { inline: string; project: string; global: string; native: string; unknown: string }
      status: {
        connected: string
        disabled: string
        needs_auth: string
        needs_client_registration: string
        failed: string
        not_initialized: string
      }
      reason: {
        'file-missing': string
        'parse-failed': string
        'opencode-pure-mode': string
        'plugin-load-failed': string
        'dump-plugin-internal-error': string
        'non-agent-kind': string
        'in-flight': string
      }
    }
    statSession: string
    unknownPlugin: string
    sessionParentBadge: string
  }
  noderunStatus: {
    pending: string
    running: string
    done: string
    failed: string
    canceled: string
    interrupted: string
    skipped: string
    exhausted: string
    awaiting_review: string
    awaiting_human: string
    superseded: string
    supersededHint: string
    rollbackHint: string
    decision: {
      iterated: string
      rejected: string
    }
  }
  taskOutputs: {
    section: string
    pending: string
    download: string
    downloading: string
    downloadFailed: string
    artifactTruncated: string
  }
  taskPreview: {
    button: string
    back: string
    title: string
    invalidLink: string
    pending: string
  }
  settingsForm: {
    commitPushModel: string
    commitPushModelHint: string
    commitPushRuntime: string
    commitPushRuntimeHint: string
    commitPushMaxRepairRetries: string
    commitPushMaxRepairRetriesHint: string
    commitPushDiffMaxBytes: string
    commitPushDiffMaxBytesHint: string
    mergeAgentRuntime: string
    mergeAgentRuntimeHint: string
    maxConcurrentNodes: string
    multiProcessConc: string
    logLevel: string
    perTaskDuration: string
    perTaskTokens: string
    perNodeTimeout: string
    nodeRetries: string
    nodeRetriesHint: string
    autoResumeOnBoot: string
    autoResumeOnBootHint: string
    autoRepairS4: string
    autoRepairS4Hint: string
    autoKillStalledChild: string
    autoKillStalledChildHint: string
    heartbeatStallMs: string
    maxAutoRecoveriesPerWindow: string
    autoRecoveryWindowMs: string
    periodicOrphanReconcileMs: string
    zeroDisabled: string
    largeOutputThreshold: string
    zeroUnlimited: string
    autoGcLabel: string
    gitRecurseSubmodules: string
    gitRecurseSubmodulesHint: string
    gitRecurseAuto: string
    gitRecurseAlways: string
    gitRecurseNever: string
    gitSubmoduleJobs: string
    gitSubmoduleJobsHint: string
    gitSubmoduleRemote: string
    gitSubmoduleRemoteHint: string
    submoduleAutoRefresh: string
    submoduleAutoRefreshHint: string
    submoduleRefreshIntervalMs: string
    submoduleOnlyRecentDays: string
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
    bindPortCurrent: string
    bindPortUseCurrent: string
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
    labelGit: string
    labelLoop: string
    /** RFC-060 — wrapper-fanout container label rendered in the canvas chip. */
    labelFanout: string
    pillGit: string
    pillLoop: string
    /** RFC-060 — wrapper-fanout header pill (short status text beside the kind label). */
    pillFanout: string
    /** RFC-060 — tooltip / accessible label on the shard-source port row. */
    shardSourceTag: string
    /** RFC-060 — short visible tag on the shard-source port row (e.g. "shard"). */
    shardSourceTagShort: string
    dropHere: string
    fitToChildren: string
    unwrap: string
    deleteWithInner: string
    confirmDeleteWithInner: string
    deleteScopeChanged: string
  }
  /** Localized chip labels for the IO node family (input / output). The
   *  palette already carries its own `paletteInputLabel` / `paletteOutputLabel`
   *  keys; these are the labels rendered on the canvas node itself. */
  ioNode: {
    labelInput: string
    labelOutput: string
  }
  /** Canvas chip label for agent-single nodes — pairs with a leading ⚙ icon
   *  so the chip lines up visually with the wrapper / IO / human-category
   *  chips, which all carry an icon prefix. */
  agentNode: {
    label: string
  }
  /** RFC-122 — on-canvas per-(task, asking-node) clarify directive toggle. */
  clarifyDirective: {
    groupLabel: string
    continue: string
    stop: string
  }
  /** RFC-106 — live drag-connect badge (new input vs reuse existing). */
  canvas: {
    connect: { newInput: string; reuseInput: string }
    clipboardBlocked: string
    clipboardReferencesFiltered: string
    referencesPruned: string
    referenceChangeBlocked: string
    accessibleName: string
    accessibleDescription: string
    nodeConfigurationSummary: string
    placementUnavailable: string
    layoutCrossScope: string
    layoutCycles: string
    layoutLockedOverflow: string
  }
  /** Canvas chip label for review nodes (⚖ icon). */
  reviewNode: {
    label: string
    /** RFC-158: task-detail canvas click hints when the review node is clickable. */
    navAwaiting: string
    navDecided: string
  }
  /** Canvas chip label fallback for clarify / cross-clarify nodes — used
   *  when the renderer is invoked without an explicit `data.kindLabel`. */
  clarifyNode: {
    label: string
    /** RFC-161: task-detail canvas click hints when the clarify node is clickable
     *  (shared by clarify + cross-clarify renderers; both jump to /clarify). */
    navAwaiting: string
    navAnswered: string
  }
  crossClarifyNode: {
    label: string
  }
  errors: Record<string, string>
  errorDomains: Record<string, string>
  // RFC-203 T3c — workflow-validation issue copy: exact per-code titles +
  // prefix-family fallbacks + global fallback (describeValidationIssue).
  validation: {
    issue: Record<string, string>
    family: Record<string, string>
    fallback: string
  }
  errorDetails: {
    hintPrefix: string
    moreIssues: string
    referencedByNames: string
    referencedByHidden: string
    referencedByCount: string
    availableRefs: string
    versionConflict: string
    stderrSummary: string
    rawSummary: string
  }
  // RFC-023 clarify feature (PR-C).
  clarify: {
    roundSealedByTaskTerminal: string
    roundDismissedNoHuman: string
    taskNameLabel: string
    nav: { label: string; badgeTitle: string }
    list: {
      title: string
      filter: { awaiting: string; answered: string; all: string }
      empty: string
      emptyDescription: string
      colTask: string
      colAgent: string
      colNode: string
      colIteration: string
      colQuestions: string
      colTime: string
      openButton: string
      statusAwaiting: string
      statusAnswered: string
      statusCanceled: string
      // RFC-056: per-row chip label.
      chip: { self: string; cross: string }
    }
    detail: {
      contextCard: string
      contextCardShard: string
      truncationWarning: string
      shardSwitcherLabel: string
      shardSwitcherEmpty: string
      historyTitle: string
      historyEmpty: string
      submitContinue: string
      submitStop: string
      stopModal: { title: string; body: string; confirm: string; cancel: string }
      submitDisabledRequired: string
      draftSaving: string
      draftSaved: string
      roundSealedFooter: string
      recommendedChip: string
      back: string
      answeredAt: string
      askedAt: string
      keyboardHint: string
      lockedNote: string
    }
    question: {
      single: { customLabel: string }
      multi: { customLabel: string; customPlaceholder: string }
      custom: { lengthHint: string }
    }
    option: {
      recommendedBadge: string
      reasonLabel: string
    }
    canvas: {
      error: { multiNotSupported: string; duplicate: string }
    }
    ws: { toast: { othersSubmitted: string } }
    inspector: {
      title: string
      linkedAgentMissing: string
      inLoop: string
      notInLoop: string
    }
    task: { statusLabel: string }
    error: { unknown: string }
    // RFC-026 inline session mode UI surface
    eventStream: {
      sessionResumed: string
      fallbackToIsolated: string
    }
    node: {
      chip: {
        inline: string
      }
    }
  }
  // RFC-056 cross-clarify UI strings.
  crossClarify: {
    contextCard: string
    targetDesigner: string
    rejectModal: { title: string; body: string; confirm: string }
    multiSourceBanner: string
    multiSourcePendingLinkLabel: string
    abandonedChip: string
    abandonedTooltip: string
    inspector: {
      title: string
      sessionModeForQuestioner: string
      sessionModeIsolated: string
      sessionModeInline: string
      sessionModeHint: string
      fieldLinkedQuestioner: string
      linkedQuestionerMissing: string
      linkedQuestionerHint: string
      fieldLinkedDesigner: string
      linkedDesignerMissing: string
      linkedDesignerHint: string
      fieldInLoop: string
      inLoopYes: string
      inLoopNo: string
    }
    canvas: {
      paletteLabel: string
      paletteHint: string
      handleLabel: { toQuestioner: string; toDesigner: string }
      error: { targetNotAgentSingle: string; designerNotAgentSingle: string }
    }
  }
  sidebar: {
    languageGroupLabel: string
    lang: {
      zh: string
      en: string
    }
  }
  session: {
    user: string
    assistant: string
    thinking: string
    thinkingCount: string
    toolCall: string
    toolResult: string
    subagent: string
    captureMissing: string
    fallbackOutput: string
    expand: string
    collapse: string
    statusPending: string
    statusRunning: string
    statusCompleted: string
    statusError: string
    loadError: string
    empty: string
    toolInput: string
  }
  // RFC-041 PR4: platform memory UI surface.
  memory: {
    title: string
    adminOnly: string
    empty: string
    sectionNavLabel: string
    sectionGroups: {
      pending: string
      library: string
      automation: string
    }
    sectionDescriptions: {
      approvalQueue: string
      fusion: string
      all: string
      byScope: string
      distillJobs: string
    }
    sectionUnavailable: string
    loadingEdit: string
    emptyStates: {
      candidates: string
      candidatesDescription: string
      approved: string
      approvedDescription: string
      archived: string
      archivedDescription: string
      scope: string
      scopeDescription: string
    }
    confirmDelete: string
    confirmArchive: string
    archiveDialogTitle: string
    deleteDialogTitle: string
    dialogCancel: string
    dialogConfirm: string
    tab: {
      approvalQueue: string
      all: string
      byScope: string
      distillJobs: string
      fusion: string
    }
    // RFC-121: fusions awaiting approval, surfaced on the Memory page.
    fusion: {
      subtitle: string
      empty: string
      emptyDescription: string
      error: string
      retry: string
    }
    action: {
      approve: string
      approveSupersede: string
      reject: string
      archive: string
      unarchive: string
      delete: string
      compare: string
      // RFC-045
      new: string
      edit: string
      expandBody: string
      collapseBody: string
    }
    // RFC-045 — manual create + edit dialog
    newDialogTitle: string
    editDialogTitle: string
    formCancel: string
    formSave: string
    error: {
      terminalStatus: string
    }
    form: {
      scopeType: string
      scopeId: string
      scopeIdGlobal: string
      scopeIdPlaceholder: string
      title: string
      bodyMd: string
      tags: string
      tagsHint: string
      tagsFull: string
      tagInputPlaceholder: string
      tagRemoveAria: string
      errTitleEmpty: string
      errTitleTooLong: string
      errBodyEmpty: string
      errBodyTooLong: string
      errScopeIdRequired: string
      errTagsTooMany: string
      errTagTooLong: string
    }
    candidate: {
      from: string
      pendingCount: string
      source: {
        clarify: string
        review: string
        feedback: string
        manual: string
      }
    }
    candidateRow: {
      lang: {
        'zh-CN': string
        'en-US': string
      }
      langTooltip: {
        'zh-CN': string
        'en-US': string
      }
    }
    distillAction: {
      new: string
      updateOf: string
      duplicateOf: string
      conflictWith: string
    }
    scope: {
      agent: string
      workflow: string
      repo: string
      global: string
    }
    scopeRow: {
      agentCount: string
      workflowPrefix: string
      repoPrefix: string
      global: string
    }
    status: {
      candidate: string
      approved: string
      archived: string
      superseded: string
      rejected: string
      fused: string
    }
    conflictDialog: {
      title: string
      existing: string
      candidate: string
      close: string
      tagsLabel: string
    }
    distillJobs: {
      empty: string
      emptyDescription: string
      colId: string
      colStatus: string
      colSource: string
      colAttempts: string
      colCreated: string
      colError: string
      status: {
        pending: string
        running: string
        done: string
        failed: string
        canceled: string
      }
      action: {
        retry: string
        cancel: string
      }
    }
    // RFC-043: aliases existing candidate.source.* at top level so the
    // distill detail page can read `memory.sourceKind.{kind}` without a
    // nested lookup.
    sourceKind: {
      clarify: string
      review: string
      feedback: string
      manual: string
    }
    distillJobDetail: {
      adminOnly: string
      attempt: string
      attemptsCount: string
      attemptPickerLabel: string
      candidateStatus: string
      captureFailed: string
      dedupSnapshotLabel: string
      loadError: string
      noCandidates: string
      noConversation: string
      noDedupSnapshot: string
      noSourceEvents: string
      openInQueue: string
      outputLangLabel: string
      outputLang: {
        default: string
        'zh-CN': string
        'en-US': string
      }
      section: {
        candidates: string
        conversation: string
        scope: string
        sourceEvents: string
      }
      sessionLoadError: string
      sourceDeleted: string
      stderrLabel: string
      exitCodeLabel: string
      stderrClipped: string
    }
  }
  // RFC-041 PR4: per-task feedback ("dear future me") area.
  taskFeedback: {
    title: string
    hint: string
    placeholder: string
    submit: string
    submitting: string
    empty: string
    distilled: string
    rateLimit: string
    secretHint: string
    submitError: string
    loadError: string
    submittedJustNow: string
  }
  // RFC-041 PR4: "Memories" sub-tab embedded into resource detail pages.
  detail: {
    memories: string
  }
  // RFC-057: backend-emitted repair option labels/descriptions/unavailable
  // reasons. Each option's labelKey/descriptionKey points to a leaf string
  // here; UI calls `t(option.labelKey)` directly without templating.
  diagnose: {
    repair: {
      R1: {
        approveRun: { label: string; desc: string }
        unapproveDoc: { label: string; desc: string }
        markTaskFailed: { label: string; desc: string }
        unavailable: {
          detailDrift: string
          docNotApproved: string
          runAlreadyDone: string
          taskTerminal: string
        }
      }
      R2: {
        demoteRunToAwaiting: { label: string; desc: string }
        markTaskFailed: { label: string; desc: string }
        unavailable: {
          detailDrift: string
          runNotDone: string
          taskTerminal: string
        }
      }
      C1: {
        resumeRun: { label: string; desc: string }
        reopenSession: { label: string; desc: string }
        unavailable: {
          detailDrift: string
          runNotAwaitingHuman: string
          sessionNotClosed: string
        }
      }
      T1: {
        demoteTask: { label: string; desc: string }
        resurrectReviewRun: {
          label: string
          desc: string
          unavailable: { noCandidate: string }
        }
        unavailable: { taskNotAwaitingReview: string }
      }
      T2: {
        demoteTask: { label: string; desc: string }
        resurrectClarifyRun: {
          label: string
          desc: string
          unavailable: { noCandidate: string; noOpenSession: string }
        }
        unavailable: { taskNotAwaitingHuman: string }
      }
      T3: {
        demoteTask: { label: string; desc: string }
        markTaskFailed: { label: string; desc: string }
        unavailable: { taskNotDone: string }
      }
      U1: {
        cancelOlderKeepNewest: { label: string; desc: string }
        cancelNewerKeepOldest: { label: string; desc: string }
        unavailable: { detailMissingIds: string; notMultipleActive: string }
      }
      CR1: {
        acknowledge: { label: string; desc: string }
        retryDesignerRerun: { label: string; desc: string }
        unavailable: { taskNotFailed: string }
      }
      S1: {
        recreateDocVersion: { label: string; desc: string }
        demoteTask: { label: string; desc: string }
        unavailable: { taskNotAwaitingReview: string }
      }
      S2: {
        demoteTask: { label: string; desc: string }
        reopenSession: {
          label: string
          desc: string
          unavailable: {
            noClosedSession: string
            sessionAlreadyOpen: string
            noAwaitingRun: string
          }
        }
        unavailable: { taskNotAwaitingHuman: string }
      }
      S3: {
        resurrectReviewRun: {
          label: string
          desc: string
          unavailable: { noCandidate: string }
        }
        resurrectClarifyRun: {
          label: string
          desc: string
          unavailable: { noCandidate: string }
        }
        demoteTask: { label: string; desc: string }
        markTaskFailed: { label: string; desc: string }
        unavailable: { taskNotRunning: string }
      }
      S4: {
        kickTask: { label: string; desc: string }
        cancelTask: { label: string; desc: string }
        unavailable: { taskNotPending: string }
      }
      // RFC-098 WP-8: S5 (running, active runs, events stalled) — acknowledge only.
      S5: {
        acknowledge: { label: string; desc: string }
      }
      // RFC-108 T14: S6 (awaiting_* with no active member) — acknowledge only.
      S6: {
        acknowledge: { label: string; desc: string }
      }
    }
  }
  // RFC-099 — ownership ACL + attribution UI
  acl: {
    title: string
    owner: string
    systemOwner: string
    visibility: string
    visibilityValue: { public: string; private: string }
    members: string
    noMembers: string
    privateHint: string
    save: string
    transferOwner: string
    transferTitle: string
    transferHint: string
    transferConfirm: string
    ownerBadge: string
    privateChip: string
  }
  importRefs: {
    selectorLabel: string
    selectOwner: string
    candidateDescription: string
    resourceType: { agent: string; skill: string; mcp: string; plugin: string }
  }
  members: {
    title: string
    users: string
    noUsers: string
    hint: string
    transferHint: string
  }
  userPicker: {
    placeholder: string
    noResults: string
    remove: string
  }
  taskQuestions: {
    empty: string
    source: string
    target: string
    handlerAsker: string
    handlerDesigner: string
    autoDispatchQueued: string
    noTarget: string
    reassign: string
    confirm: string
    stage: string
    unstage: string
    allNodes: string
    answer: string
    viewClarify: string
    nodeBadgeAria: string
    batchDispatch: string
    batchDispatchCount: string
    dispatchTargetChanged: string
    dispatchInFlight: string
    dispatchInFlightNode: string
    dispatchDesignerNotReady: string
    dispatchRoundMultiTarget: string
    dispatchUnsafeTarget: string
    dispatchNotDeferred: string
    addQuestion: string
    manualSource: string
    roleEcho: string
    answerPaneButton: string
    answerPaneTitle: string
    answerPaneEmpty: string
    answerPaneHint: string
    answerPaneResubmitHint: string
    answerPaneSubmit: string
    answerPaneSubmitCount: string
    author: {
      newTitle: string
      titleLabel: string
      titlePlaceholder: string
      bodyLabel: string
      bodyPlaceholder: string
      bodyHint: string
      handlerLabel: string
      handlerHint: string
      handlerPlaceholder: string
      save: string
      cancel: string
    }
    phase: {
      pending: string
      staged: string
      processing: string
      awaiting_confirm: string
      done: string
    }
  }
  attribution: {
    localHistoric: string
    role: { owner: string; user: string; admin: string; manager: string }
    submittedBy: string
    lastEditedBy: string
    decidedBy: string
    justEdited: string
  }
}

export const zhCN: Resources = {
  tabBar: {
    scrollStart: '向前查看更多分区',
    scrollEnd: '向后查看更多分区',
  },
  nav: {
    agents: '代理',
    skills: '技能',
    mcps: 'MCP',
    plugins: '插件',
    workflows: '工作流',
    workgroups: '工作组',
    tasks: '任务',
    scheduled: '定时任务',
    reviews: '评审',
    clarify: '反问',
    repos: '远端仓',
    settings: '设置',
    brand: 'Agent Workflow',
    openMenu: '打开导航菜单',
    home: '首页',
    group: {
      agents: '能力资源',
      workflows: '编排',
      tasks: '运行与仓库',
      memory: '知识',
    },
    settingsIcon: {
      label: '设置',
      tooltip: '设置（含主题切换）',
    },
    inbox: {
      label: '收件箱',
      subtitle: '集中处理评审、反问与工作组待办',
      total: '{{n}} 项待处理',
      partial: '部分待办未加载',
      filterAria: '按待办类型筛选',
      tabAll: '全部',
      tabReviews: '评审',
      tabClarify: '反问',
      loading: '正在加载待办…',
      empty: '当前没有待处理事项',
      emptyHint: '新的评审、反问和工作组待办会出现在这里。',
      errorReviews: '评审列表加载失败',
      errorClarify: '反问列表加载失败',
      retry: '重试',
      retryFeed: '重试加载{{feed}}',
      sourceTask: '任务 {{taskId}}',
      openReviews: '查看全部评审 →',
      openClarify: '查看全部反问 →',
      clarifyShardOrIter: '分片 {{shard}} / 第 {{iter}} 轮',
      clarifySubtitle: '← {{agent}} · {{detail}}',
      badgeAria: '{{n}} 项待处理',
      triggerAriaWithCount: '收件箱，{{n}} 项待处理',
      shardLabel: '分片 {{shard}}',
      iterLabel: '第 {{iter}} 轮',
      errorWorkgroups: '工作组待办加载失败',
      wgKind: '工作组',
      wgRow_one: '{{count}} 项工作组待办',
      wgRow_other: '{{count}} 项工作组待办',
      wgBreakdown: '待交付 {{d}} · 待确认 {{g}}',
      itemAria: '{{kind}}：{{title}}，来自 {{task}}',
      workgroupItemAria: '打开 {{n}} 项工作组待办',
    },
    memory: '记忆',
    memoryHint: '从过往反问、评审与反馈中沉淀的长期上下文',
    memoryBadge: '{{count}} 项待审批',
    memoryPendingAction: '打开 {{count}} 项记忆待办',
  },
  home: {
    greet: {
      morning: '早上好',
      afternoon: '下午好',
      evening: '晚上好',
    },
    startTask: '启动任务',
    // RFC-135：多运行时状态行——逐运行时短文案；可用性不比较版本号，
    // 版本串仅展示（readyNoVersion 兜自定义二进制解析不出版本的情形）。
    runtime: {
      checking: '检查中…',
      noneEnabled: '无已启用的运行时',
      aggregate: '{{ok}}/{{total}} 个运行时已就绪',
      aggregateWorst: '{{ok}}/{{total}} 个运行时已就绪 · {{name}} 异常',
      item: {
        ready: '{{name}} v{{version}}',
        readyNoVersion: '{{name}} 可用',
        missing: '{{name}} 未找到',
      },
    },
    section: {
      running: '运行中',
      inbox: '等你处理',
      recent: '最近完成',
      viewAll: '查看全部 →',
      openInbox: '打开收件箱 →',
      viewTasks: '查看任务列表 →',
      empty: {
        running: '暂无运行中任务',
        inbox: '当前没有等你处理的事项 ✓',
        recent: '还没有完成过任务',
      },
      error: {
        generic: '加载失败',
        retry: '重试',
      },
    },
    taskRow: {
      relativeJustNow: '刚刚',
      relativeMinAgo: '{{n}} 分钟前',
      relativeHourAgo: '{{n}} 小时前',
      relativeDayAgo: '{{n}} 天前',
    },
    // RFC-190：能力门户首页。
    pipeline: {
      input: '输入',
      code: '编码',
      audit: '审计',
      fix: '修复',
      output: '输出',
      caption: '编码取 diff → 分片并行审计 → 聚合修复，确定性引擎全程编排',
      open: '打开工作流列表',
    },
    pulse: {
      line: '运行中 {{running}} · 等待处理 {{awaiting}} · 7 天完成 {{done}}（成功率 {{rate}}%）',
      lineNoRate: '运行中 {{running}} · 等待处理 {{awaiting}} · 7 天完成 {{done}}',
    },
    newWorkflow: '新建工作流',
    cap: {
      agents: {
        title: '代理',
        desc: '驱动 opencode / claude-code 进程的虚拟代理，技能、MCP 与插件按需注入',
        sub: {
          skills: '技能 {{n}}',
          mcps: 'MCP {{n}}',
          plugins: '插件 {{n}}',
        },
      },
      workflows: {
        title: '工作流',
        desc: '画布编排多代理流水线：git 快照、循环、多进程扇出',
      },
      workgroups: {
        title: '工作组',
        desc: '领导者带队的自治多代理协作：轮次、派单、评审',
      },
      memory: {
        title: '记忆',
        desc: '跨任务沉淀的可用知识：蒸馏、审批、融合进技能',
      },
      scheduled: {
        title: '定时任务',
        desc: '按计划自动启动工作流，把流水线跑成例行',
      },
      repos: {
        title: '仓库',
        desc: '远端仓缓存与每任务独立 worktree 隔离',
      },
      countUnavailable: '计数不可用',
    },
    feed: {
      title: '任务动态',
    },
  },
  reviews: {
    title: '评审',
    emptyList: '当前没有待处理的评审',
    emptyDescription: '任务运行到评审节点时会暂停并显示在这里，等待你检查结果并作出决定。',
    filterPending: '待评审',
    filterAll: '全部',
    filterApproved: '已通过',
    filterRejected: '已退回',
    filterIterated: '已迭代',
    taskNameLabel: '所属任务',
    colNode: '节点',
    colStatus: '状态',
    colVersion: '版本',
    colCreated: '创建时间',
    openButton: '打开',
    statusAwaiting: '待评审',
    sidebarTitle: '评审意见',
    sidebarEmpty: '暂无评审意见。在正文里拖选一段文本即可添加。',
    sidebarCountLabel: '评审意见 · {{count}}',
    sidebarCollapse: '折叠侧栏',
    sidebarExpand: '展开侧栏',
    sidebarJumpPrev: '上一条评审意见',
    sidebarJumpNext: '下一条评审意见',
    commentEdit: '编辑',
    commentCopy: '复制',
    commentCopied: '已复制',
    commentCopyFailed: '复制失败',
    commentSave: '保存',
    commentEditCancel: '取消',
    lineRef: '第 {{n}} 行',
    lineRefRange: '第 {{start}}–{{end}} 行',
    approveButton: '通过',
    rejectButton: '退回',
    iterateButton: '根据评审意见修改',
    detailHint: '当前版本 · 已迭代 {{iteration}} 轮 · 决策：{{decision}}',
    rejectPrompt: '请输入退回原因（提交后将回滚并重跑：{{willRerun}}）：',
    rejectReasonRequired: '退回必须填写原因。',
    iterateConfirm: '将基于上方评审意见重跑：{{willRerun}}。继续？',
    iterateNoCommentsWarning:
      '当前未提交任何评审意见。继续迭代会让 agent 收到空意见列表 — 仍然继续吗？',
    approveDraftWarning: '还有 {{count}} 条未提交评审意见，通过将丢弃这些草稿。',
    approveDraftConfirm: '确定通过此次评审吗？',
    approveCommentWarning: '本次评审有 {{count}} 条评审意见。',
    popoverPlaceholder: '写下你的评审意见…',
    popoverSubmit: '提交',
    popoverCancel: '取消',
    crossHeadingHint: '跨章节选择无法添加评审意见，请在同一章节内重新选择。',
    diffToggle: '对比上一版',
    diffOff: '原文',
    diffGranularityWord: '词',
    diffGranularityLine: '行',
    diffGranularityBlock: '段',
    diffLeftLabel: '上一版 v{{version}}（{{decision}}）',
    diffRightLabel: '当前 v{{version}}',
    // RFC-013
    expand: '展开历史版本',
    collapse: '折叠历史版本',
    historyHeader: '历史版本 · {{count}}',
    sidebarEmptyReadonly: '这一版没有评审意见。',
    historicalBanner: '只读 · 正在查看版本 v{{version}}（{{decision}}）· 决策与评论编辑已禁用',
    backToCurrent: '回到当前版',
    loadVersionsFailed: '加载历史版本失败。',
    retry: '重试',
    currentTag: '当前',
    unknownVersion: '未知版本：{{id}}。已跳回当前版。',
    downloadMarkdown: '下载 Markdown',
    downloadMarkdownTitle: '下载 {{filename}}',
    approveDialogTitle: '通过此次评审？',
    iterateDialogTitle: '基于评审意见迭代？',
    rejectDialogTitle: '退回此次评审',
    rejectReasonLabel: '退回原因',
    dialogConfirm: '确认',
    dialogCancel: '取消',
    multiDoc: {
      documents: '文档（{{count}}）',
      accept: '采纳',
      notAccept: '不采纳',
      pending: '待定',
      accepted: '已采纳',
      notAccepted: '已排除',
      approveProgress: '通过({{decided}}/{{total}})',
      approveBlocked: '还有 {{count}} 篇未裁决',
      noComments: '（暂无评审意见）',
      badge: '多文档',
      acceptHint: '采纳（快捷键 Q）',
      notAcceptHint: '不采纳（快捷键 W）',
      shortcutHint: '↑/↓ 切换文件 · Q 采纳 · W 不采纳',
      changed: '已变更',
      changedHint: '内容较你上次裁决时有变化，建议重看',
    },
    decision: {
      approved: '通过',
      rejected: '退回',
      iterated: '迭代',
      pending: '待定',
      superseded: '已作废',
    },
    decisionInfo: {
      decidedAt: '决策时间',
      rejectReason: '退回原因',
      supersededReason: '上游产出已刷新，本版已被系统作废。',
      reasonMissing: '（未记录）',
      systemDecider: '系统',
    },
    roundLabel: '第 {{n}} 轮',
    roundHistoryHeader: '评审轮次 · {{count}}',
    roundDocCount: '{{count}} 篇文档',
    historicalRoundBanner: '只读 · 正在查看第 {{n}} 轮（{{decision}}）· 决策与采纳编辑已禁用',
    backToCurrentRound: '回到当前轮',
    unknownRound: '未知轮次：{{id}}。已跳回当前轮。',
    rerunDirectUpstream: '（直接上游）',
    decisionActionsAria: '决策',
    plantumlUnknownError: '未知错误',
    plantumlSyntaxErrorAtLine: 'PlantUML 语法错误，位于第 {{line}} 行',
    plantumlSyntaxErrorLineAndReason: 'PlantUML 语法错误，位于第 {{line}} 行 — {{reason}}',
    plantumlSyntaxErrorReasonOnly: 'PlantUML 语法错误 — {{reason}}',
    plantumlSyntaxErrorGeneric: 'PlantUML 语法错误（见下方源码）',
    plantumlSeeSourceSuffix: ' （见下方源码）',
    plantumlUnconfigured:
      'PlantUML 渲染器未配置 —— 请在 设置 → 渲染 中设置 endpoint。下方显示图源。',
    plantumlRendering: '渲染中…',
    plantumlRenderFailed: 'PlantUML 渲染失败：{{msg}}',
    plantumlPrivacyNotice: '将向 {{host}} 发送文档源码以渲染该图。',
  },
  auth: {
    title: '登录',
    hint: '运行 ',
    hintCmd: 'agent-workflow start',
    hintAfter: '，复制启动时打印的 token 粘贴到下方。',
    daemonUrl: '守护进程 URL',
    token: 'Token',
    tokenPlaceholder: '64 位十六进制',
    verifying: '验证中…',
    connect: '连接',
    subtitle: '使用账号密码，或通过单点登录继续。',
    username: '用户名',
    usernamePlaceholder: '例如 alice',
    password: '密码',
    passwordPlaceholder: '••••••••',
    signIn: '登录',
    invalidCredentials: '用户名或密码错误',
    or: '或',
    loginWith: '使用 {{name}} 登录',
    providerButtonHint: '安全跳转后继续',
    useDaemonToken: '使用守护进程 Token',
    tabPassword: '账号密码',
    tabOidc: '单点登录',
    tabToken: '初始化令牌',
    oidcHint: '选择已配置的单点登录入口。',
    oidcDiscoveryLoading: '正在检查可用登录方式…',
    oidcDiscoveryError: '无法确认当前可用的登录方式，请重试后再输入凭据。',
    oidcDiscoveryEmpty: '尚未配置身份提供商，请使用当前可用的用户名密码登录。',
    tokenHint: '使用 daemon 启动时打印的 64 位十六进制 token。仅供管理员 / 应急使用。',
    brandTagline: '让多个智能体协同工作，过程始终清晰可控。',
    brandDescription: '在一个工作空间中设计流程、推进任务并审阅结果。',
    localControl: '本地掌控',
    identityReady: '身份可治理',
    securityFooter: '凭据仅发送给当前 Agent Workflow 服务。',
    secureAccess: '安全访问',
    methodLabel: '选择登录方式',
    passwordHint: '使用管理员为你创建的账户登录。',
    bootstrapTokenRequired: '当前凭据不是首次初始化 Token。',
    bootstrapTokenHint:
      '粘贴 daemon 启动时输出的初始化 Token。它只能用于创建首位管理员，完成后会永久失效。',
    continueSetup: '继续初始化',
    setupComplete: '管理员已创建，请使用刚刚设置的账户登录。',
    noLoginMethod: '当前没有可用的登录方式，请联系管理员。',
    bootstrapStep: '安全初始化',
    bootstrapTitle: '创建首位管理员',
    bootstrapDescription: '这个账户将拥有系统管理权限。创建完成后，初始化 Token 会立即永久失效。',
    bootstrapStepsLabel: '初始化进度',
    bootstrapStepAccount: '设置账户',
    bootstrapStepRetire: '注销 Token',
    bootstrapStepLogin: '账户登录',
    bootstrapOneWay: '这个交接不可逆。继续前请确认你已妥善保存管理员密码。',
    confirmPassword: '确认密码',
    passwordMismatch: '两次输入的密码不一致。',
    creatingAdmin: '正在创建管理员…',
    completeHandoff: '完成安全交接',
    bootstrapLoginTitle: '初始化此工作空间',
    bootstrapLoginSubtitle: '先验证 daemon 输出的一次性 Token，然后创建首位管理员。',
  },
  userMenu: {
    account: '我的账户',
    users: '管理用户',
    settings: '系统设置',
    logout: '退出登录',
    daemonAccess: '守护进程访问',
    daemonRole: '守护进程管理员',
    tokenIssue: '当前 Token 无访问权限',
    signedOutHint: '当前 Token 缺少 account:self 权限。点击退出登录。',
  },
  account: {
    title: '我的账户',
    profile: '基本信息',
    username: '用户名',
    displayName: '显示名',
    role: '角色',
    status: '状态',
    source: '登录方式',
    password: '修改密码',
    passwordDesc: '设置新密码后，你的其他会话会被吊销；当前窗口会自动获得一枚新的会话 Token。',
    oldPassword: '当前密码',
    newPassword: '新密码',
    update: '更新密码',
    passwordChanged: '密码已更新。',
    pats: '个人访问令牌',
    patsDesc: '个人访问令牌已停止生成；你仍可查看和吊销此前创建的令牌。',
    patName: '令牌名称',
    patNamePlaceholder: '例如 ci-launcher',
    patNameCol: '名称',
    patScopes: '作用域',
    patStatus: '状态',
    patShownOnce: '新令牌（请立即复制）',
    copy: '复制',
    generate: '生成',
    revoke: '吊销',
    unlink: '解除绑定',
    noPats: '还没有任何令牌。',
    sessions: '活跃会话',
    sessionsDesc: '当前账号的 Web 会话。看到陌生的会话立即吊销，下一次请求会返回 401。',
    sessionId: '会话',
    userAgent: '客户端',
    noSessions: '当前没有活跃会话。',
    linkedIdentities: '已绑定身份',
    identitiesDesc: '与本账号绑定的 OIDC 身份提供商。身份绑定只读，由管理员统一治理。',
    provider: '提供商',
    subject: 'Subject',
    noIdentities: '还没有绑定任何身份。',
    patScopesLabel: '权限范围',
    patSelectAll: '全选',
    patSelectDefault: '默认',
    patSelectNone: '清空',
    patNoScopes: '请至少勾选一个权限。',
    patStatusActive: '有效',
    patStatusRevoked: '已吊销',
    patGroup: {
      spa: 'Web 访问 — 使用此 Token 登录网页时需要',
      tasks: '任务',
      resourceRead: '只读资源',
      admin: '管理员权限 — 仅在你的角色为 admin 时实际生效',
    },
    patScope: {
      accountSelf: {
        label: '账户自助',
        desc: '读取 /api/auth/me、改自己密码、管理自己的 PAT 和会话。',
      },
      usersSearch: {
        label: '搜索用户',
        desc: 'launcher / collaborators 选用户时需要。仅返回公开字段。',
      },
      runtimeRead: {
        label: '运行时状态',
        desc: '首页运行时小圆点和 /settings 运行时面板依赖这条。',
      },
      tasksLaunch: { label: '启动任务', desc: '提交 POST /api/tasks 启动新任务。' },
      tasksReadOwn: { label: '查看自己的任务', desc: '查看你 owner 或被加入协作的任务。' },
      tasksCancelOwn: { label: '取消自己的任务', desc: '中止你 owner 的任务。' },
      agentsRead: { label: '浏览 Agents', desc: '读取 agent 列表 / 详情。' },
      skillsRead: { label: '浏览 Skills', desc: '读取 skill 列表 / 详情。' },
      mcpsRead: { label: '浏览 MCP', desc: '读取 MCP 列表 / 详情 / 探针结果。' },
      pluginsRead: { label: '浏览插件', desc: '读取 opencode 插件列表 / 详情。' },
      workflowsRead: { label: '浏览工作流', desc: '读取 workflow 列表 / 定义。' },
      reposRead: { label: '浏览远端仓', desc: '读取 cached_repos 列表 / 同步状态。' },
      usersRead: { label: '读取用户列表', desc: '/api/users 完整字段（含 email、上次登录）。' },
      usersWrite: { label: '管理用户', desc: '新建 / 编辑 / 停用 / 重置密码。' },
      settingsRead: { label: '读取设置', desc: '/api/config 完整字段。' },
      settingsWrite: { label: '修改设置', desc: 'PUT /api/config 改全局配置。' },
      tasksReadAll: {
        label: '查看所有任务',
        desc: '不止 owner 或 collaborator —— 整库可见。仅管理员。',
      },
    },
    pleaseSignIn: '请先登录。',
    pleaseSignInDescription: '登录后即可查看账户资料与安全设置。',
    sectionGroup: '账户设置',
    sectionNavLabel: '账户设置分区',
    sections: {
      overview: '账户概览',
      security: '登录与安全',
      tokens: '存量访问令牌',
    },
    sectionDescriptions: {
      overview: '查看账户状态和已关联的登录身份。',
      security: '管理本地密码与当前 Web 会话。',
      tokens: '查看并逐步吊销此前创建的个人访问令牌。',
    },
    oidcManaged: 'OIDC 托管',
    localAccount: '本地账户',
    sources: {
      session: 'Web 会话',
      pat: '个人访问令牌',
      daemon: '初始化 Token',
    },
    localIdentityTitle: '这是一个本地账户',
    localIdentityDescription: '当前未关联任何 OIDC 身份，密码由 Agent Workflow 管理。',
    linkedAt: '关联于',
    technicalIdentity: '查看技术标识',
    oidcPasswordTitle: '密码由身份提供方管理',
    oidcPasswordDescription: '此账户已关联 OIDC 身份。请前往对应身份提供方修改登录凭据。',
    noSessionsDescription: '登录后，活跃的 Web 会话会显示在这里。',
    unknownClient: '未知客户端',
    lastActive: '最近活动',
    expires: '到期',
    revokeSessionTitle: '吊销这个会话？',
    revokeSessionDescription: '该浏览器的下一次请求将被要求重新登录。此操作不会影响其他会话。',
    tokensRetiredTitle: '已关闭新令牌生成',
    tokensRetiredDescription: '现有令牌会继续有效，直到到期或被你吊销。这里仅保留安全退出通道。',
    noPatsDescription: '你的账户没有存量个人访问令牌，也无法再生成新的令牌。',
    created: '创建于',
    lastUsed: '最近使用',
    neverUsed: '从未使用',
    noExpiry: '永不过期',
    scopeCount: '{{count}} 项权限',
    viewScopes: '查看权限明细',
    revokePatTitle: '吊销这个访问令牌？',
    revokePatDescription: '使用它的脚本或 CI 将立即失去访问权限，且令牌无法恢复。',
    roles: {
      admin: '管理员',
      user: '用户',
    },
  },
  users: {
    title: '用户',
    new: '新建用户',
    summary: '{{total}} 位用户 · {{admin}} 位管理员 · {{invited}} 位待登录 · {{disabled}} 位已停用',
    empty: '还没有用户',
    emptyDescription: '创建本地密码账户，或为用户首次通过身份提供方登录预先建档。',
    filteredEmpty: '没有符合当前筛选条件的用户',
    filteredEmptyDescription: '换一个姓名搜索，或清除状态和角色筛选。',
    filtersLabel: '查找和筛选用户',
    searchLabel: '搜索用户',
    searchPlaceholder: '搜索显示名、用户名或邮箱…',
    statusFilterLabel: '按状态筛选用户',
    roleFilterLabel: '按角色筛选用户',
    filterAll: '全部',
    allRoles: '全部角色',
    directoryLabel: '真人用户账户',
    username: '用户名',
    displayName: '显示名',
    email: '邮箱',
    noEmail: '未填写邮箱',
    role: '角色',
    status: '状态',
    manage: '管理',
    you: '你',
    neverSignedIn: '从未登录',
    signedInSuffix: '登录',
    ownership: {
      oidc: 'OIDC 托管',
      awaitingOidc: '等待 OIDC',
      local: '本地账户',
    },
    systemTitle: '系统主体',
    systemDescription: 'daemon 内部主体 · 不可登录或编辑',
    systemTokenRetired: '初始化令牌已退役',
    disable: '停用',
    enable: '启用',
    cancel: '取消',
    password: '密码',
    saving: '保存中…',
    create: {
      title: '新建用户',
      submit: '创建',
      accountType: '登录方式',
      passwordMode: '本地密码账户',
      passwordModeDescription: '创建带独立密码、可立即使用的活跃账户。',
      ssoMode: '等待身份提供方',
      ssoModeDescription: '预建待邀请账户，等待首次 OIDC 登录。',
      ssoEmailHint: '必须与身份提供方返回的已验证邮箱一致。',
      localEmailHint: '可选，用于联系和个人资料展示。',
      passwordHint: '至少 8 个字符；创建后账户立即激活。',
      ssoNoEmailNotice:
        '系统不会发送邮件。请把登录地址告知用户；其身份提供方必须返回该已验证邮箱才能完成首次登录。',
    },
    edit: {
      title: '管理 {{name}}',
    },
    roleOption: {
      user: '普通用户',
      admin: '管理员',
      manager: '资源管理员',
      userDesc: '只读资源 + 启动任务 + 管理自己的账户。',
      adminDesc: '完整权限：用户、设置、OIDC、所有任务。',
      managerDesc: '管理所有资源、记忆、仓库与任务——不含用户/系统管理，不能删除任务。',
    },
    statusOption: {
      active: '活跃',
      invited: '待首次登录',
      disabled: '已停用',
    },
    selfRoleLocked: '不能修改自己的角色 —— 需要另一位管理员代为操作。',
    selfDisableLocked: '不能停用当前正在使用的账户。',
    credentialsTitle: '登录凭据',
    credentialsOidcDescription: '此账户已经绑定身份提供方。',
    credentialsLocalDescription: '此账户使用由本系统管理的本地密码。',
    oidcResetUnavailable: '密码由已绑定的身份提供方管理，不能在本系统内重置。',
    resetPassword: '重置密码',
    setPasswordAndActivate: '设置密码并激活',
    accessTitle: '账户访问',
    disableDescription: '停用会吊销 Web 会话，并阻止之后的登录。',
    enableDescription: '启用只恢复现有登录方式；不会设置密码，也不会发送邮件。',
    passwordLoginDisabledNotice:
      '当前全局已关闭用户名密码登录。该密码只有在管理员重新开启此登录方式后才可使用。',
    reset: {
      title: '重置 {{name}} 的密码',
      activateTitle: '为 {{name}} 设置密码',
      submit: '保存新密码',
      newPassword: '新密码',
      confirmPassword: '确认新密码',
      passwordMismatch: '两次输入的密码不一致。',
      forceChange: '下次登录时必须再次修改密码',
      forceChangeHint: '用户继续使用前必须设置自己的密码。',
      sessionsWarning: '保存后会激活该账户，并吊销它的全部 Web 会话。',
    },
    disableTitle: '停用 {{name}}？',
    disableConfirm: '系统会注销 {{name}}，在另一位管理员重新启用前，该用户无法再次登录。',
    enableTitle: '启用 {{name}}？',
    enableConfirm: '这会恢复账户原有的登录方式，不会设置密码，也不会发送邮件。',
    notice: {
      'created-password': '本地账户已创建，可以立即登录。',
      'created-sso': '待邀请账户已建好，可以通过身份提供方完成首次登录。',
      updated: '用户资料已保存。',
      reset: '密码已重置，原有 Web 会话已吊销。',
      disabled: '账户已停用。',
      enabled: '账户已启用。',
    },
    noPermission: {
      title: '需要管理员权限',
      body: '该页面仅管理员角色可访问。',
    },
  },
  repos: {
    title: '远端仓缓存',
    loading: '加载中…',
    empty: '还没有远端仓缓存',
    emptyDescription: '批量导入常用远端仓库，提前准备可复用缓存并加快后续任务启动。',
    colUrl: '远端 URL',
    colLocalPath: '本地缓存路径',
    colLastFetched: '上次 fetch 时间',
    colLastAutoRefresh: '上次自动刷新',
    colRefs: '关联任务',
    colActions: '操作',
    refresh: '刷新',
    delete: '删除',
    cancel: '取消',
    confirmDelete: '确认删除',
    deleteConfirmTitle: '删除该缓存？',
    deleteConfirmBody:
      '该缓存 {{url}} 目前被 {{count}} 个历史任务引用。删除后历史任务的 worktree 与详情页保留，但后续用同一 URL 启动任务会重新克隆。',
    batchImport: {
      button: '批量导入',
      title: '批量导入远端仓',
      placeholder: '每行一个 SSH 或 HTTPS Git URL',
      start: '开始导入',
      cancel: '取消',
      close: '关闭',
      again: '再来一批',
      colIndex: '#',
      colUrl: 'URL',
      colStatus: '状态',
      colDetail: '详情',
      colActions: '操作',
      statusQueued: '等待中',
      statusCloning: '克隆中…',
      statusDoneCold: '克隆成功',
      statusDoneHit: '已缓存（已 fetch）',
      statusDoneHitFetchFail: '已缓存（fetch 失败）',
      statusFailed: '失败',
      retry: '重试',
      retryWithEdit: '修改 URL 后重试',
      batchEmpty: '请粘贴至少一行 URL',
      batchTooLarge: '单批最多 100 行',
      promptOverrideUrl: '新 URL（留空则按原 URL 重试）：',
    },
    submodule: {
      labelOk: '含 submodule',
      labelError: '⚠ submodule',
      titleOk: '上次 submodule 同步成功',
      labelPending: '含 submodule',
      titlePending: '尚未同步过 submodule',
      errorFallback: 'submodule 同步失败（无 stderr）',
    },
  },
  settings: {
    title: '设置',
    sectionNavLabel: '设置分区',
    sectionGroups: {
      execution: '执行环境',
      reliability: '可靠性',
      access: '连接与访问',
      interface: '界面',
    },
    sectionDescriptions: {
      runtime: '注册命令运行时并选择默认项。',
      systemAgents: '设置内置自动化 Agent 的运行时与输出规则。',
      limits: '设置任务、token、超时与并发边界。',
      recovery: '创建备份并配置恢复行为。',
      gc: '控制数据保留与自动清理。',
      git: '控制 submodule 的递归、并行度与后台刷新。',
      network: '设置 daemon 监听地址与端口。',
      appearance: '选择主题与界面语言。',
      rendering: '配置外部图表渲染服务。',
      authentication: '管理 OIDC 登录提供商。',
    },
    tabRuntime: '运行时',
    tabSystemAgents: '系统 Agent',
    tabLimits: '限额',
    tabRecovery: '恢复',
    tabGc: 'GC',
    tabGit: 'Git',
    tabNetwork: '网络',
    tabAppearance: '外观',
    tabMemory: '记忆',
    tabRendering: '渲染',
    tabAuthentication: '认证',
    loading: '加载中…',
    saving: '保存中…',
    saved: '已保存',
    save: '保存',
    noChanges: '没有需要保存的更改',
    invalidChanges: '请先修正当前分区中的无效值',
    outcomeUnknown: '上次保存结果尚未确认，请等待服务器核对',
    outcomeUnknownBody:
      '无法确认上次保存是否已生效。重新核对只会读取当前服务器值，不会盲目重复写入。',
    outcomeUnknownReconcile: '重新核对',
    writeBlockedBody:
      '服务器可能仍会完成上次写入。为避免后续保存被迟到结果覆盖，本连接中的设置写入已停止；请先重启 daemon，再重新载入应用。',
    staleTitle: '服务器设置已更新',
    staleBody:
      '已保留你的本地修改。继续保存只会提交当前分区拥有的字段，或放弃本地修改以采用服务器值。',
    staleDiscard: '采用服务器值',
    backupTitle: '导出备份',
    backupHint:
      '将 db.sqlite + config.json + skills/ + workflows YAML 打包为 tarball，存放到 ~/.agent-workflow/backups/。不含 worktrees / runs / logs / token。',
    backupCreate: '创建备份',
    backupRunning: '正在创建备份…',
    backupSavedAs: '已保存 ',
    restoreHint:
      '上传一个备份包，在 daemon 下次启动时恢复（不会热替换正在运行的库；恢复前会自动安全备份当前状态）。',
    restoreButton: '从备份恢复…',
    restoreBusy: '正在上传备份…',
    restoreStaged: '已暂存，重启 daemon 生效',
    restoreConfirmTitle: '确认从备份恢复整个实例？',
    restoreConfirmBody:
      '这会把整个实例回滚到备份 {{name}}（{{size}}）——所有用户的任务与资源都将回到备份时刻。恢复现在只是暂存，重启守护进程后正式生效。',
    restoreConfirmAction: '确认恢复',
    restorePendingTitle: '已暂存待恢复备份',
    restorePendingBody: '暂存于 {{when}}（{{size}}）——重启守护进程后，整个实例将回滚到该备份。',
    restorePendingSizeUnknown: '大小未知',
    restorePendingCancel: '取消暂存',
    restoreFailedTitle: '上次恢复尝试失败',
    restoreFailedBody: '{{when}} — {{error}}',
    restoreFailedNoError: '未记录错误详情',
    restoreFailedDirHint: '失败残留目录仍在磁盘上，可检查后手工清理：',
    themeLabel: '主题',
    themeHint: '系统：跟随操作系统的浅色 / 深色偏好。',
    themeSystem: '跟随系统',
    themeLight: '浅色',
    themeDark: '深色',
    languageLabel: '界面语言',
    languageHint: '切换中文 / 英文，保存即生效，无需刷新页面。',
    languageZhCN: '简体中文',
    languageEnUS: 'English',
    commitPushLangLabel: '提交信息输出语言',
    commitPushLangHint:
      '控制内置提交 agent 生成的 commit message 摘要 / 正文用哪种语言（初始提交信息与被拒后的修复信息）；Conventional-Commits 的 `<type>(<scope>):` 前缀始终保持小写英文。与界面语言独立，缺省 = English。仅对后续新生成的提交生效。',
    commitPushLangDefault: '跟随默认（English）',
    commitPushLangZhCN: '简体中文',
    commitPushLangEnUS: 'English',
    memoryDistillLangLabel: '记忆提炼输出语言',
    memoryDistillLangHint:
      '控制记忆提炼任务生成的候选记忆 title / bodyMd 用哪种语言；[category:xxx] 前缀始终保持小写英文。与界面语言独立，缺省 = English (RFC-041 默认)。仅对后续新批次生效，不回填已有记忆。',
    memoryDistillLangDefault: '跟随默认（English）',
    memoryDistillLangZhCN: '简体中文',
    memoryDistillLangEnUS: 'English',
    memoryDistillModelLabel: '记忆提炼模型',
    memoryDistillModelHint:
      '记忆提炼 agent 使用的模型，留空时跟随 opencode 的安装默认（RFC-041 基线行为）。与运行时默认模型独立配置。',
    memoryDistillRuntimeLabel: '记忆提炼运行时',
    memoryDistillRuntimeHint:
      '记忆提炼运行的运行时 profile，其 model 及其它参数都来自该 profile；留空则继承全局默认运行时。',
    runtimeInherit: '继承（全局默认）',
    systemAgents: {
      commitPushTitle: '提交推送',
      commitPushHint: '自动提交时生成 commit message、修复被拒推送的内置 agent（RFC-075）。',
      memoryTitle: '记忆提取',
      memoryHint: '从任务产物提炼长期记忆候选的内置 agent（RFC-041）。',
      mergeTitle: '合并冲突解决',
      mergeHint: '按节点隔离合并回主干、遇真实三方冲突时解决冲突的内置 agent（RFC-130）。',
      fusionTitle: '技能融合',
      fusionHint:
        '把多个技能融合成一个的内置 aw-skill-merger agent（RFC-101）；运行时写在该 agent 行上，点“保存”与其余内置 agent 一并写入。',
      fusionRuntime: '融合运行时',
      fusionRuntimeHint:
        '技能融合运行的运行时 profile，其 model 来自该 profile；留空则继承全局默认运行时。',
    },
    restartRequiredTitle: '需要重启守护进程',
    restartRequiredHint:
      '新值已写入 config.json，但 bind host / bind port 仅在下次 agent-workflow start 时生效。请在终端先 agent-workflow stop，再 agent-workflow start。',
    renderingPlantumlEndpointLabel: 'PlantUML 渲染端点',
    renderingPlantumlEndpointHint:
      '可配置的 kroki 风格 HTTP 服务（kroki.io / 自托管 kroki / plantuml-server 均兼容）；留空时评审页的 plantuml 代码块退化为源码 + 提示。',
    renderingPlantumlEndpointPlaceholder: 'https://kroki.io',
    renderingPlantumlAuthLabel: 'PlantUML Authorization 头',
    renderingPlantumlAuthHint: '可选；自托管 kroki 走基础鉴权时填 `Bearer xxx` 或 `Basic xxx`。',
    renderingPlantumlAuthPlaceholder: 'Bearer xxx',
    renderingTestButton: '测试连通性',
    renderingTestRunning: '渲染测试中…',
    renderingTestSuccess: '已返回 svg，端点可用。',
    renderingTestFailure: '渲染失败：',
    renderingTestEmptyEndpoint: '请先填写端点 URL。',
    renderingTestUnknownError: '未知',
    renderingTestTimeout: '超时',
    auth: {
      loginMethodsTitle: '登录方式',
      loginMethodsHint: '控制登录页向用户开放哪些凭据入口。策略修改立即生效，无需重启 daemon。',
      passwordLoginLabel: '用户名和密码登录',
      passwordLoginHint: '关闭后，登录页和密码登录 API 都只接受已启用的身份提供方。',
      passwordLoginLockedHint: '尚无已启用的身份提供方，用户名密码登录必须保持开启。',
      bootstrapTokenLabel: '初始化 Token',
      bootstrapTokenHint: '仅用于首次创建管理员；交接完成后不能再次启用。',
      bootstrapPending: '等待交接',
      bootstrapRetired: '已永久退役',
      lastProviderRequired: '密码登录关闭时，必须保留至少一个已启用的身份提供方。',
      disablePasswordTitle: '关闭用户名密码登录？',
      disablePasswordDescription:
        '关闭后，所有用户只能通过已启用的身份提供方登录。现有密码不会被删除，重新开启后仍可使用。',
      disablePasswordConfirm: '关闭密码登录',
      providersTitle: 'OIDC 身份提供商',
      providersHint:
        '配置用户可用来登录的外部身份提供商。每条记录保存 OAuth 2.0 / OIDC 的 client_id + client_secret + scopes；secret 在落盘前会用 AES-256-GCM 加密。',
      add: '添加提供商',
      empty: '还没有配置任何提供商。添加一条以启用单点登录。',
      colSlug: '标识',
      colName: '显示名',
      colIssuer: 'Issuer',
      colProvisioning: '准入策略',
      colEnabled: '状态',
      enabled: '启用',
      disabled: '停用',
      edit: '编辑',
      delete: '删除',
      deleteConfirm: '确定要删除提供商 "{{name}}" 吗？',
      addTitle: '添加 OIDC 提供商',
      editTitle: '编辑 OIDC 提供商',
      testConnection: '测试连接',
      cancel: '取消',
      save: '保存',
      groupProvider: '提供商',
      groupProviderHint:
        '在 URL 和登录页按钮上标识该 IdP。Issuer URL 是 daemon 拉取 OIDC discovery 的起点。',
      slug: '标识符',
      slugHint: '用于 /api/auth/oidc/<标识符>/callback；仅限小写字母/数字/连字符。',
      displayName: '显示名',
      displayNameHint: '登录页按钮上的文字。',
      issuerUrl: 'Issuer URL',
      issuerUrlHint: 'daemon 会请求 <issuer>/.well-known/openid-configuration。',
      groupManualEndpoints: '手动端点（可选）',
      groupManualEndpointsHint:
        'discovery 失败或缺字段时逐字段启用。纯 OAuth 2.0 IdP 至少需填 authorize + token + userinfo。',
      authorizationEndpoint: '授权端点',
      tokenEndpoint: 'Token 端点',
      userinfoEndpoint: 'Userinfo 端点',
      userinfoRequestStyle: 'Userinfo 请求方式',
      userinfoRequestStyleHint:
        '标准：GET + Authorization: Bearer 头。POST JSON：POST 请求、JSON body 含 { client_id, access_token, scope } 三成员且不带鉴权头——用于 userinfo 接口非标准的平台。',
      userinfoStyleGet: 'GET + Bearer',
      userinfoStylePost: 'POST JSON',
      jwksUri: 'JWKS URI',
      groupCreds: '凭据',
      groupCredsHint:
        'daemon 用来访问 IdP 的 OAuth 2.0 客户端凭据。Secret 落盘前 AES-256-GCM 加密。',
      clientId: 'Client ID',
      clientSecret: 'Client Secret',
      clientSecretEditHint: '留空则保留现有值',
      scopes: 'Scopes',
      scopesHint:
        '空格分隔。OIDC IdP 必须包含 openid；纯 OAuth 2.0 IdP 按其文档填写（不支持时勿带 openid）。',
      groupBehavior: '行为',
      provisioning: '准入策略',
      optInvite: '邀请制（推荐）',
      optAllowlist: '域名白名单',
      optAuto: '自动',
      inviteDesc: '只有预先创建、已验证邮箱匹配的用户才能登录。',
      allowlistDesc: '已验证邮箱命中允许域名的用户自动开通账号。',
      autoDesc: '任何成功完成 IdP 登录的用户都自动开通。仅在 IdP 完全可信时使用。',
      allowedDomains: '允许的邮箱域名',
      allowedDomainsHint: '逗号分隔，每个域名以 @ 开头；同时要求 email_verified=true。',
      trustEmailLabel: '信任邮箱已验证',
      trustEmailHint:
        '该 IdP 返回的 email 一律视为已验证（纯 OAuth 2.0 IdP 配合邀请制/白名单时必开）。若 IdP 允许用户自填未验证邮箱请勿开启。',
      usernameClaim: '呈现名字段',
      usernameClaimHint:
        '从身份响应读取呈现名的字段名，可空格分隔多个、按序拼接（如 name signature）。留空用标准 preferred_username。配置后每次登录跟随 IdP 刷新呈现名。',
      subjectClaim: '用户标识字段',
      subjectClaimHint:
        'userinfo 中承载用户唯一 ID 的字段名（如 id）。留空用标准 sub。仅纯 OAuth 2.0 IdP 需要配置——配置后不再走 id_token 验签，且存在关联身份后不可再改。',
      enabledLabel: '启用',
      enabledHint: '开启后会出现在登录页；关闭则隐藏。',
      testOk: '连接成功',
      testFail: '连接失败',
      testReady: '当前配置可完成登录',
      testNotReady: '当前配置无法完成登录',
      testDiscoveryOk: 'discovery：可达',
      testDiscoveryDown: 'discovery 不可用——正在使用手动端点',
      testDiscoveryError: 'discovery 不可达：{{error}}',
      testDetailIssuer: 'issuer：',
      sourceManual: '（手动）',
      sourceDiscovery: '（discovery）',
      testEndpointMissing: '未配置',
      testJwksUnreachable: 'JWKS 已配置但不可达——携带 id_token 的登录将失败。',
    },
    sandbox: {
      title: '运行时沙箱',
      chipActive: '沙箱：{{mechanism}}',
      chipUnavailable: '沙箱不可用',
      chipOff: '沙箱关闭',
      modeLabel: '沙箱模式',
      modeEnforce: '强制',
      modeWarn: '告警',
      modeOff: '关闭',
      modeHint:
        '强制（enforce）：沙箱机制不可用时拒绝启动新任务；告警（warn）：不可用时降级为无沙箱运行并发出告警；关闭（off）：从不启用沙箱。',
      enforceUnavailable: '本机未探测到可用的沙箱机制，强制档位下新任务启动将被拒绝。',
    },
  },
  onboarding: {
    title: '欢迎使用 Agent Workflow',
    intro: '看起来这是新装的实例 —— 还没有任何代理或工作流。花几分钟跟着引导走一遍，边做边学。',
    heroTitle: '把多代理流水线画出来、跑起来',
    heroIntro:
      '每个代理跑在独立进程里、上下文彼此干净；快照 → 执行 → 扇出 → 聚合交给确定性引擎编排，评审与反问随时把人拉回环内。',
    startCta: '开始引导',
    tracksIntro:
      '引导分四条线：造一个能干活的代理、给代理装一个技能、把代理串成流水线、让一组代理协作。每条线都能单独走，随时可以退出。',
    skipLink: '先自己逛逛，打开代理列表 →',
  },
  tour: {
    ariaLabel: '上手引导',
    progress: '第 {{current}} / {{total}} 步',
    goToPage: '带我去这一步的页面',
    skip: '退出引导',
    back: '上一步',
    next: '下一步',
    done: '完成',
    firstTask: {
      openAgents: {
        title: '先去代理列表',
        body: '点侧边栏高亮的「代理」。代理是干活的角色，第一步先建一个。',
      },
      newAgent: { title: '新建一个代理', body: '点高亮的「新建代理」按钮。' },
      name: {
        title: '给它起个名字',
        body: '在高亮的名称框里填个名字（小写字母/数字/连字符），比如 my-coder。',
      },
      portsTab: {
        title: '打开端口配置',
        body: '点高亮的「端口」页签。输出端口是代理把结果交出来的通道——至少要有一个，工作流里才连得出边。',
      },
      addPort: {
        title: '加一个输出端口',
        body: '点高亮的按钮加一个输出端口，比如 result。加好后回到「基础」页签。',
      },
      saveAgent: {
        title: '保存这个代理',
        body: '填好后点高亮的「创建」按钮。保存后会自动进入下一步。',
      },
      launch: {
        title: '用它启动一个任务',
        body: '在代理详情页点高亮的「启动任务」，我们用一块临时空间跑一次、不用接仓库。',
      },
      submit: {
        title: '启动任务',
        body: '我们已帮你填好任务名和一段示例提示词，并选了临时空间（不用接仓库），可以直接点高亮的「启动」。想改提示词也行。',
      },
      result: {
        title: '看它跑起来',
        body: '这里是任务的实时状态。跑完你能看到每个节点的产出与 diff——你已经走通了一整条链路！',
      },
      seedTaskName: '我的第一个任务',
      seedTaskPrompt: '新建一个名为 HELLO.md 的文件，在里面写一句简短友好的问候语。',
    },
    buildWorkflow: {
      openWorkflows: {
        title: '去工作流',
        body: '点侧边栏高亮的「工作流」。工作流把多个代理连成一条流水线。',
      },
      newWorkflow: {
        title: '新建一个工作流',
        body: '点高亮的「新建工作流」，填个名字创建。',
      },
      template: {
        title: '从模板开始',
        body: '空画布上点「从模板开始」，选一套现成的多代理流水线；之后在画布上拖节点、连端口，再点右上角启动。',
      },
    },
    useWorkgroup: {
      openWorkgroups: {
        title: '去工作组',
        body: '点侧边栏高亮的「工作组」。工作组是一队代理协作完成一个目标。',
      },
      newWorkgroup: {
        title: '新建一个工作组',
        body: '点高亮的「新建工作组」，填个名字创建。',
      },
      addMember: {
        title: '加成员',
        body: '点高亮的「添加代理成员」，至少加两个（一个当组长、一个干活）。',
      },
      launch: {
        title: '交给它一个目标',
        body: '点高亮的「启动」，写一句目标，剩下的分工交给组长。',
      },
    },
  },
  guide: {
    // RFC-211 §12 impl-gate P3-1（2026-07-21）：沙盒时代死键随 example 概念一并清除，仅存 tour 启动页 9 个活键。
    title: '上手引导',
    handholdIntro: '想让我在真实界面上一步步带你走一遍？从建代理到启动任务、看结果，全程高亮指引。',
    startTour: '手把手带我走一遍',
    track: {
      agent: '造一个能干活的代理',
      agentDesc: '创建代理、看懂输出端口，然后让它真跑一次。',
      workflow: '把代理串成流水线',
      workflowDesc: '一个代理干活、另一个代理评审，在画布上连起来并启动。',
      workgroup: '让一组代理协作',
      workgroupDesc: '组一个小队，指定组长与成员，然后交给它一个目标。',
    },
  },
  common: {
    searchEllipsis: '搜索…',
    searchCards: '搜索名称、描述或配置…',
    noMatches: '无匹配项',
    retry: '重试',
    clearSearch: '清除搜索',
    clearFilters: '清除筛选',
    backToList: '返回列表',
    redirectingToLogin: '正在前往登录页…',
    itemsCount_one: '{{count}} 项',
    itemsCount_other: '{{count}} 项',
    loading: '加载中…',
    open: '打开',
    edit: '编辑',
    delete: '删除',
    save: '保存',
    saved: '已保存',
    saving: '保存中…',
    creating: '创建中…',
    unknownError: '未知错误',
    resumeFailedAfterSubmit:
      '已提交成功，但任务续跑失败（{{code}}）。请到任务详情页点「继续执行」，或使用「诊断」修复。',
    yes: '是',
    no: '否',
    details: '详情',
    emDash: '—',
    shaRangeLabel: '从 {{from}} 到 {{to}}',
    updated: '最近更新',
    relTime: {
      justNow: '刚刚',
      minAgo: '{{n}} 分钟前',
      hourAgo: '{{n}} 小时前',
      dayAgo: '{{n}} 天前',
      inMin: '{{n}} 分钟后',
      inHour: '{{n}} 小时后',
      inDay: '{{n}} 天后',
    },
    dur: {
      sec: '{{s}} 秒',
      min: '{{m}} 分钟',
      hourMin: '{{h}} 小时 {{m}} 分',
      dayHour: '{{d}} 天 {{h}} 小时',
    },
    launch: '启动',
    launchResource: '启动 {{name}}',
    resourceUnavailable: '该资源不可用或已被删除。',
    copy: '复制',
    copied: '已复制！',
    empty: '（空）',
    optionalPlaceholder: '（可选）',
    confirmPrompt: '确认？',
    confirmDelete: '确认删除',
    deleteConfirm: {
      title: '删除 {{name}}？',
      body: '此操作不可撤销。请在下方输入名称以确认删除。',
      inputLabel: '输入 {{name}} 以确认',
    },
    close: '关闭',
    cancel: '取消',
    selectAnOption: '请选择',
    ariaActions: '操作',
    ariaExpandColumn: '展开',
    removeAria: '移除 {{label}}',
    duplicateError: '重复：{{token}}',
    invalidJson: 'JSON 无效',
    jsonMustBeObject: '必须是 JSON 对象',
    emptyResource: '暂无{{title}}。',
    startedAt: '开始时间',
    finishedAt: '完成时间',
    expandText: '展开全文',
    collapseText: '收起',
  },
  // RFC-173：共享 <MultiSelect> 标签多选框（资源选择器）。
  multiSelect: {
    empty: '无可选项',
    addCustom: '添加「{{token}}」',
    searchHint: '输入以搜索…',
  },
  // RFC-169：资源页双栏骨架（脏标记 + 未保存守卫 + 空态引导）。
  splitPage: {
    dirtyDot: '有未保存修改',
    noDescription: '（未填写描述）',
    itemsCount_one: '{{count}} 项',
    itemsCount_other: '{{count}} 项',
    kind: {
      agent: '代理',
      skill: '技能',
      mcp: 'MCP',
      plugin: '插件',
    },
    unsavedTitle: '有未保存的修改',
    unsavedBody: '当前有未保存的修改，离开本页将丢弃它们。',
    unsavedBusyBody: '保存操作仍在进行中，请等待完成后再离开本页。',
    unsavedForceLeave: '仍要离开',
    unsavedForceLeaveWarning:
      '这次写入已经明显卡住。离开会取消等待，但无法确定服务端是否已经写入成功——离开后请刷新确认实际结果，再决定是否重试。',
    unsavedStay: '留在本页',
    unsavedDiscard: '放弃修改',
    emptyPaneTitle: '未选择任何项',
    emptyPaneHint: '从列表中选择一项以查看详情。',
  },
  // RFC-112：运行时注册表（设置 → 运行时列表 + 增改对话框）。
  runtimes: {
    title: '运行时',
    subtitle:
      '注册 opencode / Claude Code 二进制——包括改名的定制 fork。Agent 按名称选用运行时，框架以对应协议驱动它。',
    add: '+ 添加运行时',
    protocolOpencode: 'opencode',
    protocolClaude: 'Claude Code',
    defaultBinary: '默认（PATH / 已配置）',
    smokeUntested: '未测试',
    test: '测试',
    edit: '编辑',
    delete: '删除',
    deleteTitle: '删除运行时“{{name}}”？',
    deleteDescription: '删除后无法恢复。若仍有 Agent 或默认配置引用该运行时，系统会阻止删除。',
    addTitle: '添加运行时',
    editTitle: '编辑运行时',
    testBinary: '测试二进制',
    testing: '测试中…',
    fieldName: '名称',
    fieldNameHint: '小写、URL 安全（a-z、0-9、-）。Agent 以此名称引用该运行时。',
    fieldProtocol: '协议',
    fieldProtocolHint: '该二进制遵循哪种运行时协议——opencode 或 Claude Code。',
    fieldBinary: '二进制路径',
    fieldBinaryHint: '可执行文件的绝对路径。留空则用该协议的默认二进制（PATH）。',
    fieldConfigDirEnv: '配置目录环境变量',
    fieldConfigDirEnvHint: '自定义二进制读取配置目录路径所用的环境变量名。留空则用协议默认。',
    fieldConfigDirName: '配置目录名',
    fieldConfigDirNameHint: '每次运行根目录下的配置目录叶子名（单层目录名）。留空则用协议默认。',
    configDirEnvInvalid: '必须是合法的环境变量名（字母、数字、下划线，不以数字开头）。',
    configDirEnvReserved: '该变量名被平台保留（会与注入机制冲突），请换一个。',
    configDirNameInvalid: '必须是单层目录名：不能含路径分隔符，也不能是 "." 或 ".."。',
    fieldModel: '模型',
    fieldModelHint: '该运行时上的 agent 启动时所用模型。OpenCode 必须显式选择模型。',
    modelRequired: '请先选择显式模型，再保存或测试此 OpenCode 运行时。',
    modelRequiredChip: '需要模型',
    fieldVariant: '变体',
    fieldTemperature: '温度',
    fieldSteps: '步数',
    fieldMaxSteps: '最大步数',
    claudeModelOnlyHint: 'Claude Code 运行时只用模型 —— 变体 / 温度 / 步数 不生效。',
    newRuntimeModelHint: '先保存运行时，再编辑它以从该二进制自己的模型列表里选择。',
    claudeStaticModelHint: '模型列表是 Anthropic 的静态集 —— 未按该二进制探测。',
    isDefault: '默认',
    setDefault: '设为默认',
    enable: '启用',
    disable: '禁用',
    disabled: '已禁用',
    defaultCannotDisable: '默认运行时不可禁用，请先更改默认。',
    smoke: {
      conforms: '符合',
      'spawn-failed': '无法启动',
      'auth-missing': '缺少鉴权',
      'network-blocked': '网络不可达',
      'model-call-failed': '模型调用失败',
      'stream-nonconforming': '不符合',
      'execution-identity-failed': '执行身份校验失败',
    },
  },
  agents: {
    title: '代理',
    newButton: '+ 新建代理',
    emptyList: '还没有代理。创建一个开始吧。',
    emptyDescription: '定义可复用的角色、提示词与端口，供工作流和工作组调度。',
    cardPorts: '输入 {{inputs}} · 输出 {{outputs}}',
    colName: '名称',
    colDescription: '描述',
    colOutputs: '输出端口',
    colRuntime: '运行时',
    runtimeDefaultTag: '默认',
    builtin: '内置',
    loadingAgent: '加载代理中…',
    saveButton: '保存修改',
    newTitle: '新建代理',
    createButton: '创建代理',
  },
  skills: {
    title: '技能',
    newButton: '+ 新建技能',
    emptyList: '还没有技能。',
    emptyDescription: '创建或导入可复用的专业知识，再把它分配给代理。',
    cardVersion: '内容 v{{version}}',
    colName: '名称',
    colSource: '来源',
    colDescription: '描述',
    colPath: '路径',
    newTitle: '新建技能',
    tabManaged: '手动创建',
    tabExternal: '外部',
    detailTabEdit: '编辑',
    detailTabFiles: '文件',
    detailTabHistory: '历史',
    technicalInformation: '技术信息',
    managedPath: '托管路径',
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
    tabFolder: '父目录',
    fieldFolderPath: '父目录路径',
    fieldFolderPathHint: '父目录的绝对路径；它的每个含 SKILL.md 的直接子目录都会被自动纳管。',
    fieldFolderLabel: '名称（可选）',
    fieldFolderLabelHint: '用于在列表里识别这个目录；默认取末段目录名。',
    folderPathPlaceholder: '/abs/path/to/skills-parent',
    createFolderButton: '登记父目录',
    sourcesTitle: '技能父目录',
    sourcesEmpty: '还没有登记父目录。',
    sourceChildCount: '{{n}} 条子技能',
    sourceLastScannedAt: '最后扫描于 {{when}}',
    sourceNeverScanned: '尚未扫描',
    sourceRescan: '重新扫描',
    sourceRemove: '解除登记',
    sourceRemoveConfirmTitle: '解除登记 "{{label}}"？将删除它带进来的全部子技能。',
    sourceRemoveConfirmBlocked: '无法解除登记：以下子技能仍被代理引用，请先解绑。',
    sourceSkippedBanner: '本次扫描跳过 {{n}} 条候选',
    sourceConflictReplace: '替换',
    sourceConflictNoPermission: '无权限替换（你不是该技能的所有者）',
    sourceSkippedDetails: '展开详情',
    sourceFromPill: '来自 {{label}}',
    sourceReadonlyHint: '此技能由父目录纳管，请在外部目录里编辑文件。',
    tabZip: '导入 ZIP',
    importTitle: '导入技能',
    importSubtitle: '一次导入一个或多个托管 Skill；写入前会先检查目录结构和同名冲突。',
    zipDropTitle: '拖放 ZIP 到这里，或选择文件',
    zipDropHint: '单个 .zip · 最大 {{limit}}',
    zipChoose: '选择 ZIP',
    zipReplace: '更换 ZIP',
    zipRemove: '移除',
    zipStructureTitle: '正确目录结构',
    zipManagedHint: '导入后的 Skill 均由本平台托管。',
    zipWrongType: '请选择名称以 .zip 结尾的文件。',
    zipTooLarge: '这个压缩包超过 {{limit}}。',
    zipCheck: '检查 ZIP 内容',
    zipChecking: '检查中…',
    zipCheckingStatus: '正在检查压缩包结构和同名冲突…',
    zipRetry: '重试',
    zipImportButton: '导入 {{n}} 个技能',
    zipImporting: '导入中…',
    zipReviewSummary: '导入检查摘要',
    zipCandidatesCount: '{{count}} 个候选',
    zipConflictsCount: '{{count}} 个同名冲突',
    zipArchiveErrorsCount: '{{count}} 项未通过',
    zipArchiveErrorsTitle: '有 {{count}} 项未通过检查',
    zipNoCandidatesTitle: '没有可导入的 Skill',
    zipNoCandidates: 'zip 中未找到任何技能候选。',
    zipStatusReady: '可导入',
    zipDescriptionEmpty: '未填写描述',
    zipCandidateFacts: '{{files}} 个文件 · {{size}}',
    zipActionFor: '{{name}} 的导入动作',
    zipRenameFor: '{{name}} 的新名称',
    zipActionImport: '作为新技能导入',
    zipActionSkip: '跳过',
    zipActionOverwrite: '覆盖',
    zipActionRename: '重命名',
    zipOverwriteTargetFor: '为 {{name}} 选择要覆盖的 Skill',
    zipOverwriteTargetPlaceholder: '请选择具体 Skill',
    zipOverwriteTargetOption: '{{name}} · 所有者 {{owner}} · {{visibility}} · {{id}}',
    zipVisibilityPublic: '公开',
    zipVisibilityPrivate: '私有',
    zipRenameTo: '新名称',
    zipRenameEmpty: '请输入名称',
    zipRenameInvalid: '需为 kebab-case',
    zipRenameDup: '与本批次其他重名',
    zipRenameConflict: '名称已被占用',
    zipConflictManaged: '同名 Skill',
    zipConflictManagedReadonly: '同名且无权覆盖',
    zipNamesLoading: '正在加载已有 Skill 名称…',
    zipNamesUnavailable: '暂时无法验证重命名目标；重试成功后才能导入。',
    zipNamesStale: '已有名称刷新失败；当前使用缓存校验，服务端仍会在写入前最终确认。',
    zipActionSummary: '将新建 {{creating}} · 覆盖 {{updating}} · 跳过 {{skipping}}',
    zipOverwriteWarning: '将替换 {{count}} 个已有 Skill。',
    zipBack: '返回',
    zipResultSuccess: '导入完成',
    zipResultPartial: '部分导入完成',
    zipResultNoWrite: '本次没有写入 Skill',
    zipResultFile: '来源：{{name}}',
    zipResultCreatedCount: '新建 {{count}}',
    zipResultUpdatedCount: '更新 {{count}}',
    zipResultSkippedCount: '跳过 {{count}}',
    zipResultFailedCount: '失败 {{count}}',
    zipResultFailures: '有 {{count}} 个 Skill 导入失败，请查看下方原因。',
    zipResultCreated: '新建',
    zipResultUpdated: '更新',
    zipResultSkipped: '跳过',
    zipResultFailed: '失败',
    zipResultCreatedChip: '新建',
    zipResultUpdatedChip: '更新',
    zipContinue: '继续导入',
    zipReturnList: '返回技能列表',
    zipOpenSkill: '打开已导入的 Skill {{name}}',
    fileDiscardConfirm: '放弃未保存的修改？',
    fileTargetUnavailable: '该文件已不可用，请刷新列表后重试。',
    fileErrPathRequired: '路径必填',
    fileErrRelativeOnly: '仅允许相对路径；不能包含 ".."',
    fileErrMainFileProtected: 'SKILL.md 请在「编辑」页签中修改，不能在文件树中操作',
    fileErrAlreadyExists: '该路径已存在或已经加入待保存更改。',
    fileTreeHeader: '文件',
    fileTreeEmpty: '暂无文件。',
    fileNewPathPlaceholder: 'path/to/new-file.md',
    fileAddButton: '+ 新增',
    fileStageAddButton: '加入待保存更改',
    fileEditorEmpty: '请在左侧选择文件，或新增一个。',
    fileLoadingNamed: '正在加载 {{name}}…',
    fileDeleteButton: '删除文件',
    fileStageDeleteButton: '标记删除',
    filePendingCreate: '新建 · 待保存',
    filePendingUpdate: '已修改 · 待保存',
    filePendingDelete: '删除 · 待保存',
    fileUndoPending: '撤销待保存更改',
    fileDeleteStagedTitle: '“{{path}}”已标记删除',
    fileDeleteStagedDescription: '文件尚未删除；点击「保存所有更改」后才会生效。',
    fileStaleWarning: '服务端文件已变化，请检查当前草稿后再保存。',
    saveAllChanges: '保存所有更改',
    saveNothingToSave: '当前没有未保存的更改。',
    saveStageNewPathFirst: '请先把已输入的文件路径加入待保存更改，或清空路径。',
    saveBusy: '请等待当前 Skill 操作完成。',
    saveTokenMissing: '请重新加载 Skill，以取得安全保存所需的令牌。',
    saveOutcomeUnknown: '保存结果未知',
    saveOutcomeUnknownDescription: '暂时不要重试。请核对稳定的服务端快照，确认上一步是否已生效。',
    saveOutcomeStillUnknown: '核对期间 Skill 持续变化，保存结果仍然未知。',
    recheckOutcome: '重新核对服务端状态',
    recheckingOutcome: '核对中…',
    saveRemoteDifferent: '稳定的服务端状态与本次提交不同，已保留你的本地草稿。',
    saveStaleWarning: '服务端在草稿期间已发生变化，请检查后再保存。',
    saveAllComplete: '已保存 {{count}} 项更改。',
    savePartial: '已保存 {{saved}} 项 · {{remaining}} 项未保存。',
    discardAllChanges: '放弃所有更改',
    historyBlockedTitle: '版本历史需要稳定的 Skill 状态',
    historyBlockedDirty: '请先保存或放弃全部待保存更改，再查看版本。',
    historyBlockedBusy: '请等待当前 Skill 操作完成。',
    historyBlockedOutcomeUnknown: '请先核对结果未知的保存操作，再查看版本。',
    zipParseFailedFallback: '解析 zip 失败',
    zipCommitFailedFallback: '提交失败（{{status}}）',
    zipErrorWholeArchiveLabel: '(zip)',
    versionsSection: '版本历史',
    versionsEmpty: '暂无版本历史。',
    versionLabel: 'v{{n}}',
    versionCurrent: '当前',
    versionSourceInitial: '创建',
    versionSourceEditor: '编辑',
    versionSourceFusion: '融合',
    versionSourceRestore: '回退',
    versionRestoredFrom: '回退自 v{{n}}',
    versionCompare: '与当前对比',
    versionRestore: '回退到此版本',
    versionRestoreConfirm: '将技能回退到 v{{n}}？这会以 v{{n}} 的内容生成一个新版本。',
    versionDiffTitle: '技能 diff：v{{from}} → v{{to}}',
    versionBy: '由 {{who}}',
    versionRestoreReasonPlaceholder: '回退原因（可选）',
    versionRestoreFusionNote: 'v{{n}} 之后被融合的记忆将被解融合并退回审批池。',
  },
  fusion: {
    launchButton: '融合进技能',
    launchFromSkillButton: '融合记忆',
    launchTitle: '把记忆融合进技能',
    fieldSkill: '目标技能',
    fieldSkillHint: '只能融合进 managed 技能。',
    pickSkillPlaceholder: '选择一个 managed 技能',
    noManagedSkills: '没有你可写的 managed 技能。',
    fieldMemories: '要融合的记忆',
    fieldMemoriesHint: '你可管理的已批准记忆。',
    noSelectableMemories: '没有可管理的已批准记忆。',
    selectedCount: '已选 {{n}} 条',
    fieldIntent: '意图',
    fieldIntentHint: '描述融合目标；agent 编辑前必须先与你确认。',
    intentPlaceholder: '例如：把这些 lint 偏好整理进技能、去重、按类别归类',
    submit: '开始融合',
    submitting: '启动中…',
    needSkill: '请选择目标技能。',
    needMemories: '至少选择一条记忆。',
    detailTitle: '融合',
    backToSkill: '返回技能',
    status: {
      running: '执行中',
      awaiting_approval: '待批准',
      applying: '应用中',
      done: '已完成',
      rejected: '已退回',
      canceled: '已取消',
      failed: '失败',
    },
    iteration: '第 {{n}} 轮',
    runningHint: 'skill-merger agent 正在工作。若它提问，请到「反问」中回答。',
    clarifyLink: '打开反问',
    proposedHeading: '改动预览（当前 → 提议）',
    changelogHeading: '变更摘要',
    incorporatedHeading: '已吸收记忆（{{n}}）',
    skippedHeading: '已跳过记忆（{{n}}）',
    approve: '批准并应用',
    approving: '应用中…',
    reject: '退回并修改',
    rejectTitle: '退回并重跑',
    rejectFeedbackPlaceholder: 'agent 应如何修改？',
    rejectSubmit: '提交并重跑',
    cancel: '取消融合',
    cancelConfirm: '取消这次融合？',
    appliedVersion: '已应用为 v{{n}}',
    fusedChip: '已融合 → {{skill}} v{{n}}',
    errorHeading: '错误',
  },
  mcps: {
    title: 'MCP 服务器',
    newButton: '+ 新建 MCP',
    emptyList: '还没有登记的 MCP 服务器。',
    emptyDescription: '登记本地或远程 MCP 服务，让代理可以调用其工具。',
    colName: '名称',
    colType: '类型',
    colDescription: '描述',
    colEnabled: '启用',
    typeLocal: '本地 (stdio)',
    typeRemote: '远端 (http / sse)',
    disabledChip: '已禁用',
    detailTabConfig: '配置',
    detailTabProbe: '工具与探测',
    deleteButton: '删除',
    deleteConfirm: '删除该 MCP？',
    deleteReferenced: '无法删除：以下 agent 仍在引用，请先解除引用：',
    newTitle: '新建 MCP 服务器',
    fieldName: '名称',
    fieldNameHint:
      '小写字母 / 数字 / `-` / `_`，需以字母数字开头。同时是工具命名前缀（详见下方说明）。',
    fieldDescription: '描述',
    fieldType: '类型',
    fieldEnabled: '启用',
    fieldEnabledHint: '禁用时本 MCP 不会注入到 opencode 子进程（agent 看不到它的工具）。',
    fieldCommand: '启动命令',
    fieldCommandHint: '至少 1 项。第一项是可执行文件名，后续为参数，例如 `uvx postgres-mcp`。',
    fieldEnv: '环境变量',
    fieldEnvHint: '每行 KEY=VALUE。可能含凭据，不会写入日志（仅 mcpKeys 名字会被记录）。',
    fieldTimeoutMs: '超时（毫秒）',
    fieldUrl: 'URL',
    fieldUrlHint: '必须以 http:// 或 https:// 开头。',
    fieldHeaders: '请求头',
    fieldHeadersHint: '每行 KEY=VALUE。用于 Bearer / PAT 凭据等。',
    fieldOauth: 'OAuth',
    fieldOauthHint:
      'v1 简化：默认留空（启用 opencode 自动 OAuth 探测）；填 false 显式禁用。完整 OAuth 流程请用 `opencode mcp auth <name>` 在主机本地登录。',
    saveButton: '保存修改',
    createButton: '创建 MCP',
    toolNamingHint:
      '在 agent 的 permission 字段里点名某 MCP 工具时，使用 `{name}_{tool_name}`（opencode 自动按 mcp 名 + 工具名拼接，详见 docs/OPENCODE_CONFIG.md §3.3）。',
    cwdHint:
      'stdio 子进程会在该 task 的 worktree 目录下启动（opencode 端没有 cwd 字段，所以这里也不提供）。',
    oauthCliHint:
      'remote MCP 走 OAuth 时，建议先在主机上执行 `opencode mcp auth <name>` 完成一次浏览器登录，token 会落到 ~/.opencode/auth/，之后所有 opencode 子进程都能复用。',
    oauthModeAuto: '自动',
    oauthModeDisabled: '禁用',
    errors: {
      nameRequired: '名称必填。',
      commandRequired: '启动命令至少需要一个可执行项。',
      urlRequired: 'URL 必填。',
      urlScheme: 'URL 必须以 http:// 或 https:// 开头。',
      timeoutInvalid: '超时必须是大于 0 的整数毫秒数。',
    },
    // RFC-030 — probe columns + expand block.
    colStatus: '状态',
    colLatency: '延时',
    colToolCount: '工具',
    probe: {
      latencyMs: '{{ms}} ms',
      latencySec: '{{s}} s',
      btnRun: '重新探测',
      btnRunning: '探测中…',
      saveAndRun: '保存并探测',
      useSaved: '仍使用已保存版本',
      basisSavedTitle: '基于已保存配置',
      basisSavedBody: '本次探测会严格使用保存版本',
      basisDirtyTitle: '当前改动尚未保存',
      basisDirtyBody: '直接探测仍会使用已保存版本；也可以先保存当前改动再探测。',
      basisUnavailable: '暂时无法确认操作版本，请重新加载该 MCP 后再探测。',
      resultStale: '探测完成后 MCP 已出现更新；旧结果已丢弃，正在刷新当前状态。',
      savedResultExpired: '已保存的探测结果已过期。',
      savedResultExpiredHint: '该 MCP 在上次探测后又被保存过，请重新探测后再使用其接口清单。',
      draftChangedDuringSave: '保存期间表单又发生了修改；未发起探测，请确认后重试。',
      viewFull: '查看完整接口',
      expandRow: '展开行',
      collapseRow: '折叠行',
      expandNotProbed: '尚未探测过，点右侧"重新探测"获取该 MCP 的工具清单。',
      expandNoTools: '该 MCP 未暴露任何工具。',
      moreCount: '+{{count}}',
      status: {
        unknown: '未探测',
        probing: '探测中',
        ok: '在线',
        error: '失败',
      },
      lastProbed: '最近探测：{{at}}',
      neverProbed: '尚未探测。',
      neverProbedHint: '运行一次探测，查看此 MCP 实际提供的工具、资源和提示模板。',
      section: {
        tools: '工具',
        resources: '资源',
        prompts: '提示',
        capabilities: '能力',
      },
      tools: {
        empty: '没有工具。',
        descriptionEmpty: '（未提供描述）',
        showSchema: '查看 inputSchema',
        hideSchema: '收起 inputSchema',
        noInputSchema: '（该工具未声明 inputSchema）',
      },
      resources: {
        empty: '没有资源。',
        templatesHeading: '资源模板',
      },
      prompts: {
        empty: '没有提示模板。',
        argumentsHeading: '参数',
        argumentRequired: '必填',
      },
      capabilities: {
        empty: '没有上报 capabilities。',
      },
      error: {
        title: '探测失败',
        showDetail: '查看详情',
        hideDetail: '收起详情',
        codeConnectFailed: '连接失败：进程未起来或网络拒绝。',
        codeHandshakeFailed: '握手失败：连接建立后 initialize 没在限定时间内返回。',
        codeAuthRequired: '需要鉴权：服务端返回 401/403 或 OAuth 未完成。',
        codeTimeout: '总耗时超过 60 秒上限。',
        codePartial: '部分清单不可用（服务端未实现该方法），其它接口仍可用。',
        codeInternalError: '探测出现未预期错误。',
        codeMcpDisabled: '该 MCP 已被禁用，需先在编辑页启用。',
      },
    },
  },
  plugins: {
    title: '插件',
    newButton: '+ 新建插件',
    emptyList: '尚未登记任何插件。',
    emptyDescription: '登记 npm、本地或 Git 插件，并按需分配给代理。',
    colName: '名称',
    colSpec: 'Spec',
    colSource: '来源',
    colVersion: '版本',
    colEnabled: '启用',
    disabledChip: '已禁用',
    updateAvailableChip: '有可用更新',
    detailTabConfig: '配置',
    detailTabUpdates: '更新',
    formTitleNew: '新建插件',
    formTitleEdit: '编辑插件',
    newTitle: '新建插件',
    fieldName: '名称',
    fieldSpec: 'Spec',
    fieldSpecHint:
      'npm 包（pkg@1.2.3 / @scope/pkg@x）/ 本地路径（file:///abs 或 ./rel）/ Git URL（git+https / github:org/repo）',
    fieldDescription: '描述',
    fieldOptions: 'Options（JSON 对象）',
    fieldOptionsHint:
      '传给 opencode 插件的配置对象；非空时框架以 [file://..., options] 元组形式注入；为空对象时仅注入路径字符串。',
    fieldEnabled: '启用',
    createButton: '创建',
    creating: '安装中…',
    saveButton: '保存',
    saving: '保存中…',
    cancelEdit: '取消编辑',
    checkUpdateButton: '检查更新',
    saveAndCheckButton: '保存并检查',
    checking: '检查中…',
    upgradeButton: '升级',
    reinstallBaselineButton: '重新安装并建立基线',
    upgrading: '升级中…',
    executionBasisDirtyTitle: '草稿与已保存插件不同',
    executionBasisDirtyBody: '检查只会在保存此草稿后执行。当前已保存版本：',
    executionBasisSavedTitle: '已保存插件版本',
    executionBasisSavedBody: '检查和升级将精确使用此已保存版本：',
    externalManagedTitle: '由外部路径管理',
    externalManagedBody: '文件来源可能在系统外变化，因此不提供无法保证原子性的检查与升级。',
    notCheckedTitle: '尚未检查更新',
    notCheckedBody: '检查当前精确保存的插件版本，以确认是否有更新的来源可用。',
    updateReadyTitle: '更新已就绪',
    updateReadyBody: '版本 {{version}} 可用于当前精确保存的插件。',
    noUpdateAvailable: '当前已保存插件已是最新。',
    identityUnknownTitle: '更新基线未知',
    identityUnknownBody: '此旧安装没有不可变来源标识。请重新安装一次以建立安全基线。',
    draftChangedDuringSave: '保存期间草稿又有修改。请检查新改动，然后再次执行“保存并检查”。',
    staleOperationResult: '此结果属于旧的已保存版本，未应用。页面将使用重新加载的数据。',
    upgradeSuccess: '升级已发布新的不可变插件代次。',
    errorOptionsJson: 'Options 必须是合法的 JSON 对象。',
    errors: {
      nameInvalid: 'name 必须匹配 [a-z0-9][a-z0-9_-]* 且长度 1–64',
      specRequired: 'spec 必填',
      specTooLong: 'spec 过长（最多 512 字符）',
    },
    sourceKind: {
      npm: 'npm',
      file: '文件',
      git: 'Git',
    },
  },
  workflows: {
    title: '工作流',
    cardKind: '工作流',
    newButton: '+ 新建工作流',
    createButton: '创建工作流',
    fieldNameHint: '小写字母 / 数字开头，只允许 [a-z0-9_-]，至多 128 字。',
    importButton: '导入 YAML',
    emptyList: '还没有工作流。',
    emptyDescription: '从一个清晰的自动化流程开始，之后可继续编辑节点与连接。',
    importedAsNew: '已作为新工作流导入。',
    workflowOverwritten: '工作流已覆盖。',
    importCanceled: '导入已取消。',
    conflictPrompt: 'Workflow id 冲突。输入 "overwrite" 覆盖，或 "new" 作为新工作流导入。',
    importDialog: {
      title: '导入工作流',
      dropTitle: '选择工作流 YAML 文件',
      dropDescription: '选择一个 .yaml 或 .yml 文件；系统会先检查内容，再处理可能的冲突。',
      chooseFile: '选择 YAML',
      replaceFile: '更换文件',
      removeFile: '移除',
      import: '导入',
      importing: '正在导入…',
      retry: '重试导入',
      refreshConflict: '刷新冲突信息',
      another: '继续导入',
      chooseAnother: '选择其他文件',
      conflictTitle: '已存在相同 id 的工作流',
      conflictDescription:
        '请选择如何导入 {{file}}。默认“作为新工作流导入”更安全；覆盖会替换现有工作流。',
      conflictChoiceLabel: '冲突处理方式',
      choiceNew: '作为新工作流导入',
      choiceOverwrite: '覆盖现有工作流',
      resolveReferences: '选择重名引用的目标所有者',
      resolveReferencesHint: '导入只会保存所选资源的稳定 id；候选会在提交时重新校验权限。',
      resultTitle: '导入完成',
    },
    cardNodes_one: '{{count}} 节点',
    cardNodes_other: '{{count}} 节点',
    noDescription: '（未填写描述）',
    errors: {
      nameRequired: '名称必填。',
      nameInvalid: '名称须以小写字母 / 数字开头，只允许 [a-z0-9_-]，长度 ≤ 128。',
    },
  },
  // RFC-164 — 工作组资源页（列表 + 快速新建弹窗 / 详情管理页）。
  workgroups: {
    title: '工作组',
    cardKind: '工作组',
    newButton: '+ 新建工作组',
    emptyList: '还没有工作组。',
    emptyDescription: '创建一个协作团队，配置成员、负责人和运行方式。',
    modeLeaderWorker: 'Leader-Worker',
    modeFreeCollab: '自由协作',
    modeDynamicWorkflow: '动态工作流',
    cardMembers_one: '{{count}} 名成员',
    cardMembers_other: '{{count}} 名成员',
    cardLeader: 'Leader · {{name}}',
    humanMemberChip: '含人工',
    cardAddAgent: '添加 agent 后可启动',
    cardSelectLeader: '指定 Leader 后可启动',
    cardNoWorkers: 'Leader 暂无可派成员',
    noDescription: '（未填写描述）',
    newTitle: '新建工作组',
    createButton: '创建工作组',
    renameButton: '重命名',
    renameTitle: '重命名工作组',
    renameField: '新名称',
    sectionBasics: '基本信息',
    sectionMode: '协作模式',
    sectionMembers: '成员',
    sectionSwitches: '协作开关',
    fieldName: '名称',
    fieldNameHint: '小写字母 / 数字开头，只允许 [a-z0-9_-]，至多 128 字。',
    fieldDescription: '描述',
    fieldInstructions: '工作组章程',
    fieldInstructionsHint: '可选。每一轮都会注入给每个成员的公共指令。',
    fieldMode: '模式',
    modeHintLeaderWorker: 'Leader 逐轮派活给 worker，启动前需指定一名 agent 成员为 leader。',
    modeHintFreeCollab: '无 leader 的自由协作，三个协作开关强制全开。',
    modeHintDynamicWorkflow:
      '内置 agent 根据你的目标把成员编排成一条 workflow，你确认后顺序执行。无聊天室——成员即可编排的 agent 池。',
    readiness: {
      noAgentMember: '还没有 agent 成员，无法启动。',
      agentMissing: '花名册中的部分 agent 已被删除，请先编辑成员后再启动。',
      leaderMissing: 'Leader-Worker 模式需要指定一名 agent 成员为 leader。',
      noNonLeaderWorker:
        '花名册里只有 leader 自己——没有可派活的成员，启动后 leader 只能空转（仍可启动）。',
    },
    membersEmpty: '还没有成员。用下方按钮添加 agent 或人类成员。',
    memberTypeAgent: '代理',
    memberTypeHuman: '人类',
    memberRemove: '移除',
    setLeaderButton: '设为 leader',
    leaderBadge: 'Leader',
    addAgentMember: '+ 添加 agent 成员',
    addHumanMember: '+ 添加人类成员',
    addAgentTitle: '添加 agent 成员',
    addHumanTitle: '添加人类成员',
    addMemberConfirm: '添加',
    panelConfigTitle: '工作组配置',
    panelAria: '上下文面板',
    panelClose: '关闭',
    actionsTitle: '工作组操作',
    renameActionHint: '修改工作组名称与描述。',
    aclActionHint: '查看可见性、成员与所有者。',
    deleteActionHint: '永久删除这个工作组。',
    memberSave: '保存成员',
    saveAll: '保存全部更改',
    finishAddingBeforeSave: '请先完成或清空当前新增成员草稿。',
    editAgentDefinition: '编辑 agent 定义 →',
    agentMissing: 'agent 不存在',
    portsIn: '输入',
    portsOut: '输出',
    portsCountBadge_one: '{{count}} 端口',
    portsCountBadge_other: '{{count}} 端口',
    configSaved: '已保存',
    autosave: {
      groupLabel: '工作组草稿状态',
      phaseBlocked: '等待修正',
      invalidTitle: '修正后会自动保存',
      invalidBody: '当前草稿包含无效字段；修改会保留在本页，恢复合法后自动继续保存。',
      transientTitle: '完成新增成员后会自动保存',
      transientBody: '新增成员表单尚未完成。确认添加或清空表单后，工作组会继续自动保存。',
      errorTitle: '工作组保存失败',
      errorBody: '本地草稿仍然保留。请重试；保存成功前不会启动或删除工作组。',
      inaccessibleTitle: '无法继续访问此工作组',
      inaccessibleBody: '工作组可能已删除或权限已变化，本地草稿仍然保留。',
      deletedTitle: '工作组已删除',
      deletedBody: '服务端已明确删除此工作组；本地草稿仍可另存为副本。',
      returnToList: '返回工作组列表',
    },
    memberFieldAgent: '代理名',
    memberFieldUser: '平台用户',
    memberFieldDisplayName: '显示名',
    memberFieldRole: '职责',
    memberAgentPlaceholder: '选择代理…',
    memberUserPlaceholder: '搜索并选择平台用户',
    memberDisplayNamePlaceholder: '组内唯一，禁止 @、逗号、空白。',
    memberRolePlaceholder: '组内职责说明（选人依据），可选。',
    fieldShareOutputs: '成果共享',
    fieldShareOutputsHint: '把同伴已完成任务的成果摘要注入给每个成员。',
    fieldDirectMessages: '点对点消息',
    fieldDirectMessagesHint: '成员可以互相 @；@ 会注入给对方并可唤醒对方。',
    fieldBlackboard: '广播消息',
    fieldBlackboardHint: '把组内公共消息流（无 @ 的广播，按预算截尾）注入给每个成员。',
    fcSwitchesNotice: '自由协作模式下三个协作开关强制视为全开；切回 Leader-Worker 后恢复原设置。',
    fieldMaxRounds: '最大轮数',
    fieldMaxRoundsHint: '1–1000，默认 1000。',
    fieldCompletionGate: '完成门（人工确认）',
    fieldCompletionGateHint: 'Leader 宣布完成后任务停在待人工确认，而不是直接结束。',
    fieldCompletionGateNoHumanHint: '本组没有人工成员，没人可确认——leader 宣布完成即直接结束。',
    fieldClarifyBudget: '反问次数上限',
    fieldClarifyBudgetHint:
      '同一提问方（leader、每张派单、每个成员）最多向人反问几次；用满后它会被要求自行决断。0 表示完全不反问。',
    fieldClarifyBudgetNoHumanHint: '本组没有人工成员，没人可问——agent 一律自行决断。',
    fieldFanOut: '动态多实例派单（fan-out）',
    fieldFanOutHint:
      '允许 leader 对同一 agent 成员在一轮内并发派发多个任务实例（各自独立执行后统一验收）。关闭时保持「每个成员一次一单」的固定模式。',
    launchButton: '启动任务',
    launch: {
      title: '启动工作组任务：{{name}}',
      backToGroup: '← 返回工作组',
      missingGroup: '缺少工作组名称——请从工作组详情页进入启动页。',
      fieldGoal: '任务目标',
      fieldGoalHint:
        '工作组这次要完成的目标。作为开工指令下发给负责拆解它的成员——Leader-Worker 模式只给 leader，自由协作模式给全体成员。',
      advanced: '高级选项',
      maxDurationMin: '最长运行时长（分钟）',
      maxDurationMinHint: '可选。超时后任务被平台取消。',
      maxTotalTokens: 'Token 总量上限',
      maxTotalTokensHint: '可选。全任务累计 token 超限后被平台取消。',
      start: '启动',
      notReady: '工作组尚未就绪，无法启动：',
      humanMembersUnsupported: '当前版本暂不支持含人类成员的工作组启动任务，后续版本将开放。',
      invalidPayload: '启动参数无效，请检查表单后重试。',
    },
    dw: {
      title: '动态编排',
      generating: '编排 agent 正在生成 workflow…（第 {{n}} 次尝试）',
      rejectionFeedback: '上轮驳回意见（本轮生成将参照修正）：',
      awaiting: '生成完成，请审阅下方 workflow。确认后将按图执行；驳回可附意见重新生成。',
      attemptsUsed: '本轮经 {{n}} 次自动重试后通过校验。',
      gateTitle: '编排确认门',
      approve: '确认执行',
      reject: '驳回重生成',
      rejectTitle: '驳回并要求重新编排',
      rejectCommentLabel: '驳回意见',
      rejectCommentHint: '意见会注入下一轮生成提示，帮助编排 agent 修正方案。',
      rejectSubmit: '确认驳回',
      saveAs: '另存为 Workflow',
      saveAsTitle: '把生成的 workflow 另存为可复用定义',
      saveAsNameLabel: '名称',
      saveAsDescLabel: '描述（可选）',
      saveAsSubmit: '保存',
      saved: '已另存为 {{name}}。',
      executing: '已确认，DAG 正在执行——进度见「运行状态」页签。',
      executingDone: '执行完成——结果见「运行状态」画布与「工作树差异」页签。',
      executingFailed: '执行失败——失败节点见「运行状态」画布，可从任务头部重试。',
      canceledNotice: '任务已取消，编排流程终止。',
      exhausted: 'workflow 生成失败（重试已耗尽）。可在详情页查看错误后重试任务。',
      previewEmpty: '暂无可预览的生成结果。',
      canvasPending: '等待编排确认后展示真实 DAG。',
    },
    room: {
      empty: '还没有消息。发一条话启动讨论；@成员名 即直接派单。',
      roundDivider: '第 {{n}} 回合',
      authorSystem: '系统',
      assignedTo: '派给',
      resultSummary: '结果摘要',
      viewRun: '查看执行现场',
      cancelCard: '取消',
      composerPlaceholder: '向房间发言；@成员名 直接给该成员派单',
      send: '发送',
      sending: '发送中…',
      terminalNotice: '任务已结束，聊天室只读。',
      mentionsAria: '成员补全',
      composerShortcutHint: '{{mod}}+Enter 发送 · Enter 换行 · @ 提及成员',
      deliverShortcutHint: '{{mod}}+Enter 提交 · Enter 换行',
      membersTitle: '成员',
      working: '忙碌',
      idle: '空闲',
      openMemberSession: '查看 @{{name}} 的执行会话',
      executing: '执行中',
      memberExecuting: '@{{name}} 执行中…',
      presenceQueued: '排队中',
      presenceAwaiting: '等待回答',
      activeRunsBadge: '×{{count}} 在途',
      turnKindLeader: '领导轮',
      turnKindMessage: '被 @ 轮',
      turnKindAssignment: '派发轮',
      removedMember: '已移除成员',
      clarifySuppressedNote: '反问已压制',
      clarifyStopped: '已停止向你反问：{{asker}}',
      clarifyResume: '恢复反问',
      runLogTitle: '执行记录 · {{count}}',
      runLogEmpty: '还没有任何执行',
      backToLatest: '回到最新',
      pauseTitle: '为什么停下了',
      pause: {
        maxRoundsWrapup:
          '回合预算已触顶，但已有完成的产出。没有问题在等你回答——可在下方查看交付内容；如需继续，提高任务配置里的回合上限后在房间发一条消息即可续跑。',
        leaderIdle:
          'Leader 连续空转，已暂停等待人工推进。在房间发消息（可 @成员 直接派活）即可继续。',
        leaderClarify: 'Leader 提出了反问，正在等你回答（见上方消息流的提问卡片）。',
        clarifyOrDelivery: '有成员的反问或人工交付在等你处理（见任务卡与消息流）。',
        engineStall: '引擎无事可做但任务未收敛（异常兜底暂停）。在房间发一条消息可尝试续跑。',
      },
      gateTitle: '完成门',
      gateAwaiting: 'Leader 已宣布完成，等待人工确认。',
      gateConfirm: '确认完成',
      gateReject: '驳回',
      gateRejectTitle: '驳回完成申报',
      gateRejectCommentLabel: '驳回意见',
      gateRejectCommentHint: '必填。会作为高优先级内容注入给 leader 继续推进。',
      gateRejectSubmit: '确认驳回',
      deliverTodo: '待你交付',
      deliverQuick: '快速回复',
      deliverQuickPlaceholder: '直接输入交付内容…',
      deliverForm: '表单交付',
      deliverFormTitle: '结构化交付',
      deliverSummaryLabel: '结论摘要',
      deliverDetailLabel: '详细说明（可选）',
      deliverSubmit: '交付',
      configButton: '调整配置',
      configTitle: '调整任务配置',
      configSubmit: '保存调整',
      configEmptyHint: '尚无改动。',
      configMembersTitle: '成员',
      configWillRemove: '将移除',
      configUndoRemove: '撤销移除',
      configNewChip: '新增',
      fcListTitle: '任务清单',
      fcOpen: '待认领',
      fcActive: '进行中',
      fcDone: '已完成',
      fcEmpty: '清单还是空的。',
      fcBatch: '同批 ×{{count}}',
      infoTitle: '工作组信息',
      infoGoal: '目标',
      infoMode: '模式',
      infoMaxRounds: '最大轮数',
      infoMemberTurnBudget: '成员发言预算',
      memberTurnBudgetValue: '{{used}} / {{max}}',
      memberTurnBudgetHint: '一批唤醒要整批放得下才会启动，所以可能提前触顶。',
      infoSwitches: '协作开关',
      assignmentStatus: {
        open: '待认领',
        dispatched: '已派发',
        running: '执行中',
        awaiting_human: '等待人工',
        delivered: '已交付',
        done: '完成',
        failed: '失败',
        canceled: '已取消',
      },
      source: {
        leader: 'Leader 派单',
        human: '人工派单',
        self_claim: '自领',
        system: '系统',
      },
    },
    errors: {
      nameRequired: '名称必填。',
      nameInvalid: '名称须以小写字母 / 数字开头，只允许 [a-z0-9_-]，长度 ≤ 128。',
      agentNameRequired: 'agent 成员必须选择代理。',
      userRequired: '人类成员必须选择平台用户。',
      displayNameRequired: '显示名必填。',
      displayNameInvalid: '显示名不能包含 @、逗号或空白字符。',
      displayNameTooLong: '显示名最长 64 个字符。',
      displayNameDuplicate: '显示名在组内必须唯一。',
      leaderMustBeAgent: 'Leader 只能是 agent 成员。',
      maxRoundsInvalid: '最大轮数须为 1–1000 的整数。',
      dynamicNoHumanMembers: '动态工作流模式仅允许 agent 成员——请先移除人类成员再保存。',
    },
  },
  scheduled: {
    repairBadge: '需修复',
    title: '定时任务',
    empty: '还没有定时任务',
    emptyDescription: '配置一次工作流启动并保存周期，让重复执行按计划自动发生。',
    new: '新建',
    colName: '名称',
    colSchedule: '周期',
    colNext: '下次触发',
    colStatus: '最近触发',
    colEnabled: '启用',
    enabledYes: '开',
    enabledNo: '关',
    lastNever: '未触发',
    last_launched: '已启动',
    last_failed: '失败',
    lastTaskLink: '查看任务',
    consecutiveChip: '连挂 ×{{n}}',
    saveAsScheduled: '存为定时任务',
    dialogTitle: '存为定时任务',
    fieldName: '定时任务名称',
    fieldMode: '重复',
    fieldEvery: '每隔',
    fieldUnit: '单位',
    fieldAt: '时刻',
    fieldDays: '星期',
    fieldDayOfMonth: '每月几号',
    dayOfMonthHint: '没有该日期的月份将跳过。',
    tzNote: '按你的时区：{{tz}}',
    modeInterval: '间隔',
    modeDaily: '每天',
    modeWeekly: '每周',
    modeMonthly: '每月',
    unitMinutes: '分钟',
    unitHours: '小时',
    unitDays: '天',
    dow: { 0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六' },
    preview: '下次 3 次触发',
    save: '保存',
    saving: '保存中…',
    cancel: '取消',
    runHistory: '触发历史',
    noRuns: '还没有触发记录。',
    autoDisabled: '连续启动失败已自动停用。重新启用可恢复。',
    runNow: '立即运行一次',
    edit: '编辑名称与周期',
    editTitle: '编辑定时任务',
    enable: '启用',
    disable: '停用',
    delete: '删除',
    deleteConfirm: '确认删除？',
    uploadUnsupported: '需要文件上传的工作流不支持定时。',
    editConfig: '编辑任务配置',
    degradedBanner:
      '此定时任务的存储配置已不可读（旧版格式或数据损坏）——用「编辑任务配置」重新填写并保存整份配置即可修复；也可以禁用或删除该定时任务。',
    editConfigTitle: '编辑任务配置：{{name}}',
    saveConfig: '保存任务配置',
    backToSchedule: '← 返回定时任务',
    collabLoadError: '无法加载协作者，请重试后再保存（避免误删已有协作者）。',
  },
  tasks: {
    title: '任务',
    newButton: '新建任务',
    filterAll: '全部',
    emptyList: '还没有任务',
    emptyDescription: '启动工作流、工作组或单个代理，并在这里持续跟踪每次执行。',
    colId: 'ID',
    colName: '名称',
    colSubject: '主体',
    colStatus: '状态',
    colStarted: '开始',
    colRepo: '仓库',
    colError: '错误',
    durationRunning: '进行中 · {{dur}}',
    durationWaiting: '等待 {{dur}}',
    repoCountChip: '{{n}} 仓库',
    scheduledChip: '定时',
    subjectFilter: {
      all: '全部主体',
      workflow: '工作流',
      workgroup: '工作组',
      agent: '单代理',
    },
    detailTitleIdLabel: '任务 ID',
    loadingTask: '加载任务中…',
    metaWorkflow: '工作流',
    metaRepo: '仓库',
    metaRepoUrl: '源仓库（克隆自）',
    metaRepoCachePath: '本地缓存路径',
    metaWorktree: 'Worktree',
    metaBranch: '分支',
    metaBaseBranch: '基线分支',
    metaWorkingBranch: '工作分支',
    metaWorkingBranchNone: '—（隔离分支）',
    metaAutoCommitPushOn: '自动提交并推送：开',
    commitPushNode: '提交并推送',
    commitViewSession: '查看会话',
    commitSessionTitle: '提交并推送会话',
    commitOutcomePushed: '已推送',
    commitOutcomeLocalAuth: '仅本地提交（推送受限）',
    commitOutcomeLocalFailed: '仅本地提交（推送失败）',
    commitOutcomeSubrepoFailed: '子模块推送失败，父仓未推送',
    subrepoPushed: '已推送',
    subrepoNotPushed: '未推送',
    commitOutcomeSkippedEmpty: '无改动',
    commitFiles: '{{files}} 个文件，+{{ins}}/-{{del}}',
    metaStarted: '开始',
    metaFinished: '完成',
    metaError: '错误',
    // RFC-066: multi-repo summary on the task detail page.
    multiRepoSummary: '{{count}} 个仓库',
    cancelButton: '取消任务',
    relaunchButton: '再次启动',
    resumeButton: '继续任务',
    resuming: '继续中…',
    // RFC-109 — 同步最新工作流并继续
    syncWorkflow: {
      bannerTitle: '工作流有更新',
      bannerHint: '关联工作流有更新版本，可同步并按最新定义继续运行',
      button: '同步并继续',
      dialogTitle: '同步工作流并继续',
      versionLabel: '版本',
      unknownVersion: '未知',
      confirm: '同步并继续',
      cancel: '取消',
      syncing: '同步中…',
      invalidTitle: '最新工作流当前校验不通过——请先修复再同步。',
      blockerTitle: '无法同步',
      sectionAdded: '新增节点',
      sectionRemoved: '删除节点',
      sectionModified: '修改节点',
      sectionWarnings: '警告',
      warn: {
        'removed-node-feeds-downstream': '删除的节点曾向保留节点供数',
        'dangling-input-port': '保留产出里没有该输入端口',
        'new-upstream-into-completed-node': '新上游指向已完成节点（按原样保留）',
      },
      blocker: {
        'wrapper-structure-changed-with-live-state':
          '某包装节点在有进行中状态时改了结构，同步会破坏其续跑。请改用新任务。',
      },
    },
    resumeUnavailableNoWorktree:
      'worktree 创建阶段就失败了（根本没建出 worktree），resume 救不了。请新建一个任务。',
    resumeUnavailableWorkgroup:
      '组任务失败后不支持原地继续（组的编排由引擎驱动，恢复靠重启而非续跑）。请重新启动该工作组。',
    resumeLaunchLink: '启动新任务 →',
    failure: {
      generic: '任务执行失败。',
      'envelope-missing': '代理没有按约定格式输出结果（缺少输出信封）。',
      'envelope-missing__hint': '通常是模型没有遵循输出协议——可点「继续任务」重试该节点。',
      'clarify-and-output-both': '代理同时提交了反问与结果，格式冲突。',
      'clarify-questions-malformed': '代理提出的反问格式无法解析。',
      'clarify-required': '该节点要求先反问再输出，但代理直接给出了结果。',
      'clarify-forbidden': '已停止反问，但代理仍在提出反问。',
      'envelope-port-malformed': '代理输出的端口标签不完整（可能被截断）。',
      'port-validation-failed': '代理输出的端口内容未通过校验。',
      'port-validation-failed__hint': '查看节点详情里的端口校验信息，点「继续任务」重试。',
      'execution-identity-untrusted-binary': '所选 OpenCode 可执行文件不是受信任的官方构建。',
      'execution-identity-untrusted-binary__hint':
        '请安装受支持的 OpenCode 官方构建，或选择其已验证的可执行文件。',
      'execution-identity-sandbox-required':
        '本次 OpenCode 运行要求安全 Linux 沙箱，但当前不可用。',
      'execution-identity-sandbox-required__hint':
        '请在支持的 Linux 主机上运行 daemon，并启用所需沙箱。',
      'execution-identity-project-config-unsupported':
        '工作区含有无法安全隔离的 OpenCode 项目配置。',
      'execution-identity-project-config-unsupported__hint':
        '请移除错误详情指出的项目配置或符号链接，再发起新运行。',
      'execution-identity-plugin-unsupported': '已验证的 OpenCode 执行路径不支持插件。',
      'execution-identity-plugin-unsupported__hint': '请先从代理配置中移除插件，再保存或运行。',
      'execution-identity-dependent-unsupported': '已验证的 OpenCode 执行路径不支持依赖代理。',
      'execution-identity-dependent-unsupported__hint': '请先移除依赖代理，再保存或运行。',
      'execution-identity-model-unresolved': '本次运行没有显式选择 OpenCode 模型。',
      'execution-identity-model-unresolved__hint':
        '请为生效运行时选择 provider/model，再重新发起。',
      'execution-identity-auth-invalid': '所选 provider 凭据不符合已验证的认证契约。',
      'execution-identity-auth-invalid__hint': '请更新 provider API 凭据后重新发起新运行。',
      'execution-identity-provider-untrusted': '所选模型 provider 不属于受信任的 OpenCode 构建。',
      'execution-identity-provider-untrusted__hint':
        '请选择受支持的 OpenCode 官方构建内置的 provider/model。',
      'execution-identity-bootstrap-failed': 'OpenCode 在模型执行前未通过启动完整性检查。',
      'execution-identity-bootstrap-failed__hint': '请查看运行时诊断，修复主机环境后重新发起。',
      'execution-identity-mismatch': 'OpenCode 最终解析的执行配置与密封配置不一致。',
      'execution-identity-mismatch__hint': '请移除外部覆盖、修正运行时配置后重新发起新运行。',
      'execution-identity-instance-changed': '身份校验期间 OpenCode server 实例发生了变化。',
      'execution-identity-instance-changed__hint': '请检查运行时是否被替换或干扰，再重新发起。',
      'execution-identity-source-changed': '启动期间工作区的执行身份来源发生了变化。',
      'execution-identity-source-changed__hint': '请停止并发配置修改，再重新发起新运行。',
      'execution-identity-skill-mismatch': '生成不可变快照期间，所选托管技能发生了变化。',
      'execution-identity-skill-mismatch__hint': '请完成技能更新、重新加载代理配置后再发起。',
      'execution-identity-session-mismatch': 'OpenCode 会话与本任务运行的密封身份不一致。',
      'execution-identity-session-mismatch__hint': '请创建新会话，不要复用本任务链之外创建的会话。',
      'execution-identity-session-owned': 'OpenCode 会话已被另一个活动运行租用。',
      'execution-identity-session-owned__hint': '请等待活动运行结束，或先修复其生命周期再继续。',
      'execution-identity-control-failed': '已验证 launcher 与调度器未能完成控制握手。',
      'execution-identity-control-failed__hint': '请查看 daemon 诊断，解决控制故障后重新发起。',
      'execution-identity-stream-failed': '已验证 OpenCode 事件流不符合预期协议。',
      'execution-identity-stream-failed__hint':
        '请查看运行时诊断后重新发起；系统不会自动重试此故障。',
      'execution-identity-timeout': 'OpenCode 身份校验或直接执行超时。',
      'execution-identity-timeout__hint': '请检查 provider 与主机健康状态后重新发起。',
      'execution-identity-store-unsafe': 'OpenCode 私有会话存储未通过安全检查。',
      'execution-identity-store-unsafe__hint':
        '确认没有活动运行后，修复或移除错误详情指出的私有存储。',
      summary: {
        snapshotLost: '任务的工作区快照丢失，无法从原位置继续。',
        snapshotInvalid: '任务的工作区快照已失效。',
        snapshotMissing: '找不到任务的工作区快照。',
        liveChildSurvived: '上一次运行的代理进程仍未退出，无法安全重跑。',
        liveChildSurvived__hint: '稍候片刻再试；若持续出现，用「诊断」检查并清理残留进程。',
        daemonRestart: '服务重启中断了任务。',
        daemonRestart__hint: '点「继续执行」从中断处恢复（开启自动恢复后会自动续跑）。',
        orphanReconcile: '服务运行期间检测到任务失联，已标记为中断。',
        canceledByUser: '任务已被手动取消。',
        schedulerError: '调度器内部错误导致任务失败。',
        schedulerStalled: '调度停滞：有节点长时间无法推进。',
        schedulerStalled__hint: '用「诊断」查看阻塞原因，或重启 daemon 后恢复任务。',
        dwGenerateExhausted: '动态工作流多次生成仍不可用，已停止重试。',
        dwGenerateExhausted__hint: '调整需求描述或工作组配置后重新发起。',
        dwRejectExhausted: '动态工作流多次被驳回仍未达标，已停止重试。',
        dwRejectExhausted__hint: '放宽验收标准或调整工作组目标后重新发起。',
        nodeTimeout: '节点执行超时。',
        nodeTimeout__hint: '可在节点配置中调大超时时间后点「继续任务」重试。',
        childUnkillable: '代理进程无法终止，已放弃该次运行。',
        worktreeCreationFailed: '创建任务工作区失败。',
        workgroupMaxRounds: '工作组达到轮次上限仍未完成目标。',
        workgroupMaxRounds__hint: '可提高轮次上限或拆小目标后重新启动工作组任务。',
        exitedWithCode: '代理进程异常退出。',
        exitedWithCode__hint: '查看节点会话日志定位原因，点「继续任务」重试。',
      },
    },
    failedBanner: '任务失败。',
    jumpToFailed: '跳到失败节点 ({{nodeId}})',
    diagnose: {
      bannerErrorTitle: '检测到任务生命周期问题。',
      bannerWarningTitle: '检测到任务生命周期警告。',
      bannerCount_one: '{{count}} 条未解决告警。',
      bannerCount_other: '{{count}} 条未解决告警。',
      bannerRulesSummary: '触发的规则',
      bannerButton: '诊断',
      panelTitle: '任务生命周期诊断',
      rescan: '重新扫描',
      rescanning: '扫描中…',
      close: '关闭',
      loading: '正在运行不变量扫描…',
      empty: '该任务当前没有未解决的生命周期告警。',
      detailDisclosureLabel: '查看详情',
      col: {
        rule: '规则',
        severity: '严重级别',
        detectedAt: '首次发现',
        detail: '详情',
        actions: '操作',
      },
      severity: {
        warning: '警告',
        error: '错误',
      },
      rule: {
        R1: '文档已审核通过，但 review node_run 未落 done',
        R2: 'review node_run 已完成，但找不到 approved 的 doc_version',
        C1: 'clarify_session 已关闭，但对应 clarify node_run 仍在 awaiting_human',
        T1: 'task 处于 awaiting_review，但没有任何 node_run 处于 awaiting_review',
        T2: 'task 处于 awaiting_human，但没有任何 node_run 处于 awaiting_human',
        T3: 'task 已 done，但仍有 output 节点没有 done 的 node_run',
        U1: '同一 (nodeId, iteration, shard) 上存在多个活跃 node_run',
        'CR-1': 'cross-clarify 已回答 continue 指令，但失败任务上无 designer 消费',
        S1: 'task 在 awaiting_review 长时间无 pending doc_version',
        S2: 'task 在 awaiting_human 长时间无开放 clarify_session',
        S3: 'task 状态 running，但所有 node_run 都已落终态',
        S4: 'task 长时间处于 pending，调度器未拣选',
        S5: 'task 在 running 且存在活跃 node_run，但事件流长时间停滞',
        S6: 'task 在 awaiting_review/awaiting_human，但所有成员（属主+协作者）均非活跃，无人可应答',
      },
      repair: {
        openButton: '修复…',
        dialogTitle: '修复生命周期告警 ({{rule}})',
        confirmTitle: '确认修复操作',
        confirmLead: '即将执行：{{option}}。',
        confirmApply: '确认应用',
        closeAfterFailure: '关闭',
        applyFailedBanner:
          '状态修复已生效，但任务续跑失败。可关闭本窗后重新诊断，或到任务详情页点「继续执行」。',
        applyFailedDetail: '失败详情',
        applying: '应用中…',
        cancel: '取消',
        next: '下一步',
        loading: '加载修复选项中…',
        empty: '当前告警没有可用的修复选项。',
        optionPickerLabel: '选择修复方案',
        destructive: '破坏性',
        risk: {
          low: '低风险',
          medium: '中等风险',
          high: '高风险',
        },
        unavailable: {
          generic: '该选项当前不可用。',
        },
      },
    },
    reviewButton: '去审核',
    clarifyButton: '去回答',
    worktreePreserved:
      'Worktree 仍保留在 {{path}}。可手动检查；结束后执行 git worktree remove 清理。',
    recovery: {
      title: '恢复',
      quarantineTitle: '自动恢复已暂停',
      quarantined: '该任务因反复自动恢复失败被熔断隔离，已暂停自动恢复。',
      clearQuarantine: '解除隔离',
      summary: '系统已自动恢复此任务 {{count}} 次',
      expand: '展开恢复记录',
      collapse: '收起',
      kind: {
        'boot-reap': '启动时回收了中断的运行',
        'periodic-reap': '巡检时回收了中断的运行',
        'shutdown-flip': '守护进程关停时将运行标记为中断',
        'limit-cancel': '因触及资源上限被取消',
        'snapshot-lost': '快照已丢失，无法自动恢复',
        'live-child-survived': '回滚后仍有未结束的子进程',
        'auto-resume': '自动从断点继续运行',
        'auto-repair': '自动修复了一处异常状态',
        'heartbeat-kill': '终止了无响应的子进程',
        quarantine: '多次自动恢复失败，已暂停自动恢复',
      },
    },
    stuckBadge: '{{count}} 告警',
    sectionWorkflowStatus: '工作流状态',
    sectionNodeRuns: '节点运行',
    sectionWorktreeDiff: 'Worktree diff',
    tabWorkflowStatus: '工作流状态',
    tabNodeRuns: '节点运行',
    tabDetails: '详细信息',
    tabOutputs: '输出',
    tabWorktreeFiles: '工作目录',
    tabWorktreeDiff: '工作目录 diff',
    tabWorktreeStructure: '结构',
    sectionNavLabel: '任务分区',
    sectionGroupOverview: '概览',
    sectionGroupExecution: '执行',
    sectionGroupArtifacts: '产物',
    sectionGroupCollaboration: '协作',
    structScopeLabel: '范围',
    structScopeTask: '整任务',
    structPruned: '该节点的快照已被回收（worktree GC 后），结构 diff 不可用。',
    structReadonlyNode: '该节点为只读 / 无写入，无结构变化。',
    structEmpty: '本次改动无可识别的结构变化。',
    structDegradedBanner: '部分文件为 best-effort 分析（C++/Scala），结构可能不完整。',
    structDegradedChip: '不完整',
    structParseError: '该文件解析失败，已跳过结构分析。',
    structFileNoSymbolChanges: '该文件无符号级变化。',
    structCardFiles: '文件',
    structCardClasses: '类',
    structCardMethods: '方法',
    structCardFields: '成员',
    structCardImports: '导入',
    structCardDependencies: '依赖',
    structDepsHeader: '依赖变更',
    structImpactHeader: '影响面（谁调用了被改方法）',
    structImpactInferred: '启发式（跨文件，名称匹配）',
    structImpactExtracted: '精确（SCIP 类型解析）',
    structEngineLabel: '引擎',
    structEngineBaseline: '基线',
    structEngineDeep: '深度',
    structDegradedDeepFallback:
      '深度分析不可用（未装索引器 / 项目编译不过 / 超时），已回退基线启发式。',
    structViewLabel: '视图',
    structViewTree: '树',
    structViewGraph: '关系图',
    structViewImpact: '影响面',
    structViewDeps: '依赖',
    structViewCallChain: '调用链',
    structCallChainEntry: '看调用链',
    structCallPick: '点某个方法行的「⎇ 看调用链」查看它的后续调用链',
    structCallNoCalls: '未发现调用',
    structCallExternal: '外部',
    structCallUnresolved: '未解析',
    structCallCycle: '环',
    structCallTruncated: '已截断',
    structCallExpand: '展开',
    structCallCollapse: '收起',
    structCallMode: '视图',
    structCallModeTree: '调用树',
    structCallModeSequence: '时序图',
    structSeqTitle: '调用链时序图',
    structCallSeqTruncated: '调用链较深,已按上限截断——部分分支未在时序图展开',
    structBodyDeltaTitle: '方法体行变更（+新增 / −删除）',
    structGraphEmpty: '无可视化的结构改动（仅依赖/字段等变更）—— 见上方摘要卡片与"树"视图。',
    structGraphLegendAdded: '+ 新增',
    structGraphLegendModified: '~ 改动',
    structGraphLegendRemoved: '− 删除',
    structGraphLegendCaller: '调用方（受影响）',
    structGraphLegendHint: '箭头：A → A 依赖/使用的类',
    structGraphEdgeInherits: '继承/实现',
    structGraphEdgeReferences: '构造/引用',
    structGraphEdgeCalls: '调用',
    structGraphLevelLabel: '视图层级',
    structGraphLevelPackage: '包级',
    structGraphLevelClass: '类级',
    structGraphPkgClasses: '{{n}} 个类',
    structGraphCallers: '调用方',
    structViaImportManifest: '源码已引用',
    structRenamedFrom: '原 {{from}}',
    structSigChanged: '签名变化',
    structJumpToDiff: '跳转到文本 diff',
    structExplainAdded: '新增 {{kind}} {{name}}',
    structExplainRemovedPublic: '删除了对外可见的 {{kind}} {{name}} —— 可能破坏调用方',
    structExplainRemovedPrivate: '删除了私有 {{kind}} {{name}}',
    structExplainRenamed: '{{kind}} {{name}} 由 {{from}} 重命名 —— 旧名调用会失效',
    structExplainMoved: '{{kind}} {{name}} 被移动',
    structExplainSig: '{{name}} 的签名变了 —— 请检查所有调用点',
    structExplainBody: '{{name}} 仅函数体改动',
    structSevBreaking: '破坏性',
    structSevRisky: '需留意',
    structSevSafe: '安全',
    structSevUnknownVis: '可见性未知 —— 已按保守口径分级',
    structSortLabel: '排序',
    structSortName: '名称',
    structSortSeverity: '风险',
    structFilterLabel: '显示',
    structCardBreaking: '破坏性',
    structWalkthroughTitle: '重点改动(按风险)',
    structWalkthroughMore: '还有 {{n}} 处',
    tabFeedback: '留言',
    tabQuestions: '问题',
    tabChatroom: '聊天室',
    tabDwOrchestration: '动态编排',
    workgroupBadge: '工作组',
    agentBadge: '代理',
    workflowBadge: '工作流',
    worktreeFilesEmpty: '从左侧选择一个文件以预览。',
    worktreeFilesNoWorktree: '该任务没有可用的工作目录。',
    worktreeFilesOversized: '文件过大（{{size}}），超过 {{limit}} 阈值，未预览。',
    worktreeFilesTruncated: '该目录条目过多，仅展示前 {{limit}} 项。',
    worktreeFilesLoadError: '目录加载失败。',
    worktreeFilesFileError: '文件加载失败。',
    worktreeFilesSizeHeader: '大小：{{size}}',
    worktreeFilesRefresh: '刷新',
    worktreeFilesDownload: '下载',
    worktreeFilesDownloading: '下载中…',
    worktreeFilesDownloadError: '下载失败。',
    worktreeFilesTreeAria: 'worktree 文件',
    noWorkflowSnapshot: '没有工作流快照。',
    noBaseCommit: '未记录 base commit；diff 不可用。',
    loadingDiff: '加载 diff 中…',
    diffNoChanges: '自任务启动以来没有改动。',
    diffTruncatedBanner: '⚠ Diff 已截断至 1 MiB。请直接查看 worktree 获取完整输出。',
    diffViewedProgress: '已看 {{n}}/{{total}}',
    diffFileSelectorLabel: '已变更文件',
    structFileSelectorLabel: '存在结构变更的文件',
    diffMarkViewed: '标记 {{file}} 为已看',
    noNodeRuns: '还没有节点运行；调度器还未触达任何节点。',
    colNode: '节点',
    colIteration: '轮次',
    colRetry: '重试',
    colDuration: '耗时',
    status: {
      pending: '待运行',
      running: '运行中',
      done: '已完成',
      failed: '失败',
      canceled: '已取消',
      interrupted: '已中断',
      awaiting_review: '等待审核',
      // 2026-07-21 —— 中性化：awaiting_human 有两类成因（clarify 反问 = 真有
      // 问题要答；max-rounds wrap-up = 预算触顶待处置）。「等待回答」对后者
      // 是误导（用户实报困惑）；精确成因由房间的 pauseReason 说明卡展示。
      // 措辞注意：node-run-duration-no-manual-marker 守卫禁止 tasks 域出现
      // 「等待人工」子串（防已删的时长人工标记复活）——故用「待人工处理」。
      awaiting_human: '待人工处理',
    },
  },
  editor: {
    newTitle: '新建工作流',
    fieldName: '名称',
    fieldDescription: '描述',
    renameButton: '重命名',
    renameTitle: '重命名工作流',
    loadingWorkflow: '加载工作流中…',
    statusSaving: '保存中…',
    statusUnsaved: '未保存',
    statusSaved: '已保存',
    launch: '启动任务',
    preparingLaunch: '正在保存并校验…',
    validate: '校验',
    validating: '校验中…',
    exportYaml: '导出 YAML',
    exporting: '导出中…',
    exportTitle: '下载为 YAML',
    actionsTitle: '工作流操作',
    renameActionHint: '修改工作流名称与描述。',
    aclActionHint: '查看可见性、成员与所有者。',
    deleteActionHint: '永久删除这个工作流。',
    deleteTitle: '删除工作流',
    deleteDescription: '删除版本 {{version}} 的 {{name}}？此操作无法撤销。',
    actionDraftChanged: '操作期间草稿发生了变化。请确认当前保存状态后重试。',
    actionRevisionMismatch: '服务端回执与已保存的工作流版本不一致，未继续执行后续操作。',
    remoteUpdated: '该工作流在其它端被更新（v{{version}}）；当前视图即将刷新。',
    remoteDeleted: '该工作流在其它端被删除。',
    remoteDismiss: '关闭',
    validationOk: '✓ 校验通过',
    validationIssues: '{{n}} 个问题',
    validationWarnings: '{{n}} 个警告（不阻塞启动）',
    validationStaleDraft: '上次校验（草稿已变化）',
    validationStaleInventory: '上次校验（校验所依赖的资源可能已变化）',
    validationAutoFitWrapper: '自适应',
    validationSummaryOk: '校验通过',
    validationBadgeErrors: '{{n}} 个校验错误',
    validationBadgeWarnings: '{{n}} 个校验警告',
    validationSummaryErrors: '{{n}} 个校验问题',
    validationSummaryWarnings: '{{n}} 个校验警告',
    validationSummaryStale: '需要重新校验',
    validationDetailsTitle: '工作流校验',
    validationRevalidate: '重新校验',
    validationTargetChanged: '校验后对象已发生变化，请重新校验当前草稿。',
    validationTargetUnavailable: '对象已变化',
    validationGoToIssue: '前往修复',
    paletteFilter: '过滤面板…',
    paletteNoMatches: '没有匹配项。',
    emptyCanvas: {
      title: '搭建你的工作流',
      description: '选择一个执行角色开始，之后可继续添加和连接步骤。',
      addFirst: '添加第一步',
      startTemplate: '从模板开始',
    },
    nodePicker: {
      title: '添加工作流步骤',
      addButton: '添加步骤',
      searchLabel: '搜索工作流步骤',
      searchPlaceholder: '按名称、类型或能力搜索…',
      recommended: '推荐',
      recent: '最近使用',
      all: '全部步骤',
      categoriesLabel: '按节点类型筛选',
      categoryAll: '全部',
      categoryAgent: 'Agent',
      categoryWrapper: '包装器',
      categoryIo: '输入输出',
      categoryHuman: '人工节点',
      noMatches: '没有匹配的步骤。',
      resultsCount: '有 {{n}} 个工作流步骤可用。',
      resultsCountInCategory: '{{category}}分类有 {{n}} 个步骤可用。',
      dragHint: '拖到画布上',
    },
    starter: {
      title: '选择工作流起点',
      standardTitle: '标准开发闭环',
      standardDescription: '实现代码 → 按变更文件并行审计 → 汇总问题 → 修复。',
      auditTitle: '只做审计',
      auditDescription: '输入待审对象，由一个审计代理产出结构化报告。',
      blankTitle: '空白工作流',
      blankDescription: '回到步骤选择器，从第一个节点开始搭建。',
      apply: '应用 Starter',
      applying: '重新校验并应用…',
      confirmReplace: '替换当前工作流',
      replaceWarning: '当前画布已有内容。再次点击将用这个 Starter 整体替换，并可通过一次撤销恢复。',
      chooseAgent: '选择代理',
      preview: '将创建 {{nodes}} 个节点和 {{edges}} 条连接。',
      validating: '正在用服务端真实资源校验草稿…',
      valid: 'Starter 已通过当前资源校验。应用时还会重新校验一次。',
      invalid: '这个映射暂时无法应用：',
      role: {
        coder: '实现代理',
        auditor: '审计代理',
        aggregator: '汇总代理',
        fixer: '修复代理',
      },
      issue: {
        'role-unmapped': '请选择一个代理。',
        'agent-missing': '所选代理已不在当前资源列表中。',
        'aggregator-role-required': '该角色需要配置为 aggregator 的代理。',
        'data-output-required': '该角色需要至少一个承载数据的输出端口。',
      },
      copy: {
        requestLabel: '任务需求',
        artifactLabel: '待审对象',
        inputTitle: '输入',
        coderTitle: '实现',
        gitTitle: '代码变更',
        fanoutTitle: '逐文件审计',
        auditorTitle: '审计文件',
        aggregatorTitle: '汇总问题',
        fixerTitle: '修复问题',
        outputTitle: '结果',
      },
    },
    nodeActions: {
      addNext: '在此步骤后添加',
      connectNext: '连接下一步',
      copy: '复制',
      more: '更多操作',
      addInside: '添加内部步骤',
      insertOnEdge: '在这条连线上插入步骤',
    },
    connectionDialog: {
      title: '连接工作流步骤',
      sourcePort: '来源输出',
      targetNode: '目标步骤',
      inputMode: '目标输入',
      newInput: '新增输入',
      reuseInput: '复用输入',
      targetPort: '输入名称',
      domainChannel: '受管反问通道',
      fanoutInput: '创建 Fan-out 输入边界',
      fanoutOutput: '创建 Fan-out 输出边界',
      fanoutEndpoint: '外侧：{{outer}} · wrapper：{{wrapper}} · 内侧：{{inner}}',
      fanoutKind: '边界值类型',
      fanoutRole: 'Fan-out 输入角色',
      fanoutShard: '分片来源',
      fanoutBroadcast: '广播',
      fanoutDemotes: '原分片来源将改为广播：{{ports}}',
      preview: '连线预览',
      apply: '应用连线',
      applied: '已连接 {{source}} 与 {{target}}。',
      inserted: '已在连线 {{edge}} 上插入 {{node}}。',
      replaces: '将替换边：{{edges}}',
      incomplete: '选择两端后即可预览兼容性。',
      compatibility: {
        compatible: '兼容',
        incompatible: '不兼容',
        unknown: '兼容性未知',
      },
    },
    paletteAgents: '代理',
    paletteFanOut: 'Fan-out',
    paletteFanOutDesc: '多进程（按 sourcePort 分片）',
    paletteAgentFallbackDesc: '代理节点',
    paletteWrappers: '包装器',
    paletteWrapperGitLabel: 'Git 包装器',
    paletteWrapperGitDesc: '在子节点前后快照 diff',
    paletteWrapperLoopLabel: '循环包装器',
    paletteWrapperLoopDesc: '重复执行子节点直到退出条件满足',
    paletteWrapperFanoutLabel: '分片包装器',
    paletteWrapperFanoutDesc: '把 list<T> 端口的每个元素分配给内部子图独立执行；用聚合 agent 收口',
    paletteIo: 'IO',
    paletteInputLabel: '输入',
    paletteInputDesc: 'launcher 表单值',
    paletteOutputLabel: '输出',
    paletteOutputDesc: '任务详情页输出面板',
    paletteHuman: '人工',
    paletteReviewLabel: '评审',
    paletteReviewDesc: '挂在 markdown port 下游，让人评审后再继续。',
    paletteClarifyLabel: '反问',
    paletteClarifyDesc: '让 agent 在无法决断时主动反问；从节点左侧 input 端往 agent 上拖即可挂接。',
    menuPaste: '粘贴',
    menuSelectAll: '全选',
    menuDuplicate: '复制为新节点',
    menuCopy: '复制',
    menuWrapGit: '用 git wrapper 包装',
    menuWrapLoop: '用 loop wrapper 包装',
    menuDecompose: '解组 wrapper',
    boxSelectHint: '按住 Shift 框选',
    layoutToolbar: '画布布局',
    layoutAll: '整理全图',
    layoutSelection: '整理所选',
    menuSelectedCount: '已选 {{n}} 个',
    nodeTitleUnsetAgent: '(未设置代理)',
    nodeTitleUnsetKey: '(未设置 key)',
    history: {
      undo: '撤销',
      redo: '重做',
      undoIntent: '撤销：{{label}}',
      redoIntent: '重做：{{label}}',
      canvasEdit: '编辑画布',
      delete: '删除所选内容',
      connect: '连接步骤',
      paste: '粘贴步骤',
      duplicate: '复制步骤',
      wrap: '包装步骤',
      unwrap: '解散包装器',
      fitWrapper: '自适应包装器',
      insert: '添加步骤',
      applyStarter: '应用工作流 Starter',
      autoLayout: '自动整理工作流',
      move: '移动步骤',
      rename: '重命名工作流',
      editInspector: '编辑配置',
    },
    draftStatus: {
      groupLabel: '工作流草稿状态',
      phaseAria: '保存状态：{{status}}',
      transportAria: '连接状态：{{status}}',
      phase: {
        clean: '已保存',
        dirty: '有未保存修改',
        saving: '保存中',
        reconciling: '正在核对保存结果',
        error: '保存失败',
        conflict: '版本冲突',
        inaccessible: '无法访问',
        deleted: '已删除',
      },
      transport: {
        online: '在线',
        degraded: '实时同步降级',
        offline: '离线',
      },
      retryNow: '立即重试',
      offlineTitle: '当前离线',
      offlineBody: '本地草稿已保留；恢复连接后会先核对服务端版本。',
      reconcilingTitle: '正在核对保存结果',
      reconcilingBody: '上次请求的结果不确定；在核对完成前不会发送后续修改。',
      errorTitle: '工作流保存失败',
      errorBody: '本地草稿仍然保留。请重试保存，或先导出本地内容。',
      conflictTitle: '检测到版本冲突',
      conflictBody:
        '本地草稿 r{{localRevision}} 与远端 v{{remoteVersion}} 不一致。请选择如何继续。',
      saveCopyRecommended: '另存为副本（推荐）',
      saveCopy: '另存为副本',
      loadRemote: '加载远端',
      overwriteRemote: '覆盖远端',
      loadDialogTitle: '加载远端版本？',
      loadDialogBody: '加载远端 v{{remoteVersion}} 将丢弃本地草稿 r{{localRevision}} 的修改。',
      loadDialogConfirm: '加载远端并丢弃本地修改',
      overwriteDialogTitle: '覆盖远端版本？',
      overwriteDialogBody:
        '本地草稿 r{{localRevision}} 基于 v{{baseVersion}}；确认后将尝试覆盖远端 v{{remoteVersion}}。如果远端再次变化，仍会停在冲突状态。',
      overwriteDialogConfirm: '确认覆盖远端',
      inaccessibleTitle: '无法继续访问此工作流',
      inaccessibleBody: '此工作流可能已删除或权限已变化。本地草稿仍然保留。',
      deletedTitle: '工作流已删除',
      deletedBody: '服务端已明确删除此工作流；本地草稿仍可导出或另存为副本。',
      exportLocal: '导出本地 YAML',
      retryAccess: '重试访问',
      returnToList: '返回工作流列表',
    },
  },
  taskWizard: {
    launchEntry: '启动任务',
    title: '新建任务',
    titleScheduled: '新建定时任务',
    titleEdit: '编辑定时任务配置',
    stepMode: '执行方式',
    stepSpace: '执行空间',
    stepContent: '任务内容',
    stepConfirm: '确认',
    kindLabel: '执行方式',
    kindWorkflow: '工作流',
    kindAgent: 'Agent',
    kindWorkgroup: '工作组',
    kindHintWorkflow: '按工作流定义的输入启动一次编排任务。',
    kindHintAgent: '把任务描述直接交给一个 Agent 执行，支持反问。',
    kindHintWorkgroup: '把使命交给一个工作组协同完成。',
    objectWorkflow: '选择工作流',
    objectAgent: '选择 Agent',
    objectWorkgroup: '选择工作组',
    objectPlaceholder: '请选择…',
    objectEmpty: '暂无可选对象',
    workgroupNotReady: '未就绪（缺可用 Agent 成员或负责人）',
    workgroupLeaderOnlyWarning: '花名册仅 leader 一人——可启动，但 leader 无人可派、只能空转',
    spaceLabel: '执行空间',
    spaceRemote: '远端仓库',
    spaceScratch: '临时空间',
    spaceScratchDesc: '平台建一个空 Git 仓库，产出以 diff 交付',
    spaceRemoteDesc: '克隆远端仓库（URL），在其工作树上执行',
    spaceScratchHint:
      '平台会创建一个空 Git 仓库作为工作目录；产出以对空仓的 diff 形式交付，目录保留可手动取用。',
    contentDescription: '任务描述',
    contentDescriptionHint: '将作为提示词直接交给 Agent。',
    agentPortsBlocked: '该 Agent 的输入端口声明阻止手动启动：',
    agentNotFound: '找不到 Agent「{{name}}」——它可能已被删除或不可见，请回到第一步重新选择。',
    portKindHint: '期望格式：{{kind}}',
    agentPortBlockedSignal: '端口 {{port}} 是 signal 类型，不能手动填写',
    agentPortBlockedName: '端口名 {{port}} 不能用作模板变量（非法字符或保留名）',
    advanced: '高级设置',
    allowClarify: '允许反问',
    allowClarifyHint: 'Agent 可在需要时向你提问（也可以不问直接产出）。',
    maxDurationMin: '时长上限（分钟）',
    maxDurationMinHint: '超时后任务自动取消；留空不限制。',
    maxTotalTokens: 'Token 上限',
    maxTotalTokensHint: '超出后任务自动取消；留空不限制。',
    edit: '修改',
    launch: '启动任务',
    saveScheduled: '存为定时任务',
    saveConfig: '保存配置',
    limitInvalid: '上限必须为正数（Token 上限须为整数）。',
    summaryCollaborators: '{{count}} 位协作者',
    clarifyOn: '反问已开启',
    kindLocked: '编辑定时任务时执行方式不可更改（对象可在同类型内更换）。',
    degradedBanner: '该定时任务存储的配置无法解析（旧格式或已损坏）；请重新填写并保存以修复。',
    spaceUnresolvedNotice:
      '无法完整重建源任务的执行空间（内部空间、旧版本地路径，或在准备阶段就失败、仓库列表可能不完整）——已清空，请重新确认并填写完整的仓库列表后再启动。',
    workflowVersionMismatchTitle: '工作流在启动前已变化',
    workflowVersionMismatchBody:
      '本次启动基于 v{{expected}}，但工作流当前已是 v{{current}}。请返回编辑器，对最新版本重新校验后再启动。',
    workflowVersionReturnToEditor: '返回编辑器重新校验',
    workflowVersionUseLatest: '加载并检查最新版本',
    workflowLaunchVersionMismatchBody:
      '启动期间工作流已更新，本次没有创建任务。请加载并检查最新字段后再试。',
    scheduledWorkflowLatestTitle: '计划执行时使用最新工作流',
    scheduledWorkflowLatestBody:
      '定时任务不会固定当前工作流版本；每次触发时都会加载并校验当时最新的可用版本。',
  },
  stepper: {
    progress: '创建步骤',
    back: '上一步',
    next: '下一步',
  },
  launch: {
    title: '启动：{{name}}',
    backToEditor: '← 返回编辑器',
    fieldTaskName: '任务名称',
    fieldTaskNameHint: '用于在列表和收件箱里区分本次任务，最多 255 字符（首尾空格会被裁剪）。',
    errorTaskNameRequired: '请填写任务名称。',
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
    repoNoCommits: '该仓库还没有任何提交 —— 先做一次初始提交再启动任务，否则 worktree 无法创建。',
    upload: {
      dropTitle: '拖拽文件到此处，或从本地选择',
      chooseFiles: '选择文件…',
      selectedCount_one: '已选 {{count}} 个',
      selectedCount_other: '已选 {{count}} 个',
      removeFile: '移除',
      targetDirHint: '提交时会写入 worktree 的相对目录：{{dir}}',
      acceptHint: '接受类型：{{accept}}',
      maxSizeHint: '单文件上限：{{bytes}} 字节',
      minHint: ' / 最少 {{n}}',
      maxHint: ' / 最多 {{n}}',
    },
    repoSource: {
      bar: '仓库来源',
      path: '本地路径',
      url: '远端 URL',
      urlField: 'Git URL',
      urlHint: '支持 SSH（git@host:org/repo.git）与 HTTP/HTTPS（公开仓 / URL 中可携带 token）。',
      urlPlaceholder: 'git@github.com:org/repo.git',
      urlInvalid: 'URL 格式无法识别（应为 SSH 或 HTTP/HTTPS）',
      refField: '分支 / tag / commit（可选）',
      refHint: '留空则使用克隆后的默认分支。',
      refPlaceholder: 'main / v1.2.0 / a3f9c…',
      recentUrlsPlaceholder: '— 从已缓存仓里挑一个 —',
      cloningHint: '首次克隆可能耗时数分钟；下次启动会复用本地缓存。',
      urlAutoSync: '本地镜像会在启动前自动同步到远端（fetch + 所选分支 fast-forward）。',
      // RFC-066 multi-repo controls.
      add: '+ 增加仓库',
      remove: '− 删除仓库',
      previewDirName: '将挂载为 {{name}}/',
      maxReached: '已到达单任务最多 {{max}} 个仓库的上限',
      multiRepoBlocked: {
        'wrapper-git':
          'v1 多仓任务不支持 wrapper-git 节点；请回到工作流编辑器移除，或改用单仓启动。',
        upload:
          'v1 多仓任务不支持 multipart 上传输入；请回到工作流编辑器移除上传节点，或改用单仓启动。',
      },
    },
    gitIdentity: {
      toggle: 'Git 提交身份（可选）',
      name: 'Git 用户名',
      email: 'Git 邮箱',
      hint: '留空则使用系统默认身份',
      pairingError: '用户名和邮箱必须同时填或同时留空',
      emailInvalid: '请输入合法的邮箱（含 @）',
    },
    workingBranch: {
      label: '工作分支（可选）',
      hint: '留空则在隔离分支 agent-workflow/{任务ID} 上工作；填写则基于基线分支最新内容创建/复用该分支',
      placeholder: '例如 feature/refactor-auth',
      invalid: '分支名不合法（不能含空格 / .. / 以 / 开头或结尾等）',
    },
    autoCommitPush: {
      label: '完成后自动提交并推送',
      hint: '每个写文件的 agent 产出最终内容后，框架自动提交全部变更并推送到远端',
    },
    pathFetch: {
      label: '启动前刷新远端引用',
      switchLabel: '启动前先 `git fetch --all --prune --tags`',
      switchHint:
        '仅刷新远端跟踪 ref；不会 `pull` / `merge` / `checkout`，工作目录与当前分支保持原样。',
    },
    rawInputPlaceholder: '原始 {{kind}} 值',
    inputTooLong: '内容超出 {{max}} 字符上限',
    filesPicker: {
      pickRepoFirst: '请先选择仓库以加载文件路径。',
      loading: '正在加载文件…',
      filterPlaceholder: '筛选路径…',
      selectedCount: '已选 {{n}} 个',
      minSuffix: ' / 最少 {{min}}',
      maxSuffix: ' / 最多 {{max}}',
      kindSuffix: ' · 类型：{{kinds}}',
      moreHint: '…还有 {{n}} 项，请收窄筛选条件。',
      cacheSnapshotHint: '列表来自缓存克隆快照（克隆时的默认分支），可能与所选 ref 不一致。',
      urlFallbackHint: '该远程仓库尚未缓存，无法浏览文件；请手动填写路径（每行一个）。',
      extraSelectedHint: '以下已选路径不在当前列表，取消勾选可移除：',
    },
    gitPicker: {
      branchLabel: '分支',
      fromLabel: '起始 (sha / ref)',
      toLabel: '结束 (sha / ref)',
      prLabel: 'Pull request #',
      currentRefOption: '{{ref}}（当前值，不在缓存分支列表）',
      urlFallbackHint: '该远程仓库尚未缓存，无法列出分支；请手动填写分支名。',
    },
  },
  inspector: {
    closeAria: '关闭',
    tabEdit: '编辑',
    tabPreview: '预览',
    previewOnlyAgent: '仅 agent 节点支持预览。',
    resolvedInbound: '入边端口：',
    fieldInputKey: 'Input key',
    fieldInputKeyHint: '工作流内必须唯一；也是该 input 节点产出端口名 + launcher 字段 key。',
    fieldInputKeyRequired: 'Input key 不能为空。',
    fieldInputKeyDuplicate: 'Input key {{key}} 已被另一个工作流输入使用。',
    fieldInputKind: '字段类型',
    fieldInputKindHint:
      '决定 launcher 上的输入控件：text=单行/多行文本，files=多选文件，enum=枚举，git=分支/commit/PR。',
    fieldInputLabel: '显示标签',
    fieldInputLabelHint: 'launcher 上展示给用户的字段名；留空则使用 key。',
    fieldInputRequired: '必填',
    fieldInputDescription: '说明',
    fieldInputDescriptionHint: 'launcher 字段下方的额外说明，可空。',
    upload: {
      targetDir: '落点目录（worktree 相对路径）',
      targetDirHint: '提交任务时上传的文件会写入 worktree 下的该相对目录，例如 inputs/refs。',
      targetDirError: '落点目录必须是 worktree 相对路径，且不能含 ".."、盘符前缀或以 "/" 开头。',
      accept: '允许的类型（逗号分隔）',
      acceptHint: '扩展名（.pdf）或 MIME 模式（image/*）。留空 = 不限。',
      maxFileSize: '单文件大小上限（字节）',
      maxFileSizeHint: '留空时使用全局 uploadLimits.perFile 设置。',
      minCount: '最少文件数',
      maxCount: '最多文件数',
    },
    fieldNodeTitle: '显示名',
    fieldNodeTitleHint: '画布卡片上的标题；为空时回退到 agent 名 / input key / 节点 id。',
    fieldReviewDescription: '评审说明',
    fieldReviewDescriptionHint: '可选 — 给评审者的上下文。',
    fieldReviewInputSourceNode: '上游节点',
    fieldReviewInputSourceNodeHint: '产出待评 markdown 的上游节点 id。',
    fieldReviewInputSourcePort: '上游端口',
    fieldReviewInputSourcePortHint:
      '上游端口名；该端口在 agent 上声明的 kind 需属 markdown 家族（markdown / markdown_file / path<md>）。声明为 list<path<md>> / list<markdown> 时进入多文档评审。',
    fieldReviewRerunReject: 'reject 时重跑节点',
    fieldReviewRerunRejectHint: '按 Enter 或逗号添加节点 id；默认 = 上游节点 + 其所有可达上游。',
    fieldReviewRerunIterate: 'iterate 时重跑节点',
    fieldReviewRerunIterateHint: '按 Enter 或逗号添加节点 id；默认 = 仅上游节点。',
    fieldReviewRerunInvalid: '节点 {{id}} 不是可选的上游节点。',
    fieldReviewRollbackReject: '退回时回滚文件',
    fieldReviewRollbackRejectLabel: '回滚上游节点对 worktree 的修改',
    fieldReviewRollbackIterate: '迭代时回滚文件',
    fieldReviewRollbackIterateLabel: '回滚上游节点对 worktree 的修改（默认不回滚 — 迭代是微调）',
    fieldReviewCommentTemplate: '评审意见注入模板（高级）',
    fieldReviewCommentTemplateHint: '可选 — 覆盖 {{__review_comments__}} 渲染。留空走框架默认。',
    fieldOutputPorts: '输出端口',
    fieldOutputPortsHint: '每个端口 = 任务详情页的一张卡片；绑定到 (nodeId, portName)。',
    portNamePlaceholder: '端口名',
    upstreamPlaceholder: '上游 nodeId',
    portPlaceholder: '端口',
    remove: '移除',
    addPort: '+ 增加端口',
    innerNodeIds: '内部节点 id',
    innerNodeIdsHint: '通过画布右键菜单组装。',
    fanoutInputs: '输入端口',
    fanoutInputsHint:
      '声明的输入端口列表。有且只有一个必须标记为 shard source 且 kind 必须是 list<T>；其余作为 broadcast 端口、传给每个 shard。',
    fanoutInputNamePlaceholder: '端口名',
    fanoutInputShardSource: '分片源',
    fanoutInputShardSourceMustBeList: '分片源的 kind 必须是 list<T>',
    fanoutInputAdd: '+ 添加输入',
    fanoutInputRemove: '删除输入',
    fanoutInputUnwired: '（未连接）',
    fanoutDerivedOutputs: '推导出的输出',
    fanoutDerivedOutputsHint:
      '由 wrapper-fanout 内部自动推导：若有 aggregator agent 则用其 outputs；否则单一 __done__ signal 端口。',
    none: '无',
    loopBanner: '跨轮次状态完全靠 worktree 文件流转。v1 没有反馈端口；agent 之间通过读写文件传递。',
    fieldMaxIterations: '最大迭代次数',
    fieldExitConditionKind: '退出条件类型',
    fieldExitConditionKindHint:
      'port-empty：trim 后为空 · port-not-empty：trim 后非空（反问场景：agent 真正给出 output 才退出）· port-equals：完全相等 · port-count-lt：行数 < n',
    fieldExitConditionTarget: '退出条件目标',
    fieldExitConditionTargetHint: '(nodeId, portName)，每轮检查',
    fieldExitConditionValue: '相等值',
    fieldExitConditionN: 'n',
    fieldExitConditionSeparator: "分隔符（默认 '\\n'）",
    fieldOutputBindings: '输出绑定',
    fieldOutputBindingsHint: '把内部端口暴露为 wrapper 的输出端口。',
    outputNamePlaceholder: '输出名',
    addBinding: '+ 增加绑定',
    loopExitNodeIdSelect: '— 选择一个循环内节点 —',
    loopExitPortNameSelect: '— 选择端口 —',
    loopExitInvalidNodeId: '"{{nodeId}}" 已不在该循环内，请重新选择当前成员节点。',
    loopExitInvalidPortName: '"{{portName}}" 不是该节点声明的输出端口，请重新选择。',
    fieldAgent: '代理',
    pickAgent: '— 选一个代理 —',
    fieldPromptTemplate: 'Prompt 模板',
    fieldPromptTemplateHint: '使用 {{port_name}} 引用入边端口；内置变量如 {{__repo_path__}}。',
    edgeTitle: '边设置',
    edgeSourceLabel: '源',
    edgeTargetLabel: '目标节点',
    edgePortNameLabel: '目标端口名',
    edgePortFixedHint: '固定端口、系统端口和边界端口不能在此重命名。',
    edgeConflictMsg: '已存在同源同目标端口的边，请先删除冲突边。',
    edgeReconnectBtn: '重新连接端点',
    edgeDeleteBtn: '删除该边',
    nodePortSummary: '{{inputs}} 个输入 · {{outputs}} 个输出',
    technicalKind: '节点类型',
    technicalId: '技术 ID',
    sectionBasics: '基础',
    sectionFlow: '流程',
    sectionAdvanced: '高级',
    sectionTechnical: '技术信息',
    missingRefsLabel: '模板引用但未连入：',
    missingRefsHint: '这些端口名出现在 prompt 模板里但还没有上游边；启动 task 时会被静态校验拦下。',
    fieldClarifyDescription: '说明',
    fieldClarifyDescriptionHint: '可选；只对作者展示，不影响运行期。',
    fieldClarifyLinkedAgent: '已挂接到 agent',
    clarifyLinkedAgentMissing: '尚未挂接任何 agent — 从本节点左侧 input 端往 agent 节点拖一条线。',
    clarifyLinkedAgentHint: '反问的发起方；同一个 agent 只允许挂一个反问节点。',
    fieldClarifyInLoop: 'wrapper-loop 包裹',
    clarifyInLoopYes: '✔ 在 loop 内，可累计多轮反问。',
    clarifyInLoopNo: '⚠ 未在 wrapper-loop 内 — 反问轮数不会被限制，建议套一层 loop。',
    fieldClarifySessionMode: '反问 session 模式',
    clarifySessionModeIsolated: '独立 session（默认）',
    clarifySessionModeInline: '同 session 内反问',
    clarifySessionModeHint:
      '选「同 session」时 agent 在每轮反问之间保留完整对话历史（省 token + 响应更快）；session 失效时自动回退到独立模式。',
    missingOption: '{{value}}(缺失)',
  },
  promptPreview: {
    mockTitle: '模拟端口值',
    noPorts: '没有入边端口。增加一条入边后此处会列出。',
    assembledTitle: '拼好的 prompt',
  },
  kindSelect: {
    baseLabel: '输出类型',
    base_string: '字符串',
    base_markdown: 'Markdown 正文',
    base_signal: 'signal（控制流）',
    base_path: '文件路径',
    description_string: '短文本或结构化字符串',
    description_markdown: '支持 Markdown 格式的长文本',
    description_signal: '仅表示流程完成，不携带数据',
    description_path: '工作区内的文件路径',
    extLabel: '文件扩展名',
    ext_any: '任意文件',
    ext_md: 'Markdown（.md）',
    listToggle: 'list 列表',
    extPlaceholder: '扩展名（* / md / json）',
    extError: '扩展名只能是 * 或小写字母/数字',
    advancedToggle: '高级',
    guidedToggle: '引导',
    parseError: '不是合法的 kind（如 list<path<md>>）',
    signalHint: '仅控制流——不携带数据',
  },
  capabilityCard: {
    inputs: '输入',
    outputs: '输出',
    prompt: '提示词：',
    required: '必填',
    noneDeclared: '（未声明）',
  },
  agentForm: {
    tabsAria: '代理配置分组',
    tabBasics: '基础',
    tabPrompt: '提示词',
    tabPorts: '端口',
    tabResources: '能力与协作',
    tabAdvanced: '高级',
    portValidationBadge: '端口配置有 {{count}} 项错误',
    resourcesIntro:
      '选择这个代理运行时能使用的能力，以及它可以把工作委派给哪些协作代理。保存引用不会自动安装或下载资源。',
    technicalDetailsSummary: '技术说明',
    technicalDetailsBody:
      '协作代理会按依赖闭包递归加载，并合并成员所需的 Skill、MCP 与插件。插件从已安装缓存以 file:// 注入，启动阶段不会联网下载；引用缺失时，启动校验会要求先补齐资源。',
    sectionBasics: '基本信息',
    sectionPrompt: '提示词（正文）',
    sectionOutputs: '输入与输出',
    sectionDependencyGraph: '闭包依赖（预览）',
    sectionResources: '资源与依赖引用',
    sectionAdvanced: '高级设置',
    fieldName: '名称',
    fieldNameHint: 'kebab-case；用于 /agents/:name URL。',
    fieldNamePlaceholder: '例如 code-fixer',
    fieldDescription: '描述',
    fieldDescriptionPlaceholder: '一行简介，会显示在列表中',
    fieldInputs: '输入端口',
    fieldInputsHint:
      '声明式输入端口（名称 + 类型 + 可选的「必填」标记）。可选——输入端口会展示在能力卡上，供 leader / 编排 agent 了解该 agent 消费什么；无论此处声明与否，agent 仍通过 {{token}} 模板接收提示词。',
    inputKindLabel: '{{port}} 的输入类型',
    inputRequired: '必填',
    inputRequiredLabel: '将 {{port}} 标记为必填',
    fieldOutputs: '输出端口',
    fieldOutputsHint:
      '在 <port> envelope 中声明的端口名。可为每个端口选择类型；选「文件路径」并把扩展名设为 Markdown（.md）时，端口内容是 worktree 内的 .md 相对路径，框架会自动读取文件内容。',
    outputKindLabel: '{{port}} 的输出类型',
    outputKind_string: '字符串',
    outputKind_markdown: 'Markdown 正文',
    outputKind_markdown_file: 'Markdown 文件路径',
    ports: {
      direction: { input: '输入', output: '输出' },
      actions: {
        edit: '编辑{{direction}}端口 {{name}}（第 {{index}} 项）',
        delete: '删除{{direction}}端口 {{name}}（第 {{index}} 项）',
        confirmDelete: '确认删除{{direction}}端口 {{name}}（第 {{index}} 项）',
      },
      card: {
        customKind: '自定义类型',
        legacy: '存量名称',
        duplicate: '名称重复',
        noDescription: '未填写说明',
        required: '必填',
        wrapperSameName: '聚合后保持名称 {{name}}',
        wrapperDuplicate: '聚合名称重复',
        normalOutput: '运行信封必须按此名称产出。',
        inactiveWrapperMap: '保留的聚合映射 {{name}} → {{wrapper}} 在普通代理角色下不生效。',
      },
      validation: {
        compactTitle: '端口配置需要处理（{{count}} 项）',
        detailTitle: '端口配置问题（{{count}} 项）',
        target: { ports: '在端口中修复', advanced: '在高级设置中修复' },
        severity: { error: '错误', warning: '警告' },
        issue: {
          inputNameSchema: '第 {{position}} 个输入端口（{{name}}）名称无效。',
          inputNameLaunchBlocked:
            '输入端口 {{name}} 的名字不能用作模板变量（非法字符或保留名）——该 Agent 将无法手动启动。',
          inputNameDuplicate: '输入端口 {{name}} 在第 {{positions}} 项重复。',
          outputNameDuplicate: '输出端口 {{name}} 在第 {{positions}} 项重复。',
          outputKindInvalid: '输出 {{key}} 的类型无效：{{value}}。',
          wrapperNameDuplicate: '聚合端口 {{name}} 被第 {{positions}} 项重复使用。',
          reservedPortSidecarKey: '额外 frontmatter 不能包含保留键 {{key}}。',
          orphanOutputKind: '类型映射 {{key}} 没有对应的输出端口：{{value}}。',
          orphanWrapperName: '聚合映射 {{key}} 没有对应的输出端口：{{value}}。',
        },
      },
      inputsTitle: '输入端口',
      inputsRelation: '描述这个代理需要接收什么，帮助编排者正确选择和调用它。',
      outputsTitle: '输出端口',
      outputsRelation: '定义代理可产出的结果，以及每项结果的数据类型。',
      count: '{{count}} 个',
      addInput: '添加输入端口',
      addOutput: '添加输出端口',
      inputsEmptyTitle: '还没有输入端口',
      inputsEmptyDescription: '如果代理需要明确的上下文或文件，请添加输入端口。',
      outputsEmptyTitle: '还没有输出端口',
      outputsEmptyDescription: '添加代理会产出的结果，让工作流可以引用它。',
      addInputDialogTitle: '添加输入端口',
      editInputDialogTitle: '编辑输入端口',
      addOutputDialogTitle: '添加输出端口',
      editOutputDialogTitle: '编辑输出端口',
      fieldName: '端口名称',
      fieldKind: '数据类型',
      fieldRequired: '必填输入',
      fieldDescription: '说明',
      fieldDescriptionHint: '可选，最多 2048 个字符；会显示在能力卡中。',
      fieldWrapperName: '聚合后端口名',
      fieldWrapperNameHint: '留空表示与当前输出端口同名。',
      saveAdd: '添加端口',
      saveEdit: '保存更改',
      cancel: '取消',
      editInput: '编辑输入端口 {{name}}（第 {{position}} 项）',
      editOutput: '编辑输出端口 {{name}}（第 {{position}} 项）',
      deleteInput: '删除输入端口 {{name}}（第 {{position}} 项）',
      deleteOutput: '删除输出端口 {{name}}（第 {{position}} 项）',
      confirmDeleteInput: '确认删除输入端口 {{name}}（第 {{position}} 项）',
      confirmDeleteOutput: '确认删除输出端口 {{name}}（第 {{position}} 项）',
      requiredChip: '必填',
      noDescription: '未填写说明',
      wrapperSame: '聚合后保持同名',
      wrapperMapping: '{{name}} → {{wrapper}}',
      legacyChip: '存量名称',
      duplicateChip: '名称重复',
      renameWarning: '重命名可能让现有工作流引用失效；启动校验仍会阻止失效连线。',
      legacyWarning: '这是可读取的存量名称；保持原名可以保存，改名时需使用标准格式。',
      errorRequired: '请输入端口名称。',
      errorFormat: '以小写字母开头，仅可包含小写字母、数字和下划线。',
      errorTooLong: '输入端口名称最多 128 个字符。',
      errorDuplicate: '端口名称必须唯一。',
      errorWrapperDuplicate: '聚合后的端口名必须唯一。',
      errorKindInvalid: '请选择合法的数据类型。',
      errorOrphanConflict: '该名称仍有未关联映射，请先在下方清理。',
      errorStale: '目标端口已变化，请关闭后重新打开。',
      orphanTitle: '发现未关联的输出映射',
      orphanDescription: '这些历史配置没有对应的输出端口。清理后才能复用同名端口。',
      orphanKind: '类型映射：{{key}} = {{value}}',
      orphanWrapper: '聚合映射：{{key}} = {{value}}',
      cleanupOrphan: '清理 {{key}} 的未关联映射',
      confirmCleanupOrphan: '确认清理 {{key}} 的未关联映射',
      validationTitle: '端口配置需要处理',
      validationCompactTitle: '创建或保存前，请修复端口配置。',
      navigatePorts: '前往端口',
      navigateAdvanced: '前往高级设置',
      issueInputNameSchema: '输入端口 {{name}} 不符合长度要求。',
      issueInputNameDuplicate: '输入端口 {{name}} 重复。',
      issueOutputNameDuplicate: '输出端口 {{name}} 重复。',
      issueOutputKindInvalid: '输出 {{key}} 的类型无效。',
      issueWrapperNameDuplicate: '聚合后的端口名 {{name}} 重复。',
      issueReservedPortSidecarKey: '额外 frontmatter 中含保留键 {{key}}。',
      issueOrphanOutputKind: '类型映射 {{key}} 没有对应的输出端口。',
      issueOrphanWrapperName: '聚合映射 {{key}} 没有对应的输出端口。',
    },
    groupCapabilities: '可用能力',
    groupCapabilitiesHint: '运行时可调用的技能、工具和扩展',
    groupDependencies: '协作代理',
    groupDependenciesHint: '这个代理可以向其委派工作',
    fieldSkills: '技能',
    fieldSkillsHint: '可复用的工作说明与工具能力。',
    fieldSkillsPlaceholder: '输入技能名后按 Enter',
    skillsPickerLoading: '加载中…',
    skillsPickerEmpty: '暂无可选技能（尚无可用项）',
    skillsPickerLoadFailed: '加载技能列表失败；仍可直接输入。',
    fieldDependsOn: '可协作的代理',
    fieldDependsOnHint: '当前代理可以把子任务委派给这些代理；所需能力会随任务一起加载。',
    fieldDependsOnPlaceholder: '输入代理名后按 Enter',
    dependsPickerLoading: '加载中…',
    dependsPickerEmpty: '暂无可选代理（尚无可用项）',
    dependsPickerLoadFailed: '加载代理列表失败；仍可直接输入。',
    fieldMcps: 'MCP 服务',
    fieldMcpsHint: '运行时可连接的工具与数据源。',
    fieldMcpsPlaceholder: '输入 MCP 名后按 Enter',
    mcpsPickerLoading: '加载中…',
    mcpsPickerEmpty: '暂无可选 MCP（尚无可用项）',
    mcpsPickerLoadFailed: '加载 MCP 列表失败；仍可直接输入。',
    fieldPlugins: '插件',
    fieldPluginsHint: '已安装并可在运行时启用的扩展。',
    fieldPluginsPlaceholder: '输入插件名后按 Enter',
    pluginsPickerLoading: '加载中…',
    pluginsPickerEmpty: '暂无可选插件（尚无可用项）',
    pluginsPickerLoadFailed: '加载插件列表失败；仍可直接输入。',
    fieldSyncOutputsOnIterate: '文档迭代期间是否同步刷新本代理生成的其他文档',
    fieldSyncOutputsOnIterateHint:
      '仅当本代理 outputs 含 ≥ 2 个 markdown / markdown_file 时实际生效；关闭则在用户点"返回修改"时只重生被评审的那一份，其他文档沿用上一版本。',
    fieldRole: '角色',
    fieldRoleHint:
      'RFC-060：普通 agent 是 workflow 中的常规节点；聚合 agent 用于 wrapper-fanout 收口、跑 1 次、看到所有 shard 的 raw list。当前阶段 (PR-B) 聚合 agent 还不能被放到 canvas 上，需等 PR-C 落地 wrapper-fanout 后启用。',
    roleNormal: '普通',
    roleAggregator: '聚合',
    fieldOutputWrapperPortNames: '输出 → wrapper 端口名映射',
    fieldOutputWrapperPortNamesHint:
      '仅聚合 agent 生效。JSON 对象，键为本 agent 声明的 output 端口名，值为 promote 到 wrapper-fanout 出口时的端口名；缺省即同名 mirror。',
    fieldRuntime: '运行时',
    fieldRuntimeHint:
      '驱动该代理的 CLI 运行时。选"继承"则跟随全局默认。Claude Code 有独立的模型命名空间，且不支持 variant / temperature。',
    runtimeInherit: '继承（全局默认）',
    runtimeOpencode: 'opencode',
    runtimeClaudeCode: 'Claude Code',
    fieldPermission: 'Permission JSON',
    fieldPermissionHint: 'opencode permission 对象，透传。',
    permissionPlaceholder: '{"edit":"allow","webfetch":"deny"}',
    fieldFrontmatterExtra: '额外 frontmatter (JSON)',
    fieldFrontmatterExtraHint: '除 name/description/outputs/permission/skills 之外的其它键。',
    jsonSyntaxError: '请输入合法的 JSON 对象，并检查引号、逗号和括号是否完整。',
    jsonObjectError: '请输入使用 { ... } 表示的 JSON 对象；不支持数组、字符串或数字。',
    jsonValidationTitle: '高级 JSON 需要处理（{{count}} 项）',
    jsonValidationBadge: '{{count}} 个 JSON 字段无效',
    jsonErrorStatus: '错误',
    jsonFixField: '修复{{field}}',
    fieldBody: '正文 (Markdown)',
    bodyPlaceholder: 'Agent 系统提示词；Markdown。',
    importButton: '从 agent.md 导入',
    autodetect: {
      button: '自动识别依赖',
      dialogTitle: '识别到的潜在依赖',
      dialogHint: '按子串匹配，请人工确认每一项',
      emptyText: '未识别到新依赖',
      groupLoadFailed: '{{group}} 列表加载失败，已跳过',
      groupName: {
        agents: 'Agent',
        skills: 'Skill',
        mcps: 'MCP',
        plugins: 'Plugin',
      },
      section: {
        agents: 'Agents（{{count}}）',
        skills: 'Skills（{{count}}）',
        mcps: 'MCPs（{{count}}）',
        plugins: 'Plugins（{{count}}）',
      },
      cancelButton: '取消',
      applyButton: '导入选中（{{count}}）',
      closeButton: '关闭',
    },
    importDialog: {
      title: '从 agent.md 导入',
      tabUpload: '上传文件',
      tabPaste: '粘贴文本',
      pastePlaceholder:
        '---\ndescription: 代码评审员\nruntime: opencode-review\npermission:\n  edit: ask\n---\n你是一名审计员……',
      cancelButton: '取消',
      orphanConflict:
        '导入会占用未关联映射 {{mappings}}；请先在端口页显式清理，或在本次导入中同时提供对应映射。',
      invalidExtension: '请选择 .md 或 .markdown 文件。',
      fileReadFailed: '无法读取文件：{{message}}',
      sourcePaste: '粘贴内容（{{size}}）',
      sourceUpload: '{{name}}（{{size}}）',
      emptyValue: '空值',
      bodySummary: '{{lines}} 行 · {{bytes}} 字节',
      inputSummary: '{{count}} 个输入端口',
      listSummary: '{{count}} 项',
      mapSummary: '{{count}} 个映射',
      ruleSummary: '{{count}} 条规则',
      extraLabel: '保留的 {{type}} 值',
      checkButton: '检查内容',
      checkingFile: '正在读取…',
      backButton: '返回修改',
      applyDraftButton: '应用到草稿（{{count}}）',
      importAnother: '继续导入',
      viewForm: '查看表单',
      selectTitle: '选择导入来源',
      selectDescription: '上传 agent.md，或直接粘贴完整 Markdown 内容。',
      uploadTitle: '拖放 agent.md 到这里',
      uploadDescription: '支持 .md 和 .markdown；检查前不会修改当前草稿。',
      chooseFile: '选择文件',
      replaceFile: '更换文件',
      removeFile: '移除',
      pasteLabel: 'agent.md 内容',
      pasteHint: 'YAML frontmatter 与正文会一起解析。',
      draftOnlyTitle: '只更新当前草稿',
      draftOnlyHint: '导入不会创建 Agent；检查并应用后，仍需在页面上点击「创建」。',
      reviewTitle: '检查导入内容',
      itemCount: '{{count}} 个字段',
      sectionCount: '{{count}} 个表单分区',
      warningCount: '{{count}} 条提醒',
      fixPortsButton: '前往端口修复',
      overwriteTitle: '将覆盖已编辑内容',
      overwriteDescription: '以下 {{count}} 个字段已有草稿内容，应用后会被导入值替换。',
      warningTitle: '解析提醒',
      resolveReferences: '为重名引用选择目标所有者',
      previewEmptyTitle: '没有可应用的内容',
      previewEmptyDescription: '返回并补充 agent.md 字段或正文后再检查。',
      resultTitle: '已应用到草稿',
      resultDescription: '已从 {{source}} 应用 {{items}} 个字段，覆盖 {{sections}} 个表单分区。',
      resultNextStep: '关闭此窗口检查表单，确认无误后点击页面右上角的「创建」。',
      notCreated: 'Agent 尚未创建',
    },
    markdownEditLabel: '编辑',
    markdownPreviewLabel: '预览',
    markdownPreviewEmpty: '暂无可预览内容。',
  },
  dependencyTree: {
    skills: '技能：{{names}}',
    mcps: 'MCP：{{names}}',
    plugins: '插件：{{names}}',
    seeAbove: '↑ 见上',
    cycleHeading: '依赖闭包检测到环：',
    ariaTreeLabel: '依赖树',
    missingPrefix: '<缺失> {{name}}',
    maskedPrefix: '<无权访问> {{name}}',
    openAgentAria: '打开代理 {{name}}',
  },
  dependencyTreePreview: {
    emptyHint: '暂未声明依赖代理；上方添加后会在此实时显示闭包。',
    loading: '加载闭包中…',
    errorSelf: '代理不能依赖自身。',
    errorNotFound: '未找到代理：{{names}}',
    errorGeneric: '闭包预览失败（{{code}}）',
  },
  nodeDrawer: {
    kindLabel: 'node_run',
    tabPrompt: 'Prompt',
    tabSession: '会话',
    sessionPending: '会话尚未生成。',
    sessionNotApplicable: '该节点类型不产生 opencode 会话。',
    sessionFanoutParent: '父 fan-out 节点本身没有会话，请选择一个 shard。',
    tabEvents: '事件',
    tabOutput: '输出',
    tabStats: '统计',
    eventCount: '{{count}} 条事件',
    outputCount: '{{count}} 项输出',
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
    statWgRound: '工作组轮次',
    statTokensIn: '输入 tokens',
    statTokensOut: '输出 tokens',
    statTokensTotal: '总 tokens',
    statCacheCreate: '缓存创建',
    statCacheRead: '缓存读取',
    statError: '错误',
    statHistory: '运行历史',
    iterLoop: '循环#{{n}}',
    iterReview: '评审#{{n}}',
    iterClarify: '反问#{{n}}',
    iterCrossClarify: '跨反问#{{n}}',
    iterRetry: '重试#{{n}}',
    iterInitial: '初次',
    statDependencyTree: '依赖闭包',
    attempt: '第 {{n}} 次',
    noEventsMatch: '没有事件匹配当前过滤。',
    retryButton: '重试节点',
    retrying: '重试中…',
    retryCascadeLabel: '同时重跑下游节点',
    promptAttemptLabel: '执行',
    promptAttemptEntry: '轮次={{iter}} 重试={{retry}} · {{status}} · {{time}}',
    promptAttemptShard: '轮次={{iter}} 重试={{retry}} · shard={{shard}} · {{status}} · {{time}}',
    promptAttemptParent: '轮次={{iter}} 重试={{retry}} · 多进程父节点 · {{status}} · {{time}}',
    injectedMemoriesTitle: '已注入记忆 ({{n}})',
    injectedMemoriesEmpty: '本次执行未注入任何记忆。',
    injectedMemoriesNotCaptured: '未记录本次注入清单。',
    injectedMemoriesInheritedFromAttempt0: '沿用 attempt 0 的注入快照',
    injectedMemoriesGroup_agent: 'Agent 范围',
    injectedMemoriesGroup_workflow: 'Workflow 范围',
    injectedMemoriesGroup_repo: 'Repo 范围',
    injectedMemoriesGroup_global: '全局',
    injectedMemoriesVersionLabel: 'v{{n}}',
    promptFanoutParent: '多进程父节点本身没有 prompt — 请选一个 shard。',
    promptNotApplicable: '该节点种类不发起 opencode prompt。',
    promptEmpty: '本次执行尚未记录 prompt。',
    inventory: {
      title: '运行时清单',
      pending: '正在捕获清单…',
      empty: '（无）',
      chip: { agents: '智', skills: '技', mcps: 'M', plugins: '插' },
      subtitle: { agents: '智能体', skills: '技能', mcps: 'MCP 服务', plugins: '插件' },
      col: {
        name: '名称',
        mode: '模式',
        model: '模型',
        source: '来源',
        path: '路径',
        desc: '描述',
        status: '状态',
        type: '类型',
        hint: '提示',
        specifier: '标识',
      },
      source: { inline: '内联', project: '项目', global: '全局', native: '内置', unknown: '未知' },
      status: {
        connected: '已连接',
        disabled: '已禁用',
        needs_auth: '需要认证',
        needs_client_registration: '需要注册客户端',
        failed: '失败',
        not_initialized: '未初始化',
      },
      reason: {
        'file-missing': '未生成清单文件（插件可能加载失败）。',
        'parse-failed': '清单文件格式异常。',
        'opencode-pure-mode': 'opencode 处于 --pure 模式，未启用外部插件。',
        'plugin-load-failed': '插件写入或加载失败。',
        'dump-plugin-internal-error': '清单插件内部报错。',
        'non-agent-kind': '该节点类型不产生运行时清单。',
        // RFC-062: still-running agent run, runner hasn't read inventory.json
        // into the DB yet. Phrasing avoids blaming the plugin (which is fine).
        'in-flight': '正在运行，清单生成中…',
      },
    },
    statSession: 'opencode 会话',
    unknownPlugin: '(未知插件)',
    sessionParentBadge: '父级',
  },
  noderunStatus: {
    pending: '待运行',
    running: '运行中',
    done: '已完成',
    failed: '失败',
    canceled: '已取消',
    interrupted: '已中断',
    skipped: '已跳过',
    exhausted: '已耗尽重试',
    awaiting_review: '待评审',
    awaiting_human: '待回答反问',
    superseded: '已被新尝试取代',
    supersededHint:
      '本次尝试在评审 {{decision}} 后被新一次重试取代，worktree 中的文件未回退；Prompt 与输出仍保留在此条目以备查阅。',
    rollbackHint: '本次尝试在评审 {{decision}} 后已取消，worktree 中的文件已回退到尝试前的快照。',
    decision: {
      iterated: '迭代',
      rejected: '退回',
    },
  },
  taskOutputs: {
    section: '产出',
    pending: '等待中…',
    download: '下载',
    downloading: '下载中…',
    downloadFailed: '下载失败',
    artifactTruncated: '归档副本超过 2 MiB 已截断——完整文件请从工作区下载。',
  },
  taskPreview: {
    button: '预览',
    back: '返回',
    title: 'Markdown 预览',
    invalidLink: '无效的预览链接。',
    pending: '输出尚未产生。',
  },
  settingsForm: {
    commitPushModel: '提交&推送模型',
    commitPushModelHint:
      'RFC-075 自动提交时生成 commit message / 修复被拒推送的模型；留空用 opencode 默认（建议填便宜模型）。',
    commitPushRuntime: '提交&推送运行时',
    commitPushRuntimeHint:
      '内置 commit agent 运行的运行时 profile，其 model 来自该 profile；留空则继承全局默认运行时。',
    commitPushMaxRepairRetries: '推送修复重试上限',
    commitPushMaxRepairRetriesHint:
      '推送被规范拒收时起修复会话改 message 重推的最大次数（默认 3；鉴权失败不重试）。',
    commitPushDiffMaxBytes: 'commit message diff 字节上限',
    commitPushDiffMaxBytesHint:
      '喂给生成 commit message 的 diff 截断阈值（默认 16384；0 表示只用 --stat）。',
    mergeAgentRuntime: '合并冲突运行时',
    mergeAgentRuntimeHint:
      '内置合并冲突解决 agent 运行的运行时 profile，其 model 来自该 profile；留空则继承全局默认运行时。',
    maxConcurrentNodes: '最大并发节点数',
    multiProcessConc: 'Multi-process 子进程并发',
    logLevel: '日志级别',
    perTaskDuration: '单 task 最大时长 (ms)',
    perTaskTokens: '单 task 最大 token 数',
    perNodeTimeout: '单节点超时 (ms)',
    nodeRetries: '默认节点重试次数',
    nodeRetriesHint: '每个节点可恢复失败的重试预算（0 = 不重试）。默认 3。',
    autoResumeOnBoot: '启动时自动续跑被中断的任务',
    autoResumeOnBootHint:
      '默认关闭。开启后 daemon 启动时自动续跑因重启而中断的任务（穿熔断/隔离/租约/审计）。',
    autoRepairS4: '自动修复卡死的 pending 任务（S4.kick）',
    autoRepairS4Hint:
      '默认关闭。仅对唯一安全的 S4.kick-task 启用自动修复（重新推送调度器漏掉的 pending 任务）。',
    autoKillStalledChild: '自动杀死心跳停滞的子进程',
    autoKillStalledChildHint:
      '默认关闭。子进程事件流静默超过下方阈值即自动杀死（复用 PID 身份门，绝不误杀回收 pid）。',
    heartbeatStallMs: '心跳停滞阈值 (ms)',
    maxAutoRecoveriesPerWindow: '熔断：每窗口最大自动恢复次数',
    autoRecoveryWindowMs: '熔断：滚动窗口 (ms)',
    periodicOrphanReconcileMs: '周期孤儿回收间隔 (ms)',
    zeroDisabled: '0 表示禁用',
    largeOutputThreshold: '大输出阈值 (bytes)',
    zeroUnlimited: '0 = 无限制。',
    autoGcLabel: '自动 GC 已合并的 worktree',
    gitRecurseSubmodules: 'submodule 递归模式',
    gitRecurseSubmodulesHint:
      'auto：检测到 .gitmodules 才递归（默认）；always：始终递归；never：完全关闭。',
    gitRecurseAuto: 'auto（检测到才递归）',
    gitRecurseAlways: 'always（始终递归）',
    gitRecurseNever: 'never（关闭）',
    gitSubmoduleJobs: 'submodule 并行度',
    gitSubmoduleJobsHint: 'clone / update 的 --jobs N。默认 4；git 低于 2.13 时自动降为 1。',
    gitSubmoduleRemote: '子模块跟随上游最新',
    gitSubmoduleRemoteHint:
      '任务 worktree 创建时把每个 submodule 拉到其上游分支最新，而非父仓记录的 commit；之后整个任务期间不再变动。默认关闭——用可重现性换新鲜度。',
    submoduleAutoRefresh: '后台定时刷新缓存仓',
    submoduleAutoRefreshHint:
      '定期对最近用过的缓存仓跑 fetch + submodule 同步，不必等到起任务或手动刷新。',
    submoduleRefreshIntervalMs: '刷新间隔（毫秒）',
    submoduleOnlyRecentDays: '只刷最近多少天用过的仓',
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
    bindPortHint:
      '需要重启。留空 / 0 表示启动时自动挑选空闲端口；当前实际端口只作提示，不会自动保存。',
    bindPortCurrent: '本次运行实际使用 {{port}}。',
    bindPortUseCurrent: '固定为当前端口',
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
    labelGit: 'Git 包装器',
    labelLoop: '循环包装器',
    labelFanout: '分片包装器',
    pillGit: '快照',
    pillLoop: '循环',
    pillFanout: '分片',
    shardSourceTag: '分片源 — 列表中每个元素触发一次内部子图执行',
    shardSourceTagShort: '分片源',
    dropHere: '把节点拖到这里',
    fitToChildren: '自适应内部节点',
    unwrap: '解散包装器',
    deleteWithInner: '连同内部节点一起删除',
    confirmDeleteWithInner: '确定连同 {{count}} 个内部节点一起删除该包装器？此操作不可撤销。',
    deleteScopeChanged: '确认期间包装器内容已变更。请关闭本次确认，然后从最新画布重新发起删除。',
  },
  ioNode: {
    labelInput: '输入',
    labelOutput: '输出',
  },
  agentNode: {
    label: '代理',
  },
  clarifyDirective: {
    groupLabel: '反问指令',
    continue: '继续反问',
    stop: '停止反问',
  },
  canvas: {
    connect: { newInput: '新增输入', reuseInput: '复用输入' },
    clipboardBlocked: '所选步骤存在不完整的引用或输入声明，已阻止本次复制或粘贴。',
    clipboardReferencesFiltered: '已安全移除 {{n}} 个指向复制范围外的引用，请检查粘贴后的配置。',
    referencesPruned: '已清理 {{n}} 个失效图引用，工作流结构仍保持一致。',
    referenceChangeBlocked: '存在无法安全更新的未知步骤引用，已阻止本次变更。',
    accessibleName: '工作流画布',
    accessibleDescription:
      '使用“添加”或节点工具栏创建并连接步骤；方向键移动焦点，Delete 删除当前选择。',
    nodeConfigurationSummary: '{{inputs}} 个输入 · {{outputs}} 个输出',
    placementUnavailable: '该位置附近没有可用空间，请平移画布后重试。',
    layoutCrossScope: '所选步骤分属不同包装器范围。请分别整理每个范围，或使用“整理全图”。',
    layoutCycles: '布局时保留了 {{n}} 条循环依赖边，但未用它们约束层级。',
    layoutLockedOverflow: '有 {{n}} 个锁定尺寸的包装器放不下整理后的步骤；其锁定矩形已保留。',
  },
  reviewNode: {
    label: '评审',
    navAwaiting: '点击打开评审',
    navDecided: '点击查看最近评审结论',
  },
  clarifyNode: {
    label: '反问',
    navAwaiting: '点击回答反问',
    navAnswered: '点击查看反问记录',
  },
  crossClarifyNode: {
    label: '跨代理反问',
  },
  // RFC-203: per-domain fallback templates — any unmapped code resolves to
  // its domain's template instead of a bare English message.
  errorDomains: {
    taskQuestion: '问题看板操作失败',
    task: '任务操作失败',
    clarify: '反问操作失败',
    review: '评审操作失败',
    workflow: '工作流操作失败',
    workgroup: '工作组操作失败',
    skill: '技能操作失败',
    agent: '代理操作失败',
    mcp: 'MCP 操作失败',
    plugin: '插件操作失败',
    memory: '记忆操作失败',
    schedule: '定时任务操作失败',
    fusion: '融合操作失败',
    runtime: '运行时操作失败',
    upload: '文件上传失败',
    repo: '仓库操作失败',
    lifecycle: '任务生命周期操作失败',
    auth: '账号或权限校验失败',
    misc: '请求失败',
  },
  validation: {
    issue: {
      'agent-not-found': '节点引用的代理不存在。',
      'agent-dependency-not-found': '节点使用的代理依赖了不存在的代理。',
      'aggregator-agent-outside-fanout': '聚合代理只能放在扇出包装器内部。',
      'skill-not-found': '节点使用的代理引用了不存在的技能。',
      'plugin-not-found': '节点使用的代理引用了不存在的插件。',
      'plugin-disabled': '节点使用的代理引用了已停用的插件。',
      'binding-node-missing': '输出端口绑定到了不存在的节点。',
      'binding-port-missing': '输出端口绑定到了不存在的端口。',
      'boundary-input-port-not-declared': '包装器入界边引用了未声明的输入端口。',
      'boundary-input-source-not-wrapper': '包装器入界边的源头不是扇出包装器。',
      'boundary-input-target-not-inner': '包装器入界边指向了包装器外的节点。',
      'boundary-output-source-must-be-aggregator': '包装器出界边必须从聚合代理引出。',
      'boundary-output-source-not-inner': '包装器出界边的源头不在包装器内。',
      'boundary-output-target-not-wrapper': '包装器出界边的目标不是扇出包装器。',
      'clarify-questions-port-missing': '反问节点的 questions 端口缺少入边。',
      'clarify-answers-port-disconnected':
        '反问节点的 answers 端口没有出边（答案仍会经内部通道注入）。',
      'clarify-input-source-missing': '反问节点的入边引用了不存在的节点。',
      'clarify-multiple-clarify-on-same-agent': '同一个代理只能挂一个反问通道。',
      'clarify-multiple-source-agents': '反问节点的 questions 入边来自多个代理。',
      'clarify-no-iteration-cap': '反问节点不在循环包装器内，代理可能无限追问。',
      'clarify-self-loop': '反问节点的答案边指回了自己。',
      'clarify-target-not-agent': '反问节点必须连接到单进程代理节点。',
      'cross-clarify-auto-edge-deleted': '跨节点反问缺少指回提问方的自动边。',
      'cross-clarify-has-downstream': '跨节点反问节点不能再有其它下游出边。',
      'cross-clarify-input-source-missing': '跨节点反问的 questions 端口缺少入边。',
      'cross-clarify-manual-edge-missing': '跨节点反问缺少 to_designer 出边，提交将无处送达。',
      'cross-clarify-multiple-designers': '跨节点反问的 to_designer 边指向了多个代理。',
      'cross-clarify-multiple-questioners': '跨节点反问的 questions 入边来自多个代理。',
      'cross-clarify-no-iteration-cap': '跨节点反问不在循环包装器内，提问方可能无限追问。',
      'cross-clarify-self-review-warning': '跨节点反问的设计方与提问方是同一个代理。',
      'cross-clarify-target-not-agent-single': '跨节点反问必须连接单进程代理作为提问方。',
      'cross-clarify-target-not-ancestor': '跨节点反问的设计方必须是提问方的上游节点。',
      'edge-source-node-missing': '边的源节点不存在。',
      'edge-source-port-missing': '边的源端口不存在。',
      'edge-target-node-missing': '边的目标节点不存在。',
      'edge-target-port-missing': '边的目标端口不存在。',
      'fanout-inner-chain-unsupported': '扇出包装器内不支持把节点串联到非聚合节点。',
      'input-key-duplicate': '输入 key 重复。',
      'input-key-not-declared': '输入节点引用的 key 未在工作流 inputs 里声明。',
      'input-orphan-declared': '工作流声明的输入没有任何输入节点引用。',
      'multiple-aggregators-in-fanout': '一个扇出包装器最多只能有一个聚合代理。',
      'node-id-duplicate': '工作流内的节点 id 必须唯一。',
      'prompt-template-deprecated-token': '提示词引用了已废弃的模板变量（会渲染为空）。',
      'prompt-template-unresolved': '提示词引用的模板变量没有对应的入边端口。',
      'review-input-list-item-not-markdown': '评审节点的列表输入元素类型必须是 markdown。',
      'review-input-edge-conflict': '评审节点只能接收一条输入边。',
      'review-input-edge-mismatch': '评审节点的输入边与已选择的输入来源不一致。',
      'review-input-source-missing': '评审节点缺少或错误配置了输入来源。',
      'review-input-source-not-markdown': '评审节点的输入来源必须声明为 markdown / path 类型。',
      'review-rerunnable-out-of-scope': '评审驳回后可重跑的节点必须在输入来源的上游范围内。',
      'system-port-illegal-source': '答案注入端口只能由反问节点馈入。',
      'system-port-illegal-target': '该端口是答案注入端口，目标必须是代理节点。',
      'system-port-mispaired-target': '答案必须注回提出问题的那个代理。',
      'topology-cycle': '工作流在循环包装器之外存在环。',
      'upload-input-target-dir-missing': '上传输入缺少目标目录。',
      'upload-input-target-dir-invalid': '上传输入的目标目录必须是仓库内相对路径。',
      'wrapper-children-outside-bounds': '包装器内有节点超出了包装器边界。',
      'wrapper-child-duplicate': '包装器重复列出了同一个直接子节点。',
      'wrapper-child-multiple-parents': '同一个节点不能直接属于多个包装器。',
      'wrapper-child-node-missing': '包装器引用了不存在的子节点。',
      'wrapper-containment-cycle': '包装器包含关系不能形成环。',
      'wrapper-empty': '包装器内没有任何节点。',
      'wrapper-fanout-nested': '扇出包装器不能嵌套在另一个扇出包装器里。',
      'wrapper-fanout-shard-source-duplicate': '扇出包装器只能有一个分片来源端口。',
      'wrapper-fanout-shard-source-missing': '扇出包装器缺少分片来源端口。',
      'wrapper-fanout-shard-source-must-be-list': '分片来源端口的类型必须是列表（list<T>）。',
      'wrapper-input-boundary-missing': '进入扇出包装器的数据必须经过已声明的输入边界。',
      'wrapper-loop-exit-condition': '循环包装器缺少退出条件。',
      'wrapper-loop-exit-node-missing': '循环退出条件引用了不存在的节点。',
      'wrapper-loop-exit-node-out-of-scope': '循环退出条件必须引用循环体的直接成员。',
      'wrapper-loop-exit-port-missing': '循环退出条件引用了不存在的端口。',
      'wrapper-loop-inner-data-cycle': '循环包装器内部存在数据环。',
      'wrapper-loop-max-iterations': '循环包装器缺少最大迭代次数。',
      'wrapper-loop-nested': '循环包装器不能嵌套在另一个循环包装器里。',
      'wrapper-loop-output-binding-out-of-scope': '循环输出绑定必须引用循环体的直接成员。',
      'wrapper-output-boundary-missing': '离开包装器的数据必须通过包装器输出边界显式暴露。',
    },
    family: {
      'wrapper-loop': '循环包装器配置有误。',
      'wrapper-fanout': '扇出包装器配置有误。',
      wrapper: '包装器配置有误。',
      'cross-clarify': '跨节点反问接线有误。',
      clarify: '反问节点接线有误。',
      boundary: '包装器边界接线有误。',
      edge: '连线有误。',
      binding: '输出绑定有误。',
      'upload-input': '上传输入配置有误。',
      input: '工作流输入配置有误。',
      review: '评审节点配置有误。',
      'prompt-template': '提示词模板有误。',
      'system-port': '系统端口接线有误。',
    },
    fallback: '工作流校验未通过。',
  },
  // RFC-203: structured details renderer strings.
  errorDetails: {
    hintPrefix: '下一步',
    moreIssues: '…另有 {{count}} 条问题未列出',
    referencedByNames: '引用方：{{names}}。',
    referencedByHidden: '另有 {{count}} 个你不可见的引用方。',
    referencedByCount: '存在 {{count}} 个引用方，需先解除引用。',
    availableRefs: '可用分支/引用：{{refs}}',
    versionConflict: '版本冲突：你基于 v{{expected}}，服务器已是 v{{current}}——请刷新后重试。',
    stderrSummary: 'git 输出',
    rawSummary: '原始错误信息',
  },
  // Error codes thrown by the backend (DomainError family + transport).
  errors: {
    // --- wire / transport（Tier-2） ---
    'network-unreachable': '无法连接到服务。',
    'network-unreachable__hint': '请确认 daemon 正在运行、网络可达后重试。',
    'request-timeout': '请求超时，已停止等待。',
    'request-timeout__hint': '服务端可能仍在处理这次请求。刷新页面确认结果后再决定是否重试。',
    'route-not-found': '路由不存在。',
    'ws-unknown-channel': '实时通道不存在。',
    'internal-error': '服务内部错误。',
    'internal-error__hint': '稍后重试；若持续出现，请查看 daemon 日志。',
    // RFC-224：API/save/probe 与任务失败复用同一组稳定文案。
    'execution-identity-untrusted-binary': '$t(tasks.failure.execution-identity-untrusted-binary)',
    'execution-identity-untrusted-binary__hint':
      '$t(tasks.failure.execution-identity-untrusted-binary__hint)',
    'execution-identity-sandbox-required': '$t(tasks.failure.execution-identity-sandbox-required)',
    'execution-identity-sandbox-required__hint':
      '$t(tasks.failure.execution-identity-sandbox-required__hint)',
    'execution-identity-project-config-unsupported':
      '$t(tasks.failure.execution-identity-project-config-unsupported)',
    'execution-identity-project-config-unsupported__hint':
      '$t(tasks.failure.execution-identity-project-config-unsupported__hint)',
    'execution-identity-plugin-unsupported':
      '$t(tasks.failure.execution-identity-plugin-unsupported)',
    'execution-identity-plugin-unsupported__hint':
      '$t(tasks.failure.execution-identity-plugin-unsupported__hint)',
    'execution-identity-dependent-unsupported':
      '$t(tasks.failure.execution-identity-dependent-unsupported)',
    'execution-identity-dependent-unsupported__hint':
      '$t(tasks.failure.execution-identity-dependent-unsupported__hint)',
    'execution-identity-model-unresolved': '$t(tasks.failure.execution-identity-model-unresolved)',
    'execution-identity-model-unresolved__hint':
      '$t(tasks.failure.execution-identity-model-unresolved__hint)',
    'execution-identity-auth-invalid': '$t(tasks.failure.execution-identity-auth-invalid)',
    'execution-identity-auth-invalid__hint':
      '$t(tasks.failure.execution-identity-auth-invalid__hint)',
    'execution-identity-provider-untrusted':
      '$t(tasks.failure.execution-identity-provider-untrusted)',
    'execution-identity-provider-untrusted__hint':
      '$t(tasks.failure.execution-identity-provider-untrusted__hint)',
    'execution-identity-bootstrap-failed': '$t(tasks.failure.execution-identity-bootstrap-failed)',
    'execution-identity-bootstrap-failed__hint':
      '$t(tasks.failure.execution-identity-bootstrap-failed__hint)',
    'execution-identity-mismatch': '$t(tasks.failure.execution-identity-mismatch)',
    'execution-identity-mismatch__hint': '$t(tasks.failure.execution-identity-mismatch__hint)',
    'execution-identity-instance-changed': '$t(tasks.failure.execution-identity-instance-changed)',
    'execution-identity-instance-changed__hint':
      '$t(tasks.failure.execution-identity-instance-changed__hint)',
    'execution-identity-source-changed': '$t(tasks.failure.execution-identity-source-changed)',
    'execution-identity-source-changed__hint':
      '$t(tasks.failure.execution-identity-source-changed__hint)',
    'execution-identity-skill-mismatch': '$t(tasks.failure.execution-identity-skill-mismatch)',
    'execution-identity-skill-mismatch__hint':
      '$t(tasks.failure.execution-identity-skill-mismatch__hint)',
    'execution-identity-session-mismatch': '$t(tasks.failure.execution-identity-session-mismatch)',
    'execution-identity-session-mismatch__hint':
      '$t(tasks.failure.execution-identity-session-mismatch__hint)',
    'execution-identity-session-owned': '$t(tasks.failure.execution-identity-session-owned)',
    'execution-identity-session-owned__hint':
      '$t(tasks.failure.execution-identity-session-owned__hint)',
    'execution-identity-control-failed': '$t(tasks.failure.execution-identity-control-failed)',
    'execution-identity-control-failed__hint':
      '$t(tasks.failure.execution-identity-control-failed__hint)',
    'execution-identity-stream-failed': '$t(tasks.failure.execution-identity-stream-failed)',
    'execution-identity-stream-failed__hint':
      '$t(tasks.failure.execution-identity-stream-failed__hint)',
    'execution-identity-timeout': '$t(tasks.failure.execution-identity-timeout)',
    'execution-identity-timeout__hint': '$t(tasks.failure.execution-identity-timeout__hint)',
    'execution-identity-store-unsafe': '$t(tasks.failure.execution-identity-store-unsafe)',
    'execution-identity-store-unsafe__hint':
      '$t(tasks.failure.execution-identity-store-unsafe__hint)',
    'invalid-json': '请求内容不是有效 JSON。',
    'invalid-body': '请求内容不合法。',
    'import-ref-unresolved': '导入内容引用了当前不可用的资源。',
    'import-ref-unresolved__hint': '确认资源仍存在且你仍有访问权后，重新生成导入预览。',
    'import-ref-ambiguous': '导入内容中的资源引用匹配到多个候选。',
    'import-ref-ambiguous__hint': '请为每个歧义引用选择预期的资源所有者。',
    'import-ref-selection-stale': '已选择的导入资源发生了变化。',
    'import-ref-selection-stale__hint': '请检查刷新后的候选，并重新明确选择预期资源。',
    'confirm-required': '不可逆删除需要显式确认。',
    'builtin-readonly': '内置资源只读，不能修改或删除。',
    'not-found': '资源不存在。',
    'resume-failed': '任务恢复失败。',
    'resume-failed__hint': '查看任务详情页的错误信息，必要时用「诊断」检查。',
    'http-400': '请求不合法。',
    'http-401': '未授权 — 请重新登录并粘贴 token。',
    'http-403': '没有权限执行该操作。',
    'http-404': '资源不存在。',
    'http-409': '存在冲突，请刷新后重试。',
    'http-500': '服务内部错误。',
    'http-502': '上游网关错误。',
    'http-503': '服务暂不可用。',
    // --- task ---
    'task-not-found': '任务不存在。',
    'task-not-visible': '该任务不可见（不存在或无权访问）。',
    'task-invalid': '任务输入不合法。',
    'task-filter-invalid': '任务筛选参数不合法。',
    'task-not-cancelable': '该任务已处于终态，无法取消。',
    'task-terminal': '所属任务已结束，本条待办已封存，提交未保存。',
    'task-not-resumable': '该任务还在运行或未失败，无法 resume。',
    'task-still-running': '任务还在运行，请先取消。',
    'task-not-syncable': '任务正在运行，无法同步工作流定义。',
    'task-not-syncable__hint': '等任务结束或取消后再同步。',
    'task-host-sync-unsupported': '代理 / 工作组任务没有可同步的工作流。',
    'task-no-base-commit': '任务缺少基准 commit 记录，无法计算改动。',
    'task-worktree-missing': '任务工作区已不存在（可能已被回收）。',
    'task-upload-failed': '上传文件写入任务工作区失败。',
    'task-launch-cleanup-incomplete': '任务启动失败，且启动现场清理未完成，可能残留工作区目录。',
    'task-launch-cleanup-incomplete__hint': '检查磁盘上对应的任务工作区目录，必要时手动清理。',
    'task-multipart-invalid': '上传表单解析失败。',
    'task-multipart-payload-missing': '上传表单缺少任务参数（payload 字段）。',
    'task-multipart-payload-invalid': '上传表单中的任务参数不是有效 JSON。',
    'task-multipart-string-not-file': '上传表单里的文件字段收到的不是文件。',
    'task-multipart-unknown-field': '上传表单包含未知字段。',
    'task-multipart-unknown-input': '上传文件指向了工作流中不存在的上传输入。',
    // --- task question board ---
    'task-question-not-found': '问题不存在。',
    'task-question-terminal': '该问题已结束，无法改派。',
    'task-question-already-dispatched': '该问题已下发，不能再改指派。',
    'task-question-already-dispatched__hint': '如需换人处理，先「重新打开」再指派。',
    'task-question-not-awaiting-confirm': '该问题不在待确认状态。',
    'task-question-not-sealed': '还有问题未封存答案，无法下发。',
    'task-question-not-sealed__hint': '先把每个待下发问题的答案封存。',
    'task-question-reassign-invalid': '该问题不能改派到所选节点。',
    'task-question-round-missing': '该问题所属的反问轮已不存在，无法改派。',
    'task-question-round-multi-target': '同一轮反问的问题被指派到了多个节点，无法一起下发。',
    'task-question-target-changed': '筹划下发期间该问题被改派了，请刷新后重试。',
    'task-question-snapshot-unparseable': '任务的工作流快照损坏，无法计算下发目标。',
    'task-question-designer-not-ready': '目标节点还有未完成的反问，暂时无法下发。',
    'task-question-node-dispatch-in-flight': '目标节点有未完成的重跑义务，暂时无法下发。',
    'task-question-borrow-ledger-conflict': '该节点存在多条未完成的改派记录，暂时无法下发。',
    'task-question-home-multi-borrow': '该节点已有问题被改派到不同处理者，存在冲突。',
    'task-question-unsafe-dispatch-target': '目标节点没有可继承的运行记录，无法安全下发。',
    'manual-question-title-required': '问题标题必填。',
    'manual-question-title-too-long': '问题标题超出长度上限。',
    'manual-question-body-required': '问题正文必填。',
    'manual-question-body-too-long': '问题正文超出长度上限。',
    'manual-question-target-required': '人工问题必须指定一个代理节点。',
    'manual-question-target-invalid': '指派目标不是本任务工作流中的代理节点。',
    'manual-question-target-never-run': '该节点还没有任何运行记录，无法指派人工问题。',
    'manual-question-target-never-run__hint': '等该节点跑过一次后再指派，或改选已运行过的节点。',
    'manual-question-workgroup-member-target': '不能指派到工作组共享的成员宿主节点。',
    'entry-ids-required': '需要选择至少一个问题。',
    'target-node-required': '需要指定目标节点。',
    // --- clarify ---
    'clarify-session-not-found': '反问会话不存在。',
    'cross-clarify-session-not-found': '跨节点反问会话不存在。',
    'clarify-round-not-found': '反问轮不存在。',
    'clarify-round-terminal': '本轮反问已封存（所属任务已结束或反问已撤销），答案未保存。',
    'clarify-round-not-awaiting': '这轮反问不在等待人工作答状态，草稿未保存。',
    'clarify-already-answered': '这轮反问已被最终提交过，不能再作答。',
    'clarify-question-not-found': '该问题不在这轮反问里。',
    'clarify-question-already-sealed': '该问题已封存，不能重复封存。',
    'clarify-seal-empty': '所选内容没有可封存的答案。',
    'clarify-iteration-mismatch': '这轮反问在你编辑期间发生了变化，请刷新后重试。',
    'clarify-answers-invalid': '答案提交内容不合法。',
    'clarify-answers-not-array': '答案必须按列表提交。',
    'clarify-answer-malformed': '某条答案格式不合法。',
    'clarify-draft-invalid': '草稿内容不合法。',
    'clarify-directive-invalid': '反问指令参数不合法。',
    'clarify-list-query-invalid': '反问列表查询参数不合法。',
    'clarify-question-ids-requires-defer': '按题提交只在暂缓下发模式下可用。',
    'clarify-resubmit-requires-defer': '重新作答只能在集中作答面板（暂缓下发模式）里发起。',
    'clarify-quick-finalize-incomplete': '快速提交没有覆盖全部问题，已拒绝自动下发。',
    'clarify-quick-finalize-incomplete__hint': '补齐剩余问题的答案后再提交。',
    'not-asking-node': '该节点不是本任务中的反问节点。',
    // --- review ---
    'review-not-found': '评审不存在。',
    'review-versions-empty': '该评审还没有任何文档版本。',
    'review-not-awaiting': '该评审没有待处理的文档版本。',
    'review-doc-version-missing': '当前没有待评审的文档版本。',
    'review-doc-decided': '该文档已有评审结论，不能重复决定。',
    'review-not-multi-doc': '该文档不是多文档评审项。',
    'review-selection-incomplete': '还有文档未给出结论，不能通过。',
    'review-selection-incomplete__hint': '给每份文档选择通过或驳回后再提交。',
    'review-selection-invalid': '文档选择内容不合法。',
    'review-iteration-mismatch': '评审在你操作期间更新了，请刷新后重试。',
    'review-decision-invalid': '评审决定内容不合法。',
    'review-comment-invalid': '评论内容不合法。',
    'review-comment-not-found': '评论不存在。',
    'review-list-query-invalid': '评审列表查询参数不合法。',
    'review-node-missing-from-snapshot': '评审节点不在任务的工作流快照里。',
    'doc-version-not-found': '文档版本不存在。',
    'review-version-not-found': '文档版本不存在。',
    'doc-version-body-missing': '该文档版本的正文文件缺失。',
    'anchor-empty-selection': '引用的原文片段不能为空。',
    'anchor-selection-not-found': '引用的原文片段在文档里找不到（文档可能已更新）。',
    // --- workflow ---
    'workflow-not-found': '工作流不存在。',
    'workflow-not-visible': '该工作流不可见（不存在或无权访问）。',
    'workflow-deleted': '该工作流已被删除。',
    'workflow-invalid': '工作流内容不合法。',
    'workflow-name-invalid': '工作流名称须以小写字母 / 数字开头，只允许 [a-z0-9_-]，长度 ≤ 128。',
    'workflow-version-conflict': '工作流已被他人更新，请刷新后重试。',
    'workflow-version-mismatch': '发起期间工作流发生了变化，请刷新后重新发起。',
    'workflow-in-use': '仍有任务引用该工作流，无法删除。',
    'workflow-in-use__hint': '先删除引用它的任务。',
    'workflow-scheduled-referenced': '该工作流仍被定时任务引用，请先删除或改指向这些定时任务。',
    'workflow-definition-corrupt': '存储的工作流定义已损坏。',
    'workflow-snapshot-corrupt': '任务的工作流快照已损坏。',
    'workflow-sync-noop': '任务已经在最新的工作流定义上，无需同步。',
    'workflow-sync-preview-stale': '预览之后工作流又更新了，请刷新预览后再确认。',
    'workflow-export-invalid': '导出参数不合法。',
    'workflow-validation-invalid': '校验请求参数不合法。',
    'workflow-import-invalid': '导入内容不合法。',
    'workflow-import-conflict': '导入冲突：已存在同 id 的工作流。',
    'workflow-import-target-mismatch': 'YAML 里的工作流 id 与确认覆盖的目标不一致。',
    'workflow-yaml-empty': 'YAML 内容为空。',
    'workflow-yaml-invalid': 'YAML 无法解析为工作流对象。',
    'dw-no-generated-workflow': '该任务没有可保存的生成工作流。',
    'dw-generated-def-invalid': '生成的工作流已不可读取，请驳回并给出反馈让其重新生成。',
    'dw-generated-def-stale': '生成的工作流与当前代理池不再匹配，请驳回并给出反馈让其重新生成。',
    // --- upload ---
    'upload-unknown-input': '上传指向了未声明的输入。',
    'upload-input-invalid': '工作流的上传输入定义有误。',
    'upload-file-too-large': '单个文件超出该输入的大小上限。',
    'upload-too-large': '本次上传总大小超出限制。',
    'upload-too-many-files': '本次上传文件数超出限制。',
    'upload-max-count': '文件数量超出该输入允许的上限。',
    'upload-min-count': '文件数量不足该输入要求的下限。',
    'upload-mime-rejected': '文件类型不在该输入允许的范围内。',
    'upload-name-clash': '重名文件过多，无法生成不冲突的文件名。',
    'upload-path-escape': '上传路径越界，已拒绝。',
    'upload-target-absolute': '目标目录必须是仓库内的相对路径。',
    'upload-target-escape': '目标目录越出任务工作区，已拒绝。',
    // --- schedule ---
    'scheduled-task-not-found': '定时任务不存在。',
    'scheduled-task-invalid': '定时任务内容不合法。',
    'scheduled-task-forbidden': '没有权限修改该定时任务。',
    'scheduled-kind-immutable': '定时任务的发起类型创建后不可修改。',
    'scheduled-kind-immutable__hint': '删除后按新类型重建。',
    'scheduled-task-needs-repair': '该定时任务的启动参数已不可读取，需要提交完整参数修复。',
    'schedule-payload-invalid': '该定时任务保存的启动参数已损坏，无法立即运行。',
    'schedule-payload-invalid__hint': '编辑并重新保存完整启动参数后再试。',
    'schedule-kind-invalid': '该定时任务保存的发起类型已损坏，无法运行。',
    'schedule-kind-invalid__hint': '删除该定时任务，并按正确的发起类型重新创建。',
    'schedule-spec-invalid': '该定时任务保存的执行时间规则无效。',
    'schedule-spec-invalid__hint': '编辑执行频率与时区并重新保存。',
    'scheduled-task-row-corrupt': '定时任务数据已损坏。',
    'scheduled-task-upload-required': '该工作流要求上传文件，定时任务无法提供，无法定时发起。',
    // --- runtime ---
    'runtime-not-found': '运行时不存在。',
    'runtime-exists': '同名运行时已存在。',
    'runtime-name-invalid': '运行时名称须为小写 URL 安全字符。',
    'runtime-protocol-invalid': '协议类型不受支持。',
    'runtime-binary-invalid': '二进制路径必须是单个路径。',
    'runtime-temperature-invalid': 'temperature 必须在 0–2 之间。',
    'runtime-config-dir-env-invalid': '配置目录环境变量名不合法。',
    'runtime-config-dir-env-reserved': '配置目录环境变量与平台保留变量冲突。',
    'runtime-config-dir-name-invalid': '配置目录名必须是单层目录名。',
    'runtime-default-cannot-disable': '该运行时是当前默认，先改默认再停用。',
    'runtime-disabled': '不能把已停用的运行时设为默认，请先启用。',
    'runtime-in-use': '仍有代理在使用该运行时，无法删除。',
    'runtime-in-use__hint': '先把这些代理改到其它运行时。',
    'runtime-last': '这是最后一个运行时，不能删除。',
    'opencode-models-failed': '拉取模型列表失败。',
    'opencode-models-failed__hint': '检查运行时是否可用、代理 / 网络是否可达后重试。',
    // --- mcp ---
    'mcp-not-found': 'MCP 不存在。',
    'mcp-invalid': 'MCP 内容不合法。',
    'mcp-config-invalid': 'MCP 配置不合法。',
    'mcp-name-in-use': '同名 MCP 已存在。',
    'mcp-type-immutable': 'MCP 的类型创建后不可修改。',
    'mcp-disabled': '该 MCP 已停用，先启用再探测。',
    'mcp-probe-invalid': '探测请求缺少配置校验参数，请刷新后重试。',
    'mcp-rename-invalid': '重命名参数不合法。',
    'mcp-row-corrupt': '该 MCP 数据已损坏。',
    'mcp-still-referenced': '仍有代理引用该 MCP，无法删除。',
    'mcp-still-referenced__hint': '先在引用它的代理里解绑。',
    'probe-not-found': '该 MCP 还没有探测结果，请先探测。',
    'resource-operation-stale': '资源已变化，请刷新后再探测。',
    'resource-operation-superseded': '已有更新的探测完成，本次结果被丢弃。',
    // --- plugin ---
    'plugin-not-found': '插件不存在。',
    'plugin-invalid': '插件内容不合法。',
    'plugin-name-in-use': '同名插件已存在。',
    'plugin-disabled': '代理引用了已停用的插件。',
    'plugin-disabled__hint': '启用对应插件，或从代理里移除引用。',
    'plugin-file-not-found': '插件文件不存在。',
    'plugin-install-failed': '插件安装失败。',
    'plugin-install-timeout': '插件安装超时。',
    'plugin-operation-invalid': '操作缺少配置校验参数，请刷新后重试。',
    'plugin-operation-unsupported': '外部纳管的文件插件不支持检查 / 升级。',
    'plugin-rename-invalid': '重命名参数不合法。',
    'plugin-row-corrupt': '该插件数据已损坏。',
    'plugin-still-referenced': '仍有代理引用该插件，无法删除。',
    'plugin-still-referenced__hint': '先在引用它的代理里解绑。',
    'npm-unavailable': 'npm 不可用，无法安装插件。',
    'npm-unavailable__hint': '确认服务器上已安装 npm、网络可达后重试。',
    // --- agent ---
    'agent-not-found': '代理不存在。',
    'agent-invalid': '代理内容不合法。',
    'agent-import-invalid': '代理导入内容不合法。',
    'agent-name-in-use': '同名代理已存在。',
    'agent-rename-invalid': '重命名参数不合法。',
    'agent-launch-invalid': '发起参数不合法。',
    'agent-launching': '该代理正有任务在发起中，请稍后重试。',
    'agent-id-mismatch': '目标代理已被替换，请刷新后重试。',
    'agent-in-use': '仍有工作流引用该代理，无法删除。',
    'agent-in-use__hint': '先在引用它的工作流里换掉该代理。',
    'agent-scheduled-referenced': '该代理仍被定时任务引用，请先删除或改指向这些定时任务。',
    'agent-tasks-active': '该代理还有未结束的任务，等它们结束或取消后再删除。',
    'agent-dependency-self': '代理不能依赖自己。',
    'agent-dependency-cycle': '代理依赖出现了环。',
    'agent-dependency-not-found': '依赖的代理不存在。',
    'agent-dependency-still-referenced': '该代理仍被其它代理依赖，无法删除。',
    'agent-dependency-still-referenced__hint': '先在依赖它的代理里移除依赖。',
    // --- skill ---
    'skill-not-found': '技能不存在。',
    'skill-invalid': '技能内容不合法。',
    'skill-name-in-use': '同名技能已存在。',
    'skill-in-use': '仍有代理引用该技能，无法删除。',
    'skill-in-use__hint': '先在引用它的代理里解绑。',
    'skill-changed': '技能内容已被他人修改，请刷新后重试。',
    'skill-version-conflict': '技能在操作期间被修改，请刷新后重试。',
    'skill-token-invalid': '页面状态已过期，请刷新后重试。',
    'skill-content-invalid': '保存内容不合法。',
    'skill-file-invalid': '文件写入内容不合法。',
    'skill-file-not-found': '文件不存在于该技能中。',
    'skill-file-is-dir': '目标路径是目录，不是文件。',
    'skill-md-missing': '缺少 SKILL.md。',
    'skill-md-protected': 'SKILL.md 不能直接写入或删除，请走技能保存流程。',
    'skill-not-managed': '该技能不是纳管技能，没有版本管理。',
    'skill-version-invalid': '版本号必须是正整数。',
    'skill-version-not-found': '该技能没有这个版本。',
    'skill-restore-invalid': '恢复参数不合法。',
    'skill-operation-busy': '该技能正被另一个操作占用，请稍后重试。',
    'skill-operation-inactive': '该操作已失效或不存在。',
    'skill-endpoint-gone': '该保存接口已下线，请刷新页面使用新版保存。',
    'skill-quarantined': '该技能本次启动未通过校验，暂不可用。',
    'skill-quarantined__hint': '在技能页检查其状态并修复后重启 daemon。',
    'zip-file-missing': '缺少 zip 文件。',
    'zip-limit-exceeded': 'zip 文件超出大小限制。',
    'zip-decode-failed': 'zip 解压失败。',
    'zip-traversal': 'zip 内含非法路径，已拒绝。',
    'zip-multipart-invalid': '上传表单解析失败。',
    'zip-decisions-missing': '缺少导入决策。',
    'zip-decisions-invalid': '导入决策不是有效 JSON。',
    // --- workgroup（RFC-164 room / delivery / confirm-gate / config） ---
    'workgroup-task-terminal': '任务已结束，无法再发送消息。',
    'workgroup-assignment-not-cancelable': '该派单已开始执行或已结束，无法取消。',
    'workgroup-delivery-invalid': '交付内容无效：正文或结论摘要必填其一。',
    'workgroup-delivery-not-human': '只有人类成员的派单可以交付。',
    'workgroup-delivery-conflict': '该派单不在待交付状态，可能已被交付或取消。',
    'workgroup-confirm-invalid': '确认参数无效：驳回必须填写意见。',
    'workgroup-gate-not-open': '完成门当前未开启，无法确认或驳回。',
    'workgroup-config-invalid': '配置调整参数无效。',
    'workgroup-config-leader-immutable': 'Leader 成员不可移除。',
    'workgroup-config-no-agents': '移除后将没有任何 agent 成员，无法保存。',
    'workgroup-config-duplicate-member': '成员显示名与现有成员重复。',
    'workgroup-config-agent-missing': '要加入的 agent 已不存在。',
    'workgroup-config-conflict': '成员列表刚刚被其他操作修改，本次保存未生效。',
    'workgroup-config-conflict__hint': '刷新房间后重新调整成员。',
    'workgroup-member-running': '该成员仍在执行派单，暂时不能移除。',
    'workgroup-config-empty': '没有任何改动可保存。',
    // --- repo / git / worktree（用户可触发子集，其余走域兜底） ---
    'repo-url-invalid': '仓库地址不受支持或格式错误。',
    'repo-clone-failed': 'git clone 失败。',
    'repo-clone-failed__hint': '检查仓库地址、凭据与网络后重试。',
    'repo-fetch-failed': '仓库同步失败；为避免使用陈旧代码，本次任务未启动。',
    'repo-fetch-failed__hint': '检查仓库凭据与网络，确认可以 fetch 后重试。',
    'repo-refresh-failed': '仓库刷新失败，上次成功同步时间保持不变。',
    'repo-refresh-failed__hint': '检查仓库凭据与网络后重试。',
    'repo-ref-not-found': '在仓库里找不到指定的分支 / 引用。',
    'repo-file-source-unreachable': '本地 file:// 仓库源不存在或不可读。',
    'repo-not-git': '该路径不是 git 仓库。',
    'repo-path-missing': '路径不存在。',
    'repo-path-unknown': '该路径不是已知的缓存仓库。',
    'repo-cache-corrupt': '仓库缓存目录损坏。',
    'repo-cache-corrupt__hint': '删除该缓存仓库后重新发起任务以重新克隆。',
    'repo-cache-locked': '仓库缓存正被其它操作占用，等待超时。',
    'batch-empty': '没有可导入的仓库地址。',
    'batch-too-large': '批量导入数量超出上限。',
    'batch-not-found': '批量导入会话不存在或已过期。',
    'row-not-found': '该导入行不存在。',
    'row-not-retryable': '该导入行不在可重试状态。',
    'cached-repo-not-found': '缓存仓库不存在。',
    'path-empty': '路径必填。',
    'path-absolute': '路径必须是相对路径。',
    'path-backslash': '路径不能包含反斜杠。',
    'path-traversal': '路径越界，已拒绝。',
    'worktree-missing': '任务工作区已不存在（可能已被回收）。',
    'worktree-base-invalid': '基准分支 / 引用无法解析。',
    'worktree-file-not-found': '工作区里没有该文件。',
    'worktree-file-invalid-encoding': '文件路径的 URL 编码无效。',
    'worktree-dir-not-found': '工作区里没有该目录。',
    'snapshot-lost': '节点的改动快照已丢失，无法恢复 / 重试。',
    'snapshot-missing': '改动快照已被回收，操作未执行。',
    'working-branch-invalid': '工作分支名不合法。',
    'working-branch-in-use': '该工作分支已被其它工作区占用。',
    'working-branch-concurrent-update': '工作分支在准备期间被并发更新，请重试。',
    'working-branch-base-merge-conflict': '把基准分支合入工作分支时发生冲突。',
    'working-branch-base-merge-conflict__hint': '在仓库里手动解决冲突，或换一个工作分支。',
    // --- auth / 账号（登录 / 权限 / 改密子集 + OIDC wire 码） ---
    'auth-required': '需要登录后才能访问。',
    'auth-required__hint': '重新登录后重试。',
    unauthorized: '登录状态无效或已过期。',
    unauthorized__hint: '重新登录后重试。',
    forbidden: '没有执行该操作的权限。',
    'admin-required': '该操作需要管理员权限。',
    'not-task-member': '只有任务成员或管理员可以执行该操作。',
    'acl-invalid': '授权参数不合法。',
    'acl-missing-refs': '你没有其中部分引用资源的访问权限。',
    'acl-revision-conflict': '授权配置已被他人更新，请刷新后重试。',
    'acl-resource-mismatch': '资源已变化，请刷新后重试。',
    'invalid-collaborator': '所选协作者不是有效的活跃用户。',
    'login-invalid': '登录参数不合法。',
    'session-not-found': '会话不存在或已退出。',
    'user-not-found': '用户不存在。',
    'username-taken': '用户名已被占用。',
    'old-password-required': '需要填写旧密码。',
    'old-password-mismatch': '旧密码不正确。',
    'change-password-invalid': '修改密码参数不合法。',
    'self-disable-forbidden': '不能停用自己的账号。',
    'self-role-change-forbidden': '不能修改自己的角色。',
    'last-admin-protection': '不能停用最后一名管理员。',
    'oidc-not-configured': '尚未配置 OIDC 登录。',
    'oidc-provider-not-found': '登录提供方不存在。',
    'oidc-provider-invalid': '登录提供方配置不合法。',
    'oidc-slug-taken': '该提供方标识已被占用。',
    'oidc-discovery-incomplete': '提供方发现信息不完整，无法完成登录。',
    // --- launch / ports / 杂项 ---
    'start-task-source-required': '发起任务需要一个仓库来源。',
    'start-task-path-retired': '旧的本地路径发起方式已下线，请改用仓库地址（本地仓库用 file://）。',
    'assignments-removed': '按节点指派已下线：现在由任务成员回答评审与反问。',
    'port-not-found': '该运行没有这个输出端口。',
    'port-artifact-missing': '该端口产物不可读取（归档缺失且工作区回退失败）。',
    'call-target-method-required': '缺少方法引用参数（methodRef）。',
    'plantuml-source-required': '图表源码为空，无法渲染。',
    'plantuml-source-too-large': '图表源码过大，超出渲染上限。',
    'config-invalid': '配置不合法。',
    fallback: '请求失败',
  },
  clarify: {
    roundSealedByTaskTerminal: '所属任务已结束，本轮反问已封存，无需回答。',
    roundDismissedNoHuman: '工作组里已没有人工成员，本轮反问已撤销，无需回答。',
    taskNameLabel: '所属任务',
    nav: {
      label: '反问澄清',
      badgeTitle: '{{count}} 条待回答的反问',
    },
    list: {
      title: '反问',
      filter: { awaiting: '待回答', answered: '已回答', all: '全部' },
      empty: '当前没有待回答的反问',
      emptyDescription: '代理需要人工补充信息时，问题会出现在这里并等待你的回答。',
      colTask: '任务',
      colAgent: '反问发起方',
      colNode: '节点',
      colIteration: '轮次',
      colQuestions: '问题数',
      colTime: '创建时间',
      openButton: '打开',
      statusAwaiting: '待回答',
      statusAnswered: '已回答',
      // flag-audit W0：self 轮存在 'canceled'（任务取消路径），此前落进
      // 「已回答」分支显示绿色。
      statusCanceled: '已取消',
      // RFC-056: 列表项 chip 区分两种反问通道。
      chip: { self: '自反问', cross: '跨 agent 反问' },
    },
    detail: {
      contextCard: '由 agent {{name}} 发起 · 第 {{n}} 轮反问',
      contextCardShard: 'Shard: {{shard}}',
      truncationWarning: 'Agent 提了 {{got}} 题，已截到前 {{kept}} 题',
      shardSwitcherLabel: 'Shard 切换',
      shardSwitcherEmpty: '当前 shard 没有待回答的反问。',
      historyTitle: '历史轮次',
      historyEmpty: '没有历史反问。',
      submitContinue: '提交并继续反问',
      submitStop: '提交并停止反问',
      stopModal: {
        title: '确认停止本节点反问？',
        body: '提交后本节点在当前迭代不会再向你发起反问。如需继续提问可点击"提交并继续反问"。',
        confirm: '确认停止',
        cancel: '取消',
      },
      submitDisabledRequired: '请先回答所有"推荐"题',
      draftSaving: '正在保存草稿…',
      draftSaved: '草稿已保存（关 tab 不丢）',
      roundSealedFooter: '本轮已封存，无需回答。',
      recommendedChip: '推荐',
      back: '← 返回列表',
      answeredAt: '已回答 · {{time}}',
      askedAt: '提问于 {{time}}',
      keyboardHint: '快捷键：数字键 1–N 选择选项 · Enter 跳下一题 / 提交',
      lockedNote: '该问题已在「集中回答」处理，此处只读、提交时不再重复下发。',
    },
    question: {
      single: { customLabel: '其他（自定义）' },
      multi: {
        customLabel: '也包含以下补充',
        customPlaceholder: '在此填写补充内容…',
      },
      custom: { lengthHint: '{{count}} / {{max}}' },
    },
    option: {
      recommendedBadge: '推荐',
      reasonLabel: '推荐理由',
    },
    canvas: {
      error: {
        multiNotSupported: 'v1 暂不支持 agent-multi 节点连入反问节点',
        duplicate: '该 agent 已挂接另一个反问节点',
      },
    },
    ws: {
      toast: { othersSubmitted: '另一处已提交答案，本页已切换为只读' },
    },
    inspector: {
      title: '反问节点配置',
      linkedAgentMissing: '未挂接到任何 agent',
      inLoop: '在 wrapper-loop 内',
      notInLoop: '未在 wrapper-loop 内',
    },
    task: { statusLabel: '等待用户回答' },
    error: { unknown: '加载反问详情失败' },
    eventStream: {
      sessionResumed: '已复用 opencode session {{prefix}}（第 {{n}} 轮反问）',
      fallbackToIsolated: '本轮 inline session 不可用（原因：{{reason}}），自动回退为独立 session',
    },
    node: { chip: { inline: 'session=inline' } },
  },
  // RFC-056 跨 agent 反问 — 仅特有于 cross-clarify 路径的文案。
  // 复用：RFC-023 的列表 / 详情头 / QuestionForm / 草稿状态条。
  // cross-clarify 表单与 RFC-023 共用 /clarify/$nodeRunId 路由，仅 footer
  // 与多源等待 banner 不一样。
  crossClarify: {
    contextCard: '由反问 agent {{name}} 发起 · 第 {{n}} 轮',
    targetDesigner: '反馈对象：{{name}}',
    rejectModal: {
      title: '确认拒绝反问？',
      body: '反问 agent 将不再在本 task 上对该节点产生问题——跨 loop 迭代也持久生效。该决策不可撤销，如需重提请重启 task。',
      confirm: '确认拒绝',
    },
    multiSourceBanner: '已提交。等待另外 {{remaining}} 个反问节点处理完，designer 才会重跑。',
    multiSourcePendingLinkLabel: '打开',
    abandonedChip: '反馈未送达 (abandoned)',
    abandonedTooltip: 'designer 任务在反馈被消费前已失败。需重启任务才能重试。',
    inspector: {
      title: '跨 agent 反问节点',
      sessionModeForQuestioner: 'questioner 重跑 session',
      sessionModeIsolated: '独立（每轮新进程）',
      sessionModeInline: '续接（resume）',
      sessionModeHint:
        '续接模式让重跑复用上一轮 opencode session；auth/session 失败时自动回退为独立模式。',
      fieldLinkedQuestioner: '已挂接的反问者 (questioner)',
      linkedQuestionerMissing:
        '尚未挂接 questioner — 从本节点左侧 input 端往下游反问 agent 拖一条线。',
      linkedQuestionerHint: '反问的发起方；同一个 questioner agent 只允许挂一个跨反问节点。',
      fieldLinkedDesigner: '已挂接的设计者 (designer)',
      linkedDesignerMissing:
        '尚未挂接 designer — 从本节点 to_designer 端往上游 designer agent 拖一条线，否则提交后没有重跑对象。',
      linkedDesignerHint: '收到反馈后重跑的上游 agent；通常是 questioner 的拓扑上游。',
      fieldInLoop: 'wrapper-loop 包裹',
      inLoopYes: '✔ 在 loop 内，可累计多轮反问。',
      inLoopNo: '⚠ 未在 wrapper-loop 内 — 反问轮数不会被限制，建议套一层 loop。',
    },
    canvas: {
      paletteLabel: '跨代理反问',
      paletteHint: '拖到下游反问 agent 上自动建反问通道；再手动连 to_designer → 上游 designer。',
      handleLabel: {
        toQuestioner: '→ 反问者',
        toDesigner: '→ 设计者',
      },
      error: {
        targetNotAgentSingle: '跨 agent 反问节点的输入端只能连 agent-single（v1 限制）。',
        designerNotAgentSingle: 'to_designer 必须连到 agent-single 节点。',
      },
    },
  },
  sidebar: {
    languageGroupLabel: '切换界面语言',
    lang: {
      zh: '中',
      en: 'EN',
    },
  },
  // RFC-027: NodeDetailDrawer Session tab content.
  session: {
    user: '用户',
    assistant: '助手',
    thinking: '思考',
    thinkingCount: '思考 · {{n}} 字',
    toolCall: '工具调用',
    toolResult: '工具返回',
    subagent: '子代理',
    captureMissing: '未能捕获子代理事件。',
    fallbackOutput: '父代理收到的最终回复：',
    expand: '展开',
    collapse: '折叠',
    statusPending: '排队中',
    statusRunning: '运行中',
    statusCompleted: '已完成',
    statusError: '出错',
    loadError: '加载会话失败。',
    empty: '本轮 session 暂无事件。',
    toolInput: '输入',
  },
  memory: {
    title: '平台长期记忆',
    adminOnly: '仅管理员可审批',
    empty: '暂无沉淀',
    sectionNavLabel: '记忆分区',
    sectionGroups: {
      pending: '待处理',
      library: '记忆库',
      automation: '自动化',
    },
    sectionDescriptions: {
      approvalQueue: '审核你有权管理的候选记忆，决定是否进入长期记忆库。',
      fusion: '检查把多条记忆融合进技能后的变更。',
      all: '浏览已批准与已归档的记忆，并管理可写条目。',
      byScope: '按 Agent、工作流、仓库与全局范围查找已批准记忆。',
      distillJobs: '查看自动提炼任务的运行状态并处理失败任务。',
    },
    sectionUnavailable: '你没有访问该自动化分区的权限，已返回记忆库。',
    loadingEdit: '正在加载记忆详情…',
    emptyStates: {
      candidates: '没有需要你处理的候选记忆',
      candidatesDescription: '任务反馈经提炼或手工新建后，可管理的候选会出现在这里。',
      approved: '记忆库中还没有已批准记忆',
      approvedDescription: '先在候选记忆中批准一条，后续任务即可按作用域使用它。',
      archived: '没有已归档记忆',
      archivedDescription: '从已批准视图归档的条目会保留在这里，并可随时恢复。',
      scope: '此作用域暂无记忆',
      scopeDescription: '批准候选后，记忆会按其 Agent、工作流、仓库或全局作用域归类。',
    },
    confirmDelete: '永久删除这条记忆？不可恢复。',
    confirmArchive: '确认归档这条记忆？归档后将不再注入未来运行，可在"已归档"视图中恢复。',
    archiveDialogTitle: '归档记忆',
    deleteDialogTitle: '删除记忆',
    dialogCancel: '取消',
    dialogConfirm: '确认',
    tab: {
      approvalQueue: '审批队列',
      all: '已审批',
      byScope: '按维度',
      distillJobs: '提炼任务',
      fusion: '融合',
    },
    // RFC-121: fusions awaiting approval, surfaced on the Memory page.
    fusion: {
      subtitle: '待审批 · 吸收 {{n}} 条记忆',
      empty: '暂无待审批的融合',
      emptyDescription: '可从已批准记忆或可管理技能发起融合，待你处理的评审会出现在这里。',
      error: '融合列表加载失败',
      retry: '重试',
    },
    action: {
      approve: '批准',
      approveSupersede: '批准并覆盖…',
      reject: '驳回',
      archive: '归档',
      unarchive: '取消归档',
      delete: '删除',
      compare: '对比',
      // RFC-045
      new: '+ 新建记忆',
      edit: '编辑',
      expandBody: '展开全文',
      collapseBody: '收起',
    },
    // RFC-045 — manual create + edit dialog
    newDialogTitle: '新建记忆',
    editDialogTitle: '编辑记忆',
    formCancel: '取消',
    formSave: '保存',
    error: {
      terminalStatus: '该记忆已是终态，不可编辑',
    },
    form: {
      scopeType: '作用域',
      scopeId: '作用域目标',
      scopeIdGlobal: '（global — 无目标）',
      scopeIdPlaceholder: '选择目标…',
      title: '标题',
      bodyMd: '正文（markdown）',
      tags: '标签',
      tagsHint: '回车或逗号添加，最多 16 个',
      tagsFull: '已达上限',
      tagInputPlaceholder: '添加标签…',
      tagRemoveAria: '移除标签 {{tag}}',
      errTitleEmpty: '标题不能为空',
      errTitleTooLong: '标题不能超过 {{max}} 字符',
      errBodyEmpty: '正文不能为空',
      errBodyTooLong: '正文不能超过 {{max}} 字符',
      errScopeIdRequired: '请选择作用域目标',
      errTagsTooMany: '标签数量超出上限 ({{max}})',
      errTagTooLong: '单个标签不能超过 {{max}} 字符',
    },
    candidate: {
      from: '来自 {{kind}} {{id}}',
      pendingCount: '共 {{count}} 条待审批',
      source: {
        clarify: '反问',
        review: '评审',
        feedback: '反馈',
        manual: '手工',
      },
    },
    candidateRow: {
      lang: {
        'zh-CN': '中',
        'en-US': 'EN',
      },
      langTooltip: {
        'zh-CN': '由 distiller 以简体中文产出（RFC-050）',
        'en-US': 'Generated by distiller in English (RFC-050)',
      },
    },
    distillAction: {
      new: '新增',
      updateOf: '更新自 {{id}}',
      duplicateOf: '重复于 {{id}}',
      conflictWith: '与 {{id}} 冲突',
    },
    scope: {
      agent: 'Agent',
      workflow: '工作流',
      repo: '仓库',
      global: '全局',
    },
    scopeRow: {
      agentCount: '代理 · {{n}}',
      workflowPrefix: '工作流 · ',
      repoPrefix: '仓库 · ',
      global: '全局',
    },
    status: {
      candidate: '候选',
      approved: '已批准',
      archived: '已归档',
      superseded: '已覆盖',
      rejected: '已驳回',
      fused: '已融合',
    },
    conflictDialog: {
      title: '与已有记忆冲突 — 并排对比',
      existing: '已有记忆',
      candidate: '候选记忆',
      close: '关闭',
      tagsLabel: '标签',
    },
    distillJobs: {
      empty: '当前没有提炼任务',
      emptyDescription: '反馈与评审事件会自动创建提炼任务，新的运行将在这里提供监控。',
      colId: '任务 ID',
      colStatus: '状态',
      colSource: '来源',
      colAttempts: '尝试次数',
      colCreated: '创建时间',
      colError: '错误',
      status: {
        pending: '等待',
        running: '运行中',
        done: '完成',
        failed: '失败',
        canceled: '已取消',
      },
      action: {
        retry: '重试',
        cancel: '取消',
      },
    },
    sourceKind: {
      clarify: '反问',
      review: '评审',
      feedback: '反馈',
      manual: '手工',
    },
    distillJobDetail: {
      adminOnly: '提炼详情仅 admin 可见',
      attempt: '第 {{n}} 次',
      attemptsCount: '尝试次数：{{n}}',
      attemptPickerLabel: '选择尝试：',
      candidateStatus: '当前状态：{{status}}',
      captureFailed: '对话捕获失败；仅可看 raw 输出',
      dedupSnapshotLabel: '本次提炼时可见的已批准记忆',
      loadError: '加载提炼任务详情失败',
      noCandidates: '本次未生成候选',
      noConversation: '运行完成后才会出现对话',
      noDedupSnapshot: '本次提炼时无可见的已批准记忆',
      noSourceEvents: '没有可解析的源事件',
      openInQueue: '在审批队列中打开',
      outputLangLabel: '输出语言',
      outputLang: {
        default: '默认（English）',
        'zh-CN': '简体中文',
        'en-US': 'English',
      },
      section: {
        candidates: '本次生成的候选记忆',
        conversation: '提炼器对话',
        scope: '范围与去重快照',
        sourceEvents: '源事件',
      },
      sessionLoadError: '加载对话失败',
      sourceDeleted: '源已删除',
      stderrLabel: '子进程 stderr（截断）',
      exitCodeLabel: '退出码',
      stderrClipped: '\n…(显示时截断至 {{n}} 字符)',
    },
  },
  taskFeedback: {
    title: '任务留言',
    hint: '给本工作流将来运行的我们留一句话。可能被提炼成长期记忆。',
    placeholder: '给本工作流未来运行的我们留一句话…',
    submit: '保存留言',
    submitting: '保存中…',
    empty: '暂无留言',
    distilled: '已交付提炼',
    rateLimit: '请稍候，3 秒内只能提交一次。',
    secretHint: '不要写入密钥；管理员与未来任务运行均可见。',
    submitError: '提交失败',
    loadError: '加载留言失败',
    submittedJustNow: '刚刚',
  },
  detail: {
    memories: '记忆',
  },
  diagnose: {
    repair: {
      R1: {
        approveRun: {
          label: '把 review node_run 标为 done',
          desc: 'doc 已审核通过但 node_run 卡在 awaiting_review。将 node_run 推进到 done，让调度器继续。',
        },
        unapproveDoc: {
          label: '撤销该 doc_version 审批',
          desc: 'doc 不应已批准——把 doc_version.decision 退回 pending，重新走审核流程。',
        },
        markTaskFailed: {
          label: '把任务标为失败',
          desc: '该任务已无法恢复，把它直接标为 failed 让用户重新启动新任务。',
        },
        unavailable: {
          detailDrift: '告警的 detail 字段已与现状不匹配，请重新扫描后再操作。',
          docNotApproved: '关联的 doc_version 已不在 approved 状态，无须再修。',
          runAlreadyDone: 'node_run 已经是 done，无须再推进。',
          taskTerminal: '任务已是终态，无须再标为 failed。',
        },
      },
      R2: {
        demoteRunToAwaiting: {
          label: '把 done 的 review node_run 退回 awaiting_review',
          desc: 'node_run 已 done 但没有 approved doc。退回 awaiting_review 让用户重新决策。',
        },
        markTaskFailed: {
          label: '把任务标为失败',
          desc: '无法补 doc 时直接放弃任务。',
        },
        unavailable: {
          detailDrift: '告警 detail 与现状已不一致，请先重新扫描。',
          runNotDone: '关联 node_run 已不在 done 状态。',
          taskTerminal: '任务已是终态。',
        },
      },
      C1: {
        resumeRun: {
          label: '把 clarify node_run 推进到 done',
          desc: 'session 已关闭但 run 卡在 awaiting_human。推进 run 并让调度器接管。',
        },
        reopenSession: {
          label: '重新打开 clarify_session',
          desc: 'run 仍需用户回答，重新打开 session 让用户继续作答。',
        },
        unavailable: {
          detailDrift: '告警 detail 与现状已不一致。',
          runNotAwaitingHuman: 'node_run 已不在 awaiting_human。',
          sessionNotClosed: 'session 仍在开放，C1 不再适用。',
        },
      },
      T1: {
        demoteTask: {
          label: '把任务退回 running',
          desc: '没有任何 node_run 处于 awaiting_review，任务不该停在 awaiting_review。退回 running 让调度器重新拣选。',
        },
        resurrectReviewRun: {
          label: '把已终止的 review node_run 推回 awaiting_review',
          desc: '存在 review run 已被中断，但仍是当前最佳候选。把它推回 awaiting_review，让用户继续审核。',
          unavailable: {
            noCandidate: '没有找到可以推回的 review node_run 候选。',
          },
        },
        unavailable: {
          taskNotAwaitingReview: '任务已经不在 awaiting_review 状态。',
        },
      },
      T2: {
        demoteTask: {
          label: '把任务退回 running',
          desc: '没有任何 clarify node_run 在 awaiting_human，任务不该停在 awaiting_human。退回 running 让调度器重新拣选。',
        },
        resurrectClarifyRun: {
          label: '把已终止的 clarify node_run 推回 awaiting_human',
          desc: '存在 clarify run 已被中断且仍有开放 session。把它推回 awaiting_human，让用户继续回答。',
          unavailable: {
            noCandidate: '没有找到可以推回的 clarify node_run 候选。',
            noOpenSession: '候选 run 没有对应的开放 clarify_session。',
          },
        },
        unavailable: {
          taskNotAwaitingHuman: '任务已经不在 awaiting_human 状态。',
        },
      },
      T3: {
        demoteTask: {
          label: '把任务退回 running',
          desc: 'output 节点还没有 done 的 node_run，task 不该已 done。退回 running 让调度器把剩余节点跑完。',
        },
        markTaskFailed: {
          label: '把任务标为失败',
          desc: '若 output 节点无法再产出，把任务标为 failed。',
        },
        unavailable: {
          taskNotDone: '任务已经不是 done 状态。',
        },
      },
      U1: {
        cancelOlderKeepNewest: {
          label: '保留最新的活跃 run，取消其余',
          desc: '同一节点上多个活跃 run，保留 startedAt 最新的、把其余 run 标为 canceled。',
        },
        cancelNewerKeepOldest: {
          label: '保留最旧的活跃 run，取消其余',
          desc: '同一节点上多个活跃 run，保留 startedAt 最旧的、把其余 run 标为 canceled。',
        },
        unavailable: {
          detailMissingIds: '告警 detail 缺少 run id 列表，无法精确选择。',
          notMultipleActive: '当前不再存在多个活跃 run。',
        },
      },
      CR1: {
        acknowledge: {
          label: '确认已知悉（不改 DB）',
          desc: '将告警关闭，但不修改任何业务数据。适用于已离线手工处理完毕的场景。',
        },
        retryDesignerRerun: {
          label: '让 designer 重跑',
          desc: '通过把 designer node_run 推回 pending 让调度器重跑该节点。',
        },
        unavailable: {
          taskNotFailed: '任务尚未进入 failed，CR-1 重跑不适用。',
        },
      },
      S1: {
        recreateDocVersion: {
          label: '重新派发 review 节点生成 doc_version',
          desc: '任务卡在 awaiting_review 但找不到 pending doc，重新派发 review 节点生成 doc。',
        },
        demoteTask: {
          label: '把任务退回 running',
          desc: '当 review 节点已无法补 doc 时，把任务退回 running 让用户决定。',
        },
        unavailable: {
          taskNotAwaitingReview: '任务不在 awaiting_review，S1 不再适用。',
        },
      },
      S2: {
        demoteTask: {
          label: '把任务退回 running',
          desc: '当 clarify session 已无法恢复时，把任务退回 running。',
        },
        reopenSession: {
          label: '重新打开 clarify_session',
          desc: '存在已关闭的 clarify_session 仍可继续作答，重新打开它。',
          unavailable: {
            noClosedSession: '没有找到可以重新打开的 closed clarify_session。',
            sessionAlreadyOpen: '已存在开放 session，S2 不再适用。',
            noAwaitingRun: '没有任何 clarify node_run 在 awaiting_human。',
          },
        },
        unavailable: {
          taskNotAwaitingHuman: '任务不在 awaiting_human，S2 不再适用。',
        },
      },
      S3: {
        resurrectReviewRun: {
          label: '把已终止的 review run 推回 awaiting_review',
          desc: '任务在 running 但所有 node_run 已终态。存在 review run 可以推回，让用户继续审核。',
          unavailable: {
            noCandidate: '没有找到合适的 review node_run 候选。',
          },
        },
        resurrectClarifyRun: {
          label: '把已终止的 clarify run 推回 awaiting_human',
          desc: '任务在 running 但所有 node_run 已终态。存在 clarify run 可以推回，让用户继续回答。',
          unavailable: {
            noCandidate: '没有找到合适的 clarify node_run 候选。',
          },
        },
        demoteTask: {
          label: '把任务退回 interrupted',
          desc: '没有可恢复的 node_run。把任务退回 interrupted，由用户决定是否 resume。',
        },
        markTaskFailed: {
          label: '把任务标为失败',
          desc: '该任务已无法恢复，直接标为 failed。',
        },
        unavailable: {
          taskNotRunning: '任务已经不是 running 状态。',
        },
      },
      S4: {
        kickTask: {
          label: '触发一次调度器拣选',
          desc: '任务长时间停在 pending，直接踢一次调度器。',
        },
        cancelTask: {
          label: '取消该任务',
          desc: '不再期待该任务跑起来，直接取消。',
        },
        unavailable: {
          taskNotPending: '任务已经不是 pending 状态。',
        },
      },
      S5: {
        acknowledge: {
          label: '确认知悉（不改数据）',
          desc: '存在活跃 node_run 但事件流已停滞——告警详情携带各活跃行的 pid，可通过取消/恢复任务走 RFC-098 的进程治理回收（回滚前组杀存活子进程）。确认仅关闭该告警。',
        },
      },
      S6: {
        acknowledge: {
          label: '确认知悉（不改数据）',
          desc: '该任务所有成员（属主+协作者）均非活跃，无人能应答 review/clarify。恢复需重新启用被停用的用户、邀请新协作者或转移属主——属于用户管理操作，不在修复引擎内。确认仅关闭该告警。',
        },
      },
    },
  },
  // RFC-099 — 资源级权限 + 归属展示
  acl: {
    title: '权限',
    owner: '所有者',
    systemOwner: '系统（无所有者）',
    visibility: '可见性',
    visibilityValue: { public: '全员可用', private: '私有' },
    members: '授权用户',
    noMembers: '暂无授权用户',
    privateHint: '私有资源仅所有者与授权用户可见可用；管理员始终可见。',
    save: '保存权限',
    transferOwner: '转让',
    transferTitle: '转让所有者',
    transferHint: '转让后你将保留为授权用户，但不再能管理该资源的权限。',
    transferConfirm: '确认转让',
    ownerBadge: '所有者',
    privateChip: '私有',
  },
  importRefs: {
    selectorLabel: '{{type}}：{{name}}',
    selectOwner: '选择资源所有者',
    candidateDescription: '{{visibility}} · {{id}}',
    resourceType: { agent: '代理', skill: '技能', mcp: 'MCP', plugin: '插件' },
  },
  members: {
    title: '任务成员',
    users: '任务用户',
    noUsers: '暂无其他成员',
    hint: '任务用户与所有者同权（可取消/重试/恢复、回答评审与反问）；仅成员管理与转让保留给所有者和管理员。',
    transferHint: '转让后你将保留为任务用户。',
  },
  userPicker: {
    placeholder: '搜索用户…',
    noResults: '没有匹配的用户',
    remove: '移除 {{name}}',
  },
  taskQuestions: {
    empty: '暂无反问问题。',
    source: '来源节点',
    target: '处理节点',
    noTarget: '未指定',
    reassign: '改派处理节点',
    // RFC-163 — 下发前分组卡的处理节点行（提问节点 + 增派修订 handler）。
    handlerAsker: '提问节点（自己续跑）',
    handlerDesigner: '增派修订',
    autoDispatchQueued: '自动下发排队中',
    confirm: '确认',
    stage: '加入待下发',
    unstage: '移出待下发',
    allNodes: '全部节点',
    answer: '回答',
    viewClarify: '查看反问',
    nodeBadgeAria: '该节点 {{count}} 个待处理问题',
    batchDispatch: '批量下发',
    batchDispatchCount: '全部下发（{{count}}）',
    dispatchTargetChanged: '目标已变，请重试',
    dispatchInFlight: '该节点正在重跑，请等其完成后再下发',
    dispatchInFlightNode:
      '节点 {{node}} 还有未完成的重跑（或不同类型的已下发问题在途），请等其完成后再下发',
    dispatchDesignerNotReady: '设计者尚未就绪，暂时无法下发',
    dispatchRoundMultiTarget: '同一轮的问题被指派到了多个处理节点；v1 需先统一为单一处理节点再下发',
    dispatchUnsafeTarget: '所选处理节点当前不可安全下发',
    dispatchNotDeferred: '该任务未开启延迟下发，手动问题无法下发执行',
    addQuestion: '+ 新增问题',
    manualSource: '手动',
    roleEcho: '回执',
    answerPaneButton: '处理待指派问题',
    answerPaneTitle: '集中回答待指派问题',
    answerPaneEmpty: '没有待回答的问题。',
    answerPaneHint: '在此回答所有待指派问题；提交后进入「待指派」，再到看板选择处理 agent 并下发。',
    answerPaneResubmitHint: '该问题已回答——已预填原答案，重新提交将覆盖。',
    answerPaneSubmit: '提交答案',
    answerPaneSubmitCount: '提交答案（{{count}}）',
    author: {
      newTitle: '新增问题',
      titleLabel: '标题',
      titlePlaceholder: '一句话描述这条问题/指令',
      bodyLabel: '指令',
      bodyPlaceholder: '写清要承接节点执行的具体指令',
      bodyHint: '下发后将作为「外部反馈」注入承接节点的重跑',
      handlerLabel: '承接节点',
      handlerHint: '选择由哪个 agent 节点处理（必填，可稍后改派）',
      handlerPlaceholder: '请选择承接节点',
      save: '保存',
      cancel: '取消',
    },
    phase: {
      pending: '待指派',
      staged: '待下发',
      processing: '处理中',
      awaiting_confirm: '已处理待确认',
      done: '完成',
    },
  },
  attribution: {
    localHistoric: '本地用户（历史）',
    role: { owner: '所有者', user: '用户', admin: '管理员', manager: '资源管理员' },
    submittedBy: '提交人',
    lastEditedBy: '最后修改',
    decidedBy: '决策人',
    justEdited: '{{name}} 刚刚更新了「{{question}}」',
  },
}

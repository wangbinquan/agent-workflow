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
    mcps: string
    plugins: string
    workflows: string
    tasks: string
    reviews: string
    clarify: string
    repos: string
    settings: string
    brand: string
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
      tabAll: string
      tabReviews: string
      tabClarify: string
      empty: string
      errorReviews: string
      errorClarify: string
      retry: string
      sourceTask: string
      openReviews: string
      openClarify: string
      clarifyShardOrIter: string
      clarifySubtitle: string
      badgeAria: string
      shardLabel: string
      iterLabel: string
    }
    // RFC-041 PR4: top-level Memory route.
    memory: string
    memoryHint: string
    memoryBadge: string
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
      statusRunning: string
      statusAwaitingHuman: string
      statusAwaitingReview: string
      statusDone: string
      statusFailed: string
      statusCanceled: string
      statusInterrupted: string
      statusPending: string
      relativeJustNow: string
      relativeMinAgo: string
      relativeHourAgo: string
      relativeDayAgo: string
    }
  }
  mcps: {
    title: string
    hint: string
    newButton: string
    emptyList: string
    colName: string
    colType: string
    colDescription: string
    colEnabled: string
    typeLocal: string
    typeRemote: string
    deleteButton: string
    deleteConfirm: string
    deleteReferenced: string
    newTitle: string
    newHint: string
    detailHint: string
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
    // RFC-030 — probe columns + expand block.
    colStatus: string
    colLatency: string
    colToolCount: string
    probe: {
      latencyMs: string
      latencySec: string
      btnRun: string
      btnRunning: string
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
    hint: string
    newButton: string
    emptyList: string
    colName: string
    colSpec: string
    colSource: string
    colVersion: string
    colEnabled: string
    formTitleNew: string
    formTitleEdit: string
    newTitle: string
    newHint: string
    detailHint: string
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
    checking: string
    upgradeButton: string
    upgrading: string
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
    hint: string
    emptyList: string
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
    useDaemonToken: string
    tabPassword: string
    tabOidc: string
    tabToken: string
    oidcHint: string
    tokenHint: string
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
    subtitle: string
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
    roles: {
      admin: string
      user: string
    }
  }
  // RFC-036 — /users admin page.
  users: {
    title: string
    hint: string
    new: string
    username: string
    displayName: string
    role: string
    status: string
    disable: string
    enable: string
    cancel: string
    password: string
    create: {
      title: string
      submit: string
    }
    roleOption: {
      user: string
      admin: string
      userDesc: string
      adminDesc: string
    }
    selfRoleLocked: string
    noPermission: {
      title: string
      body: string
    }
  }
  repos: {
    title: string
    hint: string
    loading: string
    empty: string
    colUrl: string
    colLocalPath: string
    colLastFetched: string
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
      errorFallback: string
    }
  }
  settings: {
    title: string
    hintBacked: string
    hintPatched: string
    hintRestart: string
    tabRuntime: string
    tabLimits: string
    tabRecovery: string
    tabGc: string
    tabNetwork: string
    tabAppearance: string
    tabMemory: string
    tabRendering: string
    tabAuthentication: string
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
    languageLabel: string
    languageHint: string
    languageZhCN: string
    languageEnUS: string
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
      enabledLabel: string
      enabledHint: string
      testOk: string
      testFail: string
      testSaveFirst: string
      testDetailIssuer: string
      testDetailToken: string
      testDetailJwks: string
    }
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
    fieldModel: string
    fieldModelHint: string
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
    }
  }
  agents: {
    title: string
    hint: string
    newButton: string
    emptyList: string
    colName: string
    colDescription: string
    colOutputs: string
    colRuntime: string
    runtimeDefaultTag: string
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
    zipEmptyHint: string
    zipParse: string
    zipParsing: string
    zipImportButton: string
    zipImporting: string
    zipImportSummary: string
    zipNoCandidates: string
    zipErrorBanner: string
    zipColCandidate: string
    zipColDescription: string
    zipColFiles: string
    zipColConflict: string
    zipColAction: string
    zipActionImport: string
    zipActionSkip: string
    zipActionOverwrite: string
    zipActionRename: string
    zipRenameTo: string
    zipRenameEmpty: string
    zipRenameInvalid: string
    zipRenameDup: string
    zipRenameConflict: string
    zipConflictManaged: string
    zipConflictManagedReadonly: string
    zipConflictExternal: string
    fileDiscardConfirm: string
    fileErrPathRequired: string
    fileErrRelativeOnly: string
    fileTreeHeader: string
    fileTreeEmpty: string
    fileNewPathPlaceholder: string
    fileAddButton: string
    fileEditorEmpty: string
    fileLoadingNamed: string
    fileDeleteButton: string
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
    colName: string
    colWorkflow: string
    colStatus: string
    colStarted: string
    colRepo: string
    colError: string
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
    commitOutcomeSkippedEmpty: string
    commitFiles: string
    metaStarted: string
    metaFinished: string
    metaError: string
    /** RFC-066: multi-repo summary `<details>` label on the task detail page. */
    multiRepoSummary: string
    cancelButton: string
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
    diffMarkViewed: string
    noNodeRuns: string
    colNode: string
    colIteration: string
    colRetry: string
    colDuration: string
    secondsAgo: string
    minutesAgo: string
    hoursAgo: string
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
    validationWarnings: string
    validationAutoFitWrapper: string
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
    menuSelectedCount: string
    nodeTitleUnsetAgent: string
    nodeTitleUnsetKey: string
  }
  launch: {
    title: string
    hintBefore: string
    hintCode: string
    hintAfter: string
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
    edgeConflictMsg: string
    edgeDeleteBtn: string
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
    outputKindLabel: string
    outputKind_string: string
    outputKind_markdown: string
    outputKind_markdown_file: string
    fieldSkills: string
    fieldSkillsHint: string
    fieldSkillsPlaceholder: string
    skillsPickerLabel: string
    skillsPickerLoading: string
    skillsPickerEmpty: string
    skillsPickerLoadFailed: string
    fieldDependsOn: string
    fieldDependsOnHint: string
    fieldDependsOnPlaceholder: string
    dependsPickerLabel: string
    dependsPickerLoading: string
    dependsPickerEmpty: string
    dependsPickerLoadFailed: string
    fieldMcps: string
    fieldMcpsHint: string
    fieldMcpsPlaceholder: string
    mcpsPickerLabel: string
    mcpsPickerLoading: string
    mcpsPickerEmpty: string
    mcpsPickerLoadFailed: string
    fieldPlugins: string
    fieldPluginsHint: string
    fieldPluginsPlaceholder: string
    pluginsPickerLabel: string
    pluginsPickerLoading: string
    pluginsPickerEmpty: string
    pluginsPickerLoadFailed: string
    fieldDependencyTree: string
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
    fieldBody: string
    bodyPlaceholder: string
    rawBodySummary: string
    importButton: string
    autodetect: {
      button: string
      disabledHint: string
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
      selectedFile: string
      parseButton: string
      applyButton: string
      cancelButton: string
      previewEmpty: string
      willOverwrite: string
      footerHint: string
      bodySizeHint: string
      routedTo: {
        name: string
        description: string
        permission: string
        bodyMd: string
        frontmatterExtra: string
      }
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
  }
  /** Canvas chip label for review nodes (⚖ icon). */
  reviewNode: {
    label: string
  }
  /** Canvas chip label fallback for clarify / cross-clarify nodes — used
   *  when the renderer is invoked without an explicit `data.kindLabel`. */
  clarifyNode: {
    label: string
  }
  crossClarifyNode: {
    label: string
  }
  errors: Record<string, string>
  // RFC-023 clarify feature (PR-C).
  clarify: {
    taskNameLabel: string
    nav: { label: string; badgeTitle: string }
    list: {
      title: string
      hint: string
      filter: { awaiting: string; answered: string; all: string }
      empty: string
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
    questionScope: {
      label: string
      designer: string
      questioner: string
      designerTooltip: string
      questionerTooltip: string
      shortcutHint: string
    }
    submitHint: {
      allDesigner: string
      allQuestioner: string
      mixed: string
    }
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
    hint: string
    adminOnly: string
    empty: string
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
    collapsedToQuestioner: string
    collapsedToDesigner: string
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
    role: { owner: string; user: string; admin: string }
    submittedBy: string
    lastEditedBy: string
    decidedBy: string
    justEdited: string
  }
}

export const zhCN: Resources = {
  nav: {
    agents: '代理',
    skills: '技能',
    mcps: 'MCP',
    plugins: '插件',
    workflows: '工作流',
    tasks: '任务',
    reviews: '评审',
    clarify: '反问',
    repos: '远端仓',
    settings: '设置',
    brand: 'Agent Workflow',
    home: '首页',
    group: {
      agents: '代理',
      workflows: '工作流',
      tasks: '任务',
      memory: '记忆',
    },
    settingsIcon: {
      label: '设置',
      tooltip: '设置（含主题切换）',
    },
    inbox: {
      label: '收件箱',
      tabAll: '全部',
      tabReviews: '评审',
      tabClarify: '反问',
      empty: '当前没有待处理事项',
      errorReviews: '评审列表加载失败',
      errorClarify: '反问列表加载失败',
      retry: '重试',
      sourceTask: '任务 {{taskId}}',
      openReviews: '查看全部评审 →',
      openClarify: '查看全部反问 →',
      clarifyShardOrIter: '分片 {{shard}} / 第 {{iter}} 轮',
      clarifySubtitle: '← {{agent}} · {{detail}}',
      badgeAria: '{{n}} 项待处理',
      shardLabel: '分片 {{shard}}',
      iterLabel: '第 {{iter}} 轮',
    },
    memory: '记忆',
    memoryHint: '从过往反问、评审与反馈中沉淀的长期上下文',
    memoryBadge: '{{count}} 项待审批',
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
      statusRunning: '运行中',
      statusAwaitingHuman: '等待回答',
      statusAwaitingReview: '等待评审',
      statusDone: '已完成',
      statusFailed: '失败',
      statusCanceled: '已取消',
      statusInterrupted: '已中断',
      statusPending: '排队中',
      relativeJustNow: '刚刚',
      relativeMinAgo: '{{n}} 分钟前',
      relativeHourAgo: '{{n}} 小时前',
      relativeDayAgo: '{{n}} 天前',
    },
  },
  reviews: {
    title: '评审',
    hint: '人工评审节点产出的设计文档；选词写意见，三个按钮决定下一步。',
    emptyList: '没有评审项。',
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
    subtitle: '使用账户密码登录，或选择一个已配置的身份提供商。',
    username: '用户名',
    usernamePlaceholder: '例如 alice',
    password: '密码',
    passwordPlaceholder: '••••••••',
    signIn: '登录',
    invalidCredentials: '用户名或密码错误',
    or: '或',
    loginWith: '使用 {{name}} 登录',
    useDaemonToken: '使用守护进程 Token',
    tabPassword: '账号密码',
    tabOidc: '身份提供商',
    tabToken: 'Token 登录',
    oidcHint: '通过已配置的身份提供商登录。',
    tokenHint: '使用 daemon 启动时打印的 64 位十六进制 token。仅供管理员 / 应急使用。',
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
    subtitle: '管理你的密码、会话与个人访问令牌。',
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
    patsDesc:
      '供脚本和 CI 使用。每个令牌只持有你角色权限的一个子集；生成后只显示一次，请立即复制。',
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
    identitiesDesc: '与本账号绑定的 OIDC 身份提供商。解除绑定不会删除账户，可以从登录页重新绑定。',
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
    roles: {
      admin: '管理员',
      user: '用户',
    },
  },
  users: {
    title: '用户',
    hint: '管理用户列表 —— 仅管理员可见。',
    new: '新建用户',
    username: '用户名',
    displayName: '显示名',
    role: '角色',
    status: '状态',
    disable: '停用',
    enable: '启用',
    cancel: '取消',
    password: '密码（留空则状态为已邀请）',
    create: {
      title: '新建用户',
      submit: '创建',
    },
    roleOption: {
      user: '普通用户',
      admin: '管理员',
      userDesc: '只读资源 + 启动任务 + 管理自己的账户。',
      adminDesc: '完整权限：用户、设置、OIDC、所有任务。',
    },
    selfRoleLocked: '不能修改自己的角色 —— 需要另一位管理员代为操作。',
    noPermission: {
      title: '需要管理员权限',
      body: '该页面仅管理员角色可访问。',
    },
  },
  repos: {
    title: '远端仓缓存',
    hint: '所有通过 Git URL 启动任务时克隆下来的远端仓库；可手动 Refresh 拉新或 Delete 释放磁盘。',
    loading: '加载中…',
    empty: '还没有任何缓存的远端仓库。在 launcher 的"远端 URL"模式启动一次任务即可建立缓存。',
    colUrl: '远端 URL',
    colLocalPath: '本地缓存路径',
    colLastFetched: '上次 fetch 时间',
    colRefs: '关联任务',
    colActions: '操作',
    refresh: 'Refresh',
    delete: 'Delete',
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
      errorFallback: 'submodule 同步失败（无 stderr）',
    },
  },
  settings: {
    title: '设置',
    hintBacked: '基于 ',
    hintPatched: '。补丁通过 ',
    hintRestart: '。标注 restart 的字段需重启守护进程才生效。',
    tabRuntime: '运行时',
    tabLimits: '限额',
    tabRecovery: '恢复',
    tabGc: 'GC',
    tabNetwork: '网络',
    tabAppearance: '外观',
    tabMemory: '记忆',
    tabRendering: '渲染',
    tabAuthentication: '认证',
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
    languageLabel: '界面语言',
    languageHint: '切换中文 / 英文，保存即生效，无需刷新页面。',
    languageZhCN: '简体中文',
    languageEnUS: 'English',
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
      groupCreds: '凭据',
      groupCredsHint:
        'daemon 用来访问 IdP 的 OAuth 2.0 客户端凭据。Secret 落盘前 AES-256-GCM 加密。',
      clientId: 'Client ID',
      clientSecret: 'Client Secret',
      clientSecretEditHint: '留空则保留现有值',
      scopes: 'Scopes',
      scopesHint: '空格分隔。openid 是必需的；推荐同时申请 profile + email。',
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
      enabledLabel: '启用',
      enabledHint: '开启后会出现在登录页；关闭则隐藏。',
      testOk: '连接成功',
      testFail: '连接失败',
      testSaveFirst: '请先保存，再运行测试',
      testDetailIssuer: 'issuer：',
      testDetailToken: 'token：',
      testDetailJwks: 'jwks：',
    },
  },
  onboarding: {
    title: '欢迎使用 Agent Workflow',
    intro: '看起来这是新仓 — 还没有任何 agent 或 workflow。跟着下面四步建一条最小流水线。',
    step1Title: '1. 创建第一个 agent',
    step1Body: '取名为 coder，把 outputs 设为 [code]，把 prompt body 留空或粘一段简单的指令即可。',
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
    fieldModel: '模型',
    fieldModelHint: '该运行时上的 agent 启动时所用模型。留空则用二进制自身默认。',
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
    },
  },
  agents: {
    title: '代理',
    hint: '虚拟代理；通过 OPENCODE_CONFIG_CONTENT 在 per-run 注入。',
    newButton: '+ 新建代理',
    emptyList: '还没有代理。创建一个开始吧。',
    colName: '名称',
    colDescription: '描述',
    colOutputs: '输出端口',
    colRuntime: '运行时',
    runtimeDefaultTag: '默认',
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
    tabZip: '上传 ZIP',
    zipEmptyHint: '选择一个 .zip，顶层是一个目录，里面每个子目录是一个 skill（含 SKILL.md）。',
    zipParse: '解析',
    zipParsing: '解析中…',
    zipImportButton: '导入 {{n}} 个技能',
    zipImporting: '导入中…',
    zipImportSummary: '新建 {{c}} · 覆盖 {{u}} · 跳过 {{s}} · 失败 {{f}}',
    zipNoCandidates: 'zip 中未找到任何技能候选。',
    zipErrorBanner: '以下条目无法导入：',
    zipColCandidate: '技能',
    zipColDescription: '描述',
    zipColFiles: '文件数',
    zipColConflict: '冲突',
    zipColAction: '动作',
    zipActionImport: '作为新技能导入',
    zipActionSkip: '跳过',
    zipActionOverwrite: '覆盖',
    zipActionRename: '重命名',
    zipRenameTo: '新名称',
    zipRenameEmpty: '请输入名称',
    zipRenameInvalid: '需为 kebab-case',
    zipRenameDup: '与本批次其他重名',
    zipRenameConflict: '名称已被占用',
    zipConflictManaged: '已存在 managed 技能',
    zipConflictManagedReadonly: '已存在 managed 技能 — 无权限替换',
    zipConflictExternal: 'external 技能 — 不支持 ZIP 覆盖',
    fileDiscardConfirm: '放弃未保存的修改？',
    fileErrPathRequired: '路径必填',
    fileErrRelativeOnly: '仅允许相对路径；不能包含 ".."',
    fileTreeHeader: '文件',
    fileTreeEmpty: '暂无文件。',
    fileNewPathPlaceholder: 'path/to/new-file.md',
    fileAddButton: '+ 新增',
    fileEditorEmpty: '请在左侧选择文件，或新增一个。',
    fileLoadingNamed: '正在加载 {{name}}…',
    fileDeleteButton: '删除文件',
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
    hint: '注册可供 agent 引用的 MCP 服务器。运行时 runner 按 agent 依赖闭包合并注入 OPENCODE_CONFIG_CONTENT.mcp，opencode 子进程启动后建立连接。',
    newButton: '+ 新建 MCP',
    emptyList: '还没有登记的 MCP 服务器。',
    colName: '名称',
    colType: '类型',
    colDescription: '描述',
    colEnabled: '启用',
    typeLocal: '本地 (stdio)',
    typeRemote: '远端 (http / sse)',
    deleteButton: '删除',
    deleteConfirm: '删除该 MCP？',
    deleteReferenced: '无法删除：以下 agent 仍在引用，请先解除引用：',
    newTitle: '新建 MCP 服务器',
    newHint: '注册可被 agent 引用的 MCP 服务器；运行时按依赖闭包合并注入到 opencode 子进程。',
    detailHint: '编辑该 MCP 的配置；保存后所有引用它的 agent 下一次启动时生效。',
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
      '在 agent 的 permission 字段里点名某 MCP 工具时，使用 `{name}_{tool_name}`（opencode 自动按 mcp 名 + 工具名拼接，详见 OPENCODE_CONFIG.md §3.3）。',
    cwdHint:
      'stdio 子进程会在该 task 的 worktree 目录下启动（opencode 端没有 cwd 字段，所以这里也不提供）。',
    oauthCliHint:
      'remote MCP 走 OAuth 时，建议先在主机上执行 `opencode mcp auth <name>` 完成一次浏览器登录，token 会落到 ~/.opencode/auth/，之后所有 opencode 子进程都能复用。',
    oauthModeAuto: '自动',
    oauthModeDisabled: '禁用',
    // RFC-030 — probe columns + expand block.
    colStatus: '状态',
    colLatency: '延时',
    colToolCount: '工具',
    probe: {
      latencyMs: '{{ms}} ms',
      latencySec: '{{s}} s',
      btnRun: '重新探测',
      btnRunning: '探测中…',
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
    hint: '注册 opencode 插件后，可在任意代理的 frontmatter.plugins 中按名称引用。保存即在 ~/.agent-workflow/plugins/ 下急安装，运行时框架以 file://<已缓存路径> 注入到 OPENCODE_CONFIG_CONTENT.plugin，spawn 阶段零联网。',
    newButton: '+ 新建插件',
    emptyList: '尚未登记任何插件。',
    colName: '名称',
    colSpec: 'Spec',
    colSource: '来源',
    colVersion: '版本',
    colEnabled: '启用',
    formTitleNew: '新建插件',
    formTitleEdit: '编辑插件',
    newTitle: '新建插件',
    newHint:
      '注册一个 opencode 插件后，代理可在 frontmatter.plugins 中按名引用。保存即执行 `npm install --prefix ~/.agent-workflow/plugins/{id}/` 急安装；运行时框架以 file://<cachedPath> 注入，spawn 阶段不联网。',
    detailHint:
      '编辑插件的 spec / options 等字段。改动会在引用该插件的任意 agent 下次启动时生效；正在执行的 task 仍使用旧 cachedPath。',
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
    checking: '检查中…',
    upgradeButton: '升级',
    upgrading: '升级中…',
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
    colName: '名称',
    colWorkflow: '工作流',
    colStatus: '状态',
    colStarted: '开始',
    colRepo: '仓库',
    colError: '错误',
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
    commitOutcomeSkippedEmpty: '无改动',
    commitFiles: '{{files}} 个文件，+{{ins}}/-{{del}}',
    metaStarted: '开始',
    metaFinished: '完成',
    metaError: '错误',
    // RFC-066: multi-repo summary on the task detail page.
    multiRepoSummary: '{{count}} 个仓库',
    cancelButton: '取消任务',
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
    resumeLaunchLink: '启动新任务 →',
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
    diffMarkViewed: '标记 {{file}} 为已看',
    noNodeRuns: '还没有节点运行；调度器还未触达任何节点。',
    colNode: '节点',
    colIteration: '轮次',
    colRetry: '重试',
    colDuration: '耗时',
    secondsAgo: '{{n}} 秒前',
    minutesAgo: '{{n}} 分钟前',
    hoursAgo: '{{n}} 小时前',
    status: {
      pending: '待运行',
      running: '运行中',
      done: '已完成',
      failed: '失败',
      canceled: '已取消',
      interrupted: '已中断',
      awaiting_review: '等待审核',
      awaiting_human: '等待回答',
    },
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
    validationWarnings: '{{n}} 个警告（不阻塞启动）',
    validationAutoFitWrapper: '自适应',
    paletteFilter: '过滤面板…',
    paletteNoMatches: '没有匹配项。',
    paletteAgents: '代理',
    paletteFanOut: 'Fan-out',
    paletteFanOutDesc: '多进程（按 sourcePort 分片）',
    paletteAgentFallbackDesc: '代理节点',
    paletteWrappers: '包装器',
    paletteWrapperGitLabel: '⎈ Git 包装器',
    paletteWrapperGitDesc: '在子节点前后快照 diff',
    paletteWrapperLoopLabel: '⟳ 循环包装器',
    paletteWrapperLoopDesc: '重复执行子节点直到退出条件满足',
    paletteWrapperFanoutLabel: '⫶ 分片包装器',
    paletteWrapperFanoutDesc: '把 list<T> 端口的每个元素分配给内部子图独立执行；用聚合 agent 收口',
    paletteIo: 'IO',
    paletteInputLabel: '↳ 输入',
    paletteInputDesc: 'launcher 表单值',
    paletteOutputLabel: '⤴ 输出',
    paletteOutputDesc: '任务详情页输出面板',
    paletteHuman: '人工',
    paletteReviewLabel: '⚖ 评审',
    paletteReviewDesc: '挂在 markdown port 下游，让人评审后再继续。',
    paletteClarifyLabel: '⚡ 反问',
    paletteClarifyDesc: '让 agent 在无法决断时主动反问；从节点左侧 input 端往 agent 上拖即可挂接。',
    menuPaste: '粘贴',
    menuSelectAll: '全选',
    menuDuplicate: '复制为新节点',
    menuCopy: '复制',
    menuWrapGit: '用 git wrapper 包装',
    menuWrapLoop: '用 loop wrapper 包装',
    menuDecompose: '解组 wrapper',
    boxSelectHint: '按住 Shift 框选',
    menuSelectedCount: '已选 {{n}} 个',
    nodeTitleUnsetAgent: '(未设置代理)',
    nodeTitleUnsetKey: '(未设置 key)',
  },
  launch: {
    title: '启动：{{name}}',
    hintBefore: '选好仓库 + 分支，填好工作流 inputs，然后提交。提交时会在 ',
    hintCode: '~/.agent-workflow/worktrees/<repo>/<taskId>',
    hintAfter: ' 处创建一个 worktree。',
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
    fieldReviewRerunRejectHint: '逗号分隔的节点 id；默认 = 上游节点 + 其所有可达上游。',
    fieldReviewRerunIterate: 'iterate 时重跑节点',
    fieldReviewRerunIterateHint: '逗号分隔的节点 id；默认 = 仅上游节点。',
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
      '声明的输入端口列表。**恰好一个**必须标记为 shard source 且 kind 必须是 list<T>；其余作为 broadcast 端口、传给每个 shard。',
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
    edgeConflictMsg: '已存在同源同目标端口的边，请先删除冲突边。',
    edgeDeleteBtn: '删除该边',
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
  agentForm: {
    fieldName: '名称',
    fieldNameHint: 'kebab-case；用于 /agents/:name URL。',
    fieldNamePlaceholder: '例如 code-fixer',
    fieldDescription: '描述',
    fieldDescriptionPlaceholder: '一行简介，会显示在列表中',
    fieldOutputs: '输出端口',
    fieldOutputsHint:
      '在 <port> envelope 中声明的端口名。可为每个端口选择类型；选「文件路径」并把扩展名设为 Markdown（.md）时，端口内容是 worktree 内的 .md 相对路径，框架会自动读取文件内容。',
    fieldOutputsPlaceholder: '输入端口名后按 Enter',
    outputsValidate: '只允许小写字母 + 下划线',
    outputKindLabel: '{{port}} 的输出类型',
    outputKind_string: '字符串',
    outputKind_markdown: 'Markdown 正文',
    outputKind_markdown_file: 'Markdown 文件路径',
    fieldSkills: '技能',
    fieldSkillsHint: '框架运行时注入的技能名。',
    fieldSkillsPlaceholder: '输入技能名后按 Enter',
    skillsPickerLabel: '从已有技能中选择…',
    skillsPickerLoading: '加载中…',
    skillsPickerEmpty: '暂无可选技能（已全部添加 / 仓库为空）',
    skillsPickerLoadFailed: '加载技能列表失败；仍可在下方手动输入。',
    fieldDependsOn: '依赖的其他代理',
    fieldDependsOnHint:
      '运行时会把这些代理（递归含它们的依赖）以及它们的技能一并加载进同一个 opencode 子进程，主代理可以通过 task / subagent 工具调用它们。',
    fieldDependsOnPlaceholder: '输入代理名后按 Enter',
    dependsPickerLabel: '从已有代理中选择…',
    dependsPickerLoading: '加载中…',
    dependsPickerEmpty: '暂无可选代理（已全部添加 / 仓库为空）',
    dependsPickerLoadFailed: '加载代理列表失败；仍可在下方手动输入。',
    fieldMcps: 'MCP 依赖',
    fieldMcpsHint: '该 agent 启动时按 dependsOn 闭包合并注入。详细规则见 OPENCODE_CONFIG.md §3.3。',
    fieldMcpsPlaceholder: '输入 MCP 名后按 Enter',
    mcpsPickerLabel: '从已登记的 MCP 中选择…',
    mcpsPickerLoading: '加载中…',
    mcpsPickerEmpty: '暂无可选 MCP（已全部添加 / 仓库为空）',
    mcpsPickerLoadFailed: '加载 MCP 列表失败；仍可在下方手动输入。',
    fieldPlugins: 'Plugin 依赖',
    fieldPluginsHint:
      '名称需对应 /plugins 中已登记的插件。runner 在闭包合并后以 file://<cachedPath> 注入到 OPENCODE_CONFIG_CONTENT.plugin，spawn 阶段零联网。',
    fieldPluginsPlaceholder: '输入插件名后按 Enter',
    pluginsPickerLabel: '从已登记的插件中选择…',
    pluginsPickerLoading: '加载中…',
    pluginsPickerEmpty: '暂无可选插件（已全部添加 / 仓库为空）',
    pluginsPickerLoadFailed: '加载插件列表失败；仍可在下方手动输入。',
    fieldDependencyTree: '闭包依赖（预览）',
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
    fieldBody: '正文 (Markdown)',
    bodyPlaceholder: 'Agent 系统提示词；Markdown。',
    rawBodySummary: '裸 markdown（无预览）',
    importButton: '从 agent.md 导入',
    autodetect: {
      button: '自动识别依赖',
      disabledHint: '请先填写 agent 正文',
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
        '---\ndescription: 代码评审员\nmodel: anthropic/claude-sonnet-4-6\npermission:\n  edit: ask\n---\n你是一名审计员……',
      selectedFile: '已选：{{name}}',
      parseButton: '解析',
      applyButton: '应用',
      cancelButton: '取消',
      previewEmpty: '未识别到任何字段。文件可能为空或仅包含正文。',
      willOverwrite: '应用将覆盖你已修改的 {{count}} 个字段：{{fields}}',
      footerHint: '仅填入下方表单；保存仍需点击「创建」按钮。',
      bodySizeHint: '（{{bytes}} 字节）',
      routedTo: {
        name: '→ 名称',
        description: '→ 描述',
        permission: '→ Permission',
        bodyMd: '→ 正文（Markdown）',
        frontmatterExtra: '→ frontmatterExtra',
      },
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
  },
  reviewNode: {
    label: '评审',
  },
  clarifyNode: {
    label: '反问',
  },
  crossClarifyNode: {
    label: '跨代理反问',
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
    'skill-source-path-missing': '路径不存在。',
    'skill-source-path-not-dir': '路径不是目录。',
    'skill-source-path-in-use': '该父目录已登记。',
    'skill-source-children-referenced': '该父目录下的部分子技能仍被代理引用，请先解绑。',
    'skill-source-readonly': '此技能由父目录纳管，请在外部目录里编辑文件。',
    fallback: '请求失败',
  },
  clarify: {
    taskNameLabel: '所属任务',
    nav: {
      label: '反问澄清',
      badgeTitle: '{{count}} 条待回答的反问',
    },
    list: {
      title: '反问',
      hint: 'Agent 发起的反问澄清；回答后流程会继续往下走。',
      filter: { awaiting: '待回答', answered: '已回答', all: '全部' },
      empty: '没有反问项。',
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
    // RFC-059: per-question scope picker文案（每道题旁的设计者/反问者切换）。
    questionScope: {
      label: '作用域',
      designer: '设计者',
      questioner: '反问者',
      designerTooltip: '答案同时送达设计者与反问者（设计者用来更新文档）',
      questionerTooltip: '答案只发给反问者；设计者不被通知、不重跑',
      shortcutHint: 'Q/W 切换当前题的作用域（Q=设计者，W=反问者）',
    },
    submitHint: {
      allDesigner: '提交后将触发设计者重跑（设计者收到全部 {{n}} 题），反问者随后用全部 Q&A 重跑',
      allQuestioner: '提交后只重跑反问者（含全部 {{n}} 题与答案），设计者不参与',
      mixed:
        '提交后先触发设计者重跑（设计者仅收 {{d}} 题），反问者随后用全部 {{total}} 题与答案重跑',
    },
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
      paletteLabel: '⚡ 跨代理反问',
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
    hint: '从过往反问、评审与反馈中沉淀的长期上下文，注入到每次同维度的 agent 运行。',
    adminOnly: '仅管理员可审批',
    empty: '暂无沉淀',
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
    collapsedToQuestioner: '该题已改由提问节点承接（反问者），不再单独安排设计者处理。',
    collapsedToDesigner: '该题已改由设计节点统一承接，提问节点将收到回执知会，不再单独续跑。',
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
    role: { owner: '所有者', user: '用户', admin: '管理员' },
    submittedBy: '提交人',
    lastEditedBy: '最后修改',
    decidedBy: '决策人',
    justEdited: '{{name}} 刚刚更新了「{{question}}」',
  },
}

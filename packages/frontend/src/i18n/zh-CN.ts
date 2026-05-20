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
      // RFC-041 PR4: admin-only "pending memory" group in the unified inbox.
      pendingMemoryGroup: string
      pendingMemoryEmpty: string
      memoryItemSubtitle: string
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
      ready: string
      checking: string
      missing: string
      incompatible: string
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
    // RFC-030 — probe columns + expand block.
    colStatus: string
    colLatency: string
    colToolCount: string
    probe: {
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
    tabGc: string
    tabNetwork: string
    tabConnection: string
    tabAppearance: string
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
    zipConflictExternal: string
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
    metaStarted: string
    metaFinished: string
    metaError: string
    cancelButton: string
    resumeButton: string
    resuming: string
    resumeUnavailableNoWorktree: string
    resumeLaunchLink: string
    failedBanner: string
    jumpToFailed: string
    reviewButton: string
    clarifyButton: string
    worktreePreserved: string
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
    tabWorktreeDiff: string
    tabFeedback: string
    noWorkflowSnapshot: string
    noBaseCommit: string
    loadingDiff: string
    diffNoChanges: string
    diffTruncatedBanner: string
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
    fieldReviewTitle: string
    fieldReviewTitleHint: string
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
    loopExitNodeIdSelect: string
    loopExitPortNameSelect: string
    loopExitInvalidNodeId: string
    loopExitInvalidPortName: string
    loopBindingInvalid: string
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
    fieldModelOverrideHint: string
    modelPlaceholder: string
    fieldVariant: string
    fieldTemperatureOverride: string
    sourcePortNodePlaceholder: string
    sourcePortPlaceholder: string
    sourcePortMissingSuffix: string
    sourcePortDragHint: string
    edgeTitle: string
    edgeSourceLabel: string
    edgeTargetLabel: string
    edgePortNameLabel: string
    edgeConflictMsg: string
    edgeDeleteBtn: string
    missingRefsLabel: string
    missingRefsHint: string
    // RFC-023 clarify node inspector
    fieldClarifyTitle: string
    fieldClarifyTitleHint: string
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
    fieldReadonly: string
    fieldReadonlyHint: string
    fieldSyncOutputsOnIterate: string
    fieldSyncOutputsOnIterateHint: string
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
        model: string
        variant: string
        temperature: string
        steps: string
        maxSteps: string
        permission: string
        bodyMd: string
        frontmatterExtra: string
      }
    }
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
    readonly: string
    writes: string
    seeAbove: string
    cycleHeading: string
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
        readonly: string
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
      }
    }
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
  }
  settingsForm: {
    opencodePath: string
    opencodePathHint: string
    defaultModel: string
    defaultModelHint: string
    defaultVariant: string
    defaultTemperature: string
    defaultSteps: string
    defaultStepsHint: string
    defaultMaxSteps: string
    defaultMaxStepsHint: string
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
    labelGit: string
    labelLoop: string
    pillGit: string
    pillLoop: string
    dropHere: string
    fitToChildren: string
    unwrap: string
    deleteWithInner: string
    confirmDeleteWithInner: string
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
      submitDisabledRequired: string
      draftSaving: string
      draftSaved: string
      recommendedChip: string
      back: string
      answeredAt: string
      askedAt: string
      keyboardHint: string
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
    status: {
      candidate: string
      approved: string
      archived: string
      superseded: string
      rejected: string
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
      section: {
        candidates: string
        conversation: string
        scope: string
        sourceEvents: string
      }
      sessionLoadError: string
      sourceDeleted: string
      stderrLabel: string
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
      pendingMemoryGroup: '待审批记忆 ({{count}})',
      pendingMemoryEmpty: '暂无候选记忆',
      memoryItemSubtitle: '{{scope}} · {{kind}}',
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
    runtime: {
      ready: 'opencode v{{version}} · 已就绪',
      checking: '检查中…',
      missing: '未找到 opencode',
      incompatible: 'opencode v{{version}} 低于最低门槛 v{{minVersion}}',
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
    iterateButton: '迭代',
    detailHint: '当前版本 · 已迭代 {{iteration}} 轮 · 决策：{{decision}}',
    rejectPrompt: '请输入退回原因（提交后将回滚并重跑：{{willRerun}}）：',
    rejectReasonRequired: '退回必须填写原因。',
    iterateConfirm: '将基于上方评审意见重跑：{{willRerun}}。继续？',
    iterateNoCommentsWarning:
      '当前未提交任何评审意见。继续迭代会让 agent 收到空意见列表 — 仍然继续吗？',
    approveDraftWarning: '还有 {{count}} 条未提交评审意见。',
    approveDraftConfirm: 'Approve 将丢弃这些草稿。确定继续吗？',
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
    tabGc: 'GC',
    tabNetwork: '网络',
    tabConnection: '连接',
    tabAppearance: '外观',
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
    },
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
    zipConflictExternal: 'external 技能 — 不支持 ZIP 覆盖',
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
    // RFC-030 — probe columns + expand block.
    colStatus: '状态',
    colLatency: '延时',
    colToolCount: '工具',
    probe: {
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
    metaStarted: '开始',
    metaFinished: '完成',
    metaError: '错误',
    cancelButton: '取消任务',
    resumeButton: '继续任务',
    resuming: '继续中…',
    resumeUnavailableNoWorktree:
      'worktree 创建阶段就失败了（根本没建出 worktree），resume 救不了。请新建一个任务。',
    resumeLaunchLink: '启动新任务 →',
    failedBanner: '任务失败。',
    jumpToFailed: '跳到失败节点 ({{nodeId}})',
    reviewButton: '去审核',
    clarifyButton: '去回答',
    worktreePreserved:
      'Worktree 仍保留在 {{path}}。可手动检查；结束后执行 git worktree remove 清理。',
    sectionWorkflowStatus: '工作流状态',
    sectionNodeRuns: '节点运行',
    sectionWorktreeDiff: 'Worktree diff',
    tabWorkflowStatus: '工作流状态',
    tabNodeRuns: '节点运行',
    tabDetails: '详细信息',
    tabOutputs: '输出',
    tabWorktreeDiff: 'Worktree diff',
    tabFeedback: '留言',
    noWorkflowSnapshot: '没有工作流快照。',
    noBaseCommit: '未记录 base commit；diff 不可用。',
    loadingDiff: '加载 diff 中…',
    diffNoChanges: '自任务启动以来没有改动。',
    diffTruncatedBanner: '⚠ Diff 已截断至 1 MiB。请直接查看 worktree 获取完整输出。',
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
    paletteHuman: '人工',
    paletteReviewLabel: '⚖ 评审节点',
    paletteReviewDesc: '挂在 markdown port 下游，让人评审后再继续。',
    paletteClarifyLabel: '⚡ 反问澄清',
    paletteClarifyDesc: '让 agent 在无法决断时主动反问；从节点左侧 input 端往 agent 上拖即可挂接。',
    menuPaste: '粘贴',
    menuSelectAll: '全选',
    menuDuplicate: '复制为新节点',
    menuCopy: '复制',
    menuWrapGit: '用 git wrapper 包装',
    menuWrapLoop: '用 loop wrapper 包装',
    menuDecompose: '解组 wrapper',
    boxSelectHint: '按住 Shift 框选',
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
    fieldReviewTitle: '评审标题',
    fieldReviewTitleHint: '展示在评审列表与详情头部；可为空，会回退到节点 id。',
    fieldReviewDescription: '评审说明',
    fieldReviewDescriptionHint: '可选 — 给评审者的上下文。',
    fieldReviewInputSourceNode: '上游节点',
    fieldReviewInputSourceNodeHint: '产出待评 markdown 的上游节点 id。',
    fieldReviewInputSourcePort: '上游端口',
    fieldReviewInputSourcePortHint:
      '该节点产出的 markdown 端口名（agent.outputKinds 必须声明为 markdown）。',
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
    innerNodeIdPlaceholder: '内部 nodeId',
    addBinding: '+ 增加绑定',
    loopExitNodeIdSelect: '— 选择一个循环内节点 —',
    loopExitPortNameSelect: '— 选择端口 —',
    loopExitInvalidNodeId: '"{{nodeId}}" 已不在该循环内，请重新选择当前成员节点。',
    loopExitInvalidPortName: '"{{portName}}" 不是该节点声明的输出端口，请重新选择。',
    loopBindingInvalid: '"{{nodeId}}.{{portName}}" 不是当前循环成员端口，请重新选择。',
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
    fieldModelOverrideHint: '默认沿用 Agent 的模型（{{model}}）；改成其他值即覆盖。',
    modelPlaceholder: 'anthropic/claude-sonnet-4-6',
    fieldVariant: 'Variant',
    fieldTemperatureOverride: 'Temperature 覆盖',
    sourcePortNodePlaceholder: '— 选上游节点 —',
    sourcePortPlaceholder: '— 选输出端口 —',
    sourcePortMissingSuffix: '（已失效）',
    sourcePortDragHint: '也可以从节点顶部的端口直接拖入上游输出来设置。',
    edgeTitle: '边设置',
    edgeSourceLabel: '源',
    edgeTargetLabel: '目标节点',
    edgePortNameLabel: '目标端口名',
    edgeConflictMsg: '已存在同源同目标端口的边，请先删除冲突边。',
    edgeDeleteBtn: '删除该边',
    missingRefsLabel: '模板引用但未连入：',
    missingRefsHint: '这些端口名出现在 prompt 模板里但还没有上游边；启动 task 时会被静态校验拦下。',
    fieldClarifyTitle: '反问节点标题',
    fieldClarifyTitleHint: '展示在画布和列表头部；可为空，会回退到节点 id。',
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
    fieldOutputsHint:
      '在 <port> envelope 中声明的端口名。可为每个端口选择类型：markdown_file 表示端口内容是 worktree 内的 .md 相对路径，框架会自动读取文件内容。',
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
    fieldReadonly: '只读',
    fieldReadonlyHint: '只读 agent 可在同一 task 中并发；可写 agent 会串行。',
    fieldSyncOutputsOnIterate: '文档迭代期间是否同步刷新本代理生成的其他文档',
    fieldSyncOutputsOnIterateHint:
      '仅当本代理 outputs 含 ≥ 2 个 markdown / markdown_file 时实际生效；关闭则在用户点"返回修改"时只重生被评审的那一份，其他文档沿用上一版本。',
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
        model: '→ 模型',
        variant: '→ 变体',
        temperature: '→ 温度',
        steps: '→ Steps',
        maxSteps: '→ Max steps',
        permission: '→ Permission',
        bodyMd: '→ 正文（Markdown）',
        frontmatterExtra: '→ frontmatterExtra',
      },
    },
  },
  dependencyTree: {
    skills: '技能：{{names}}',
    mcps: 'MCP：{{names}}',
    plugins: '插件：{{names}}',
    readonly: '只读',
    writes: '可写',
    seeAbove: '↑ 见上',
    cycleHeading: '依赖闭包检测到环：',
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
        readonly: '只读',
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
      },
    },
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
  },
  settingsForm: {
    opencodePath: 'opencode 路径',
    opencodePathHint: '缺省走 PATH 上的 `which opencode`。',
    defaultModel: '默认 model',
    defaultModelHint: '没声明 model 的 agent 使用。',
    defaultVariant: '默认 variant',
    defaultTemperature: '默认 temperature',
    defaultSteps: '默认 steps',
    defaultStepsHint: '新建代理时默认填入此值；留空走 opencode 内置默认。',
    defaultMaxSteps: '默认 max steps',
    defaultMaxStepsHint: '新建代理时默认填入此值；留空走 opencode 内置默认。',
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
    labelGit: 'Git 包装器',
    labelLoop: '循环包装器',
    pillGit: '快照',
    pillLoop: '× {{max}} · {{kind}}',
    dropHere: '把节点拖到这里',
    fitToChildren: '自适应内部节点',
    unwrap: '解散包装器',
    deleteWithInner: '连同内部节点一起删除',
    confirmDeleteWithInner: '确定连同 {{count}} 个内部节点一起删除该包装器？此操作不可撤销。',
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
      submitDisabledRequired: '请先回答所有"推荐"题',
      draftSaving: '正在保存草稿…',
      draftSaved: '草稿已保存（关 tab 不丢）',
      recommendedChip: '推荐',
      back: '← 返回列表',
      answeredAt: '已回答 · {{time}}',
      askedAt: '提问于 {{time}}',
      keyboardHint: '快捷键：数字键 1–N 选择选项 · Enter 跳下一题 / 提交',
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
    status: {
      candidate: '候选',
      approved: '已批准',
      archived: '已归档',
      superseded: '已覆盖',
      rejected: '已驳回',
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
      section: {
        candidates: '本次生成的候选记忆',
        conversation: '提炼器对话',
        scope: '范围与去重快照',
        sourceEvents: '源事件',
      },
      sessionLoadError: '加载对话失败',
      sourceDeleted: '源已删除',
      stderrLabel: '子进程 stderr（截断）',
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
}

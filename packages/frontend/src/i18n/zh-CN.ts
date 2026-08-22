// P-5-03 stage 1: zh-CN resource bundle.
//
// Source of truth for the Chinese UI. Keep keys flat under top-level sections
// (nav / auth / settings / errors). Newer routes can add their own section as
// we migrate them to t() — there is no migration script, but the key tree
// matches en-US 1:1.

import type {
  RuntimeBuiltinName,
  WebhookTemplateVar,
  WorkgroupSystemTemplateKey,
} from '@agent-workflow/shared'
import { buildPermissionCatalogResources } from './permissionCatalog'

export interface Resources {
  permissions: ReturnType<typeof buildPermissionCatalogResources>
  tabBar: {
    scrollStart: string
    scrollEnd: string
  }
  // RFC-307 — rendering a capability's stage sequence as a flow.
  capabilityFlow: {
    kind: { program: string; script: string; ai: string; invoke: string }
    parallel: string
    agentSlot: string
    scriptSlot: string
    invokes: string
    noContract: string
    noContractHint: string
    staleContract: string
    empty: string
    loading: string
    requires: string
    produces: string
    terminal: string
    injectable: string
    injectableNone: string
  }
  intent: {
    title: string
    description: string
    newSession: string
    emptyTitle: string
    emptyDescription: string
    loadingMore: string
    columnTitle: string
    columnStatus: string
    columnRounds: string
    columnCommits: string
    columnUpdated: string
    statusArchived: string
    archiveAction: string
    reopenAction: string
    auditReadOnly: string
    archivedReadOnly: string
    startBuilding: string
    messageLabel: string
    messageHint: string
    messagePlaceholder: string
    hintLabel: string
    hintHint: string
    hintPlaceholder: string
    hintAuto: string
    hintAutoDescription: string
    modifyTargetNote: string
    buildWorkspace: string
    timeline: string
    roleUser: string
    roleAgent: string
    turnKind: {
      message: string
      answers: string
      'mount-approval': string
      running: string
      questions: string
      changeset: string
      error: string
    }
    opCount: string
    retryTurn: string
    failureDiagnostic: {
      genericSuggestion: string
      reason: Record<
        | 'output-cap-hit'
        | 'no-assistant-text'
        | 'terminal-without-envelope'
        | 'assistant-stopped-without-envelope'
        | 'runtime-shape-unknown',
        { title: string; suggestion: string }
      >
      observedRetained: string
      lastEvent: string
      terminalResult: string
      terminal: {
        success: string
        error: string
        'not-observed': string
      }
      notObserved: string
      unparsedStdout: string
      scratchRetained: string
      scratchRetainedUnknown: string
    }
    generating: string
    answerQuestions: string
    submitAnswers: string
    questionsAsked: string
    answersSubmitted: string
    answerSeparator: string
    mountApprovalSubmitted: string
    mountApproved: string
    mountRejected: string
    mountApprovalFirst: string
    mountSuggestionsTitle: string
    mountSuggestionsDescription: string
    mountSuggestionsReadOnly: string
    mountDecisionFor: string
    mountApprove: string
    mountReject: string
    mountCandidateUnavailable: string
    mountCandidateLabel: string
    mountCandidateFor: string
    mountCandidatePlaceholder: string
    mountBatchAtomic: string
    mountDecisionSubmit: string
    currentActionTitle: string
    currentActionDescription: string
    currentActionReadOnly: string
    currentActionAtomic: string
    currentActionSubmit: string
    mounts: string
    mountUnavailable: string
    mountUnavailableHint: string
    unmount: string
    workingContextEyebrow: string
    workingContextTitle: string
    workingContextCount: string
    workingContextMore: string
    workingContextEmpty: string
    workingContextManage: string
    workingContextDismiss: string
    workingContextQueue: string
    workingContextInterrupt: string
    workingContextSaveAndRun: string
    workingContextRunningHint: string
    workingContextFailed: string
    workingContextMounted: string
    workingContextRemoveHint: string
    workingContextDeltaSummary: string
    workingContextRetry: string
    workingContextState: {
      queued: string
      applying: string
      applied: string
      failed: string
      canceled: string
    }
    draftTitle: string
    draftStale: string
    draftStaleNotice: string
    blockingErrors: string
    commitDisabledStale: string
    commitDisabledValidation: string
    commitDisabledGenerating: string
    opCreate: string
    opUpdate: string
    openCommit: string
    commits: string
    commitState: {
      prepared: string
      applying: string
      committed: string
      failed: string
    }
    fromCopy: string
    composerSourceCurrent: string
    composerSourceCheckpoint: string
    composerSourceConversation: string
    composerRefineLabel: string
    composerContinueLabel: string
    composerRefinePlaceholder: string
    composerContinuePlaceholder: string
    iterationKeepsHistory: string
    refineDraft: string
    continueCheckpoint: string
    discardAndRegenerate: string
    returnToLatest: string
    checkpointReadyTitle: string
    checkpointReadyDescription: string
    draftHistory: string
    draftLifecycle: {
      current: string
      committed: string
      superseded: string
      discarded: string
    }
    composerLabel: string
    composerPlaceholder: string
    send: string
    cancelTurn: string
    rebase: string
    commitTitle: string
    commitSubmit: string
    commitPending: string
    commitBack: string
    commitNext: string
    commitStepsAria: string
    commitStep: {
      strategy: string
      details: string
      review: string
    }
    commitStrategyCreateOnly: string
    commitDetailsNone: string
    commitReviewSafety: string
    commitReviewResources: string
    commitReviewUpdates: string
    commitReviewDetails: string
    commitReviewDetailStatus: string
    commitSlotKind: {
      secret: string
      secretWaiver: string
      humanBinding: string
      finalName: string
    }
    commitDetailProvided: string
    commitDetailRequired: string
    commitDetailDefault: string
    commitGuard: {
      title: string
      busyBody: string
      stay: string
    }
    applyModeTitle: string
    applyModeHint: string
    applyModify: string
    applyCopy: string
    secretsTitle: string
    secretPlaceholder: string
    waiversTitle: string
    waiverLabel: string
    humansTitle: string
    humanLabel: string
    humanHint: string
    namesTitle: string
    nameHint: string
    namePlaceholder: string
    entryCreate: string
    entryModify: string
    entryModifyHint: string
    provenanceBadge: string
    addMount: string
    addMountTitle: string
    addMountSubmit: string
    addMountType: string
    addMountResources: string
    mountPickerLoading: string
    mountPickerEmpty: string
    mountPickerLoadFailed: string
    mountPickerUnresolved: string
    previewRawJson: string
    previewSideSwitch: string
    executionTitle: string
    executionEvents: string
    executionState: {
      live: string
      complete: string
      truncated: string
      incomplete: string
    }
    executionTruncatedNotice: string
    executionIncompleteNotice: string
    createLead: string
    draftSafety: string
    examplesLabel: string
    exampleWorkflow: string
    exampleWorkgroup: string
    exampleAgent: string
    recentSessions: string
    recentSessionsHint: string
    loadMore: string
    roundsCount: string
    commitsCount: string
    reviewWorkspace: string
    workspaceTabs: string
    draftPendingTitle: string
    draftPendingDescription: string
    opOutline: string
    opErrorsCount: string
    draftEmptyState: Record<
      'goal' | 'generating' | 'clarifying' | 'error' | 'applied' | 'archived',
      { title: string; description: string }
    >
    journey: {
      ariaLabel: string
      currentStage: string
      stageStatus: string
      archivedStageStatus: string
      goal: string
      generate: string
      review: string
      apply: string
      state: {
        generating: string
        clarifying: string
        'review-ready': string
        'review-blocked': string
        applying: string
        applied: string
        error: string
        'idle-active': string
        archived: string
      }
      reason: Record<
        | 'describe-goal'
        | 'generation-running'
        | 'working-set-queued'
        | 'working-set-applying'
        | 'working-set-failed'
        | 'draft-refining'
        | 'draft-regenerating'
        | 'generation-retrying'
        | 'answer-questions'
        | 'review-draft'
        | 'draft-stale'
        | 'draft-invalid'
        | 'apply-running'
        | 'generation-failed'
        | 'apply-failed'
        | 'applied'
        | 'checkpoint-ready'
        | 'archived',
        string
      >
    }
    previewBefore: string
    previewAfter: string
    previewWorkflowGraph: string
    previewNodeCount: string
    previewEdgeCount: string
    previewOpenCanvas: string
    previewCanvasDialogTitle: string
    previewCanvasHint: string
    previewCanvasUnavailable: string
    previewPromptDiff: string
    previewMembers: string
    previewLeader: string
    previewHumanPlaceholder: string
    previewBodyDiff: string
    previewFiles: string
    previewScriptBadge: string
    previewBeforeUnavailable: string
    resourceType: {
      agent: string
      skill: string
      mcp: string
      plugin: string
      workflow: string
      workgroup: string
    }
  }
  nav: {
    intent: string
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
    webhooks: string
    events: string
    code: string
    digitalEmployees: string
    executors: string
    employeeAssignments: string
    employeeOutcomes: string
    settings: string
    brand: string
    openMenu: string
    // RFC-032 PR1: home + group headers + runtime sub-item + settings gear.
    home: string
    group: {
      agents: string
      workflows: string
      digitalEmployees: string
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
        unlaunchable: string
        protocolIncompatible: string
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
    runtimeTest: {
      open: string
      title: string
      warningTitle: string
      warningBody: string
      loading: string
      runtime: string
      runtimeSummary: string
      runtimeLoadError: string
      runtimeUnavailable: string
      idleCountdown: string
      conversationRegion: string
      firstMessage: string
      nextMessage: string
      messagePlaceholder: string
      start: string
      starting: string
      saveAndStart: string
      useSaved: string
      send: string
      sending: string
      cancelTurn: string
      canceling: string
      endNow: string
      endConfirmTitle: string
      endConfirmBody: string
      endingHint: string
      endedHint: string
      dirtyBasis: string
      activeUsesSaved: string
      receiptReplaced: string
      draftChangedDuringSave: string
      turnOutcome: {
        failed: string
        canceled: string
        timedOut: string
        interrupted: string
        diagnostic: string
        noDiagnostic: string
      }
      status: {
        new: string
        running: string
        idle: string
        ending: string
        ended: string
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
    priorCommentsTitle: string
    priorCommentsCount_one: string
    priorCommentsCount_other: string
    priorCommentsEmpty: string
    priorCommentsUnanchored_one: string
    priorCommentsUnanchored_other: string
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
  apiDocs: {
    title: string
    subtitle: string
    intro: string
    quickStart: string
    quickStartBody: string
    connecting: string
    toolsHeading: string
    toolsIntro: string
    restHeading: string
    restIntro: string
    permissionsHeading: string
    permissionsIntro: string
    alwaysGrantedHeading: string
    alwaysGrantedIntro: string
    resourcesHeading: string
    resourcesIntro: string
    colTool: string
    colNeeds: string
    colDescription: string
    colMethod: string
    colPath: string
    colSummary: string
    colOperation: string
    colPermission: string
    needsNothing: string
    notAvailableToYou: string
  }

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
    copy: string
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
    patStatusActive: string
    patStatusRevoked: string
    // RFC-247 — token issuance. Replaces the RFC-036 `patGroup` / `patScope`
    // key trees, which described the hand-listed scope-group picker that
    // RFC-221 removed; the matrix derives its labels from the shared permission
    // catalog instead, so there is no per-point key tree to keep in sync.
    token: {
      create: string
      docsLink: string
      createTitle: string
      createdTitle: string
      nameHint: string
      matrixLabel: string
      cellLabel: string
      resource: {
        agents: string
        skills: string
        mcps: string
        plugins: string
        workflows: string
        workgroups: string
        tasks: string
        'scheduled-tasks': string
        repos: string
        memory: string
      }
      verb: {
        create: string
        update: string
        delete: string
        execute: string
      }
      purposeLabel: string
      purpose: { general: string; mcp_only: string }
      purposeHint: { general: string; mcp_only: string }
      templateLabel: string
      templateHint: string
      template: {
        'read-only': string
        'task-automation': string
        full: string
        custom: string
      }
      advanced: string
      advancedHint: string
      deleteWarningTitle: string
      deleteWarningDescription: string
      expiryLabel: string
      expiryHint: string
      expiry: { '30d': string; '90d': string; '365d': string; never: string }
      shownOnceTitle: string
      shownOnceDescription: string
      copied: string
      copyFailed: string
      markerClearFailed: string
      markerUnavailable: string
      inventoryRefreshFailed: string
      inventoryRefreshRetry: string
      inventoryRefreshing: string
      reconcileTitle: string
      reconcileRefresh: string
      reconcileDone: string
      reconcileWarningTitle: string
      reconcileWarningDescription: string
      reconcileInvalidMarker: string
      reconcileCandidatesTitle: string
      reconcileNoCandidates: string
      reconcileCandidateCount: string
      reconcileCandidateAction: string
      leaveTitle: string
      leaveRevealBody: string
      leaveUnknownBody: string
      leaveCreatingBody: string
      leaveStay: string
      leaveDiscard: string
      leaveForce: string
      leaveForceWarning: string
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
      manager: string
      user: string
      guest: string
    }
  }
  // RFC-036 — /users admin page.
  // RFC-312 —— 在线状态
  presence: {
    online: string
    offline: string
  }
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
    roleHint: string
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
      guest: string
      user: string
      admin: string
      manager: string
      guestDesc: string
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
  repoGroups: {
    tabLabel: string
    subtitle: string
    searchPlaceholder: string
    noMatchesDescription: string
    deleteTitle: string
    deleteBody: string
    deleteConflictBody: string
    deleteForce: string
    deleteReport: string
    tabAria: string
    newButton: string
    loading: string
    empty: string
    emptyDescription: string
    expandLayout: string
    collapseLayout: string
    columns: { name: string; repoCount: string; memories: string }
    editor: {
      createTitle: string
      editTitle: string
      name: string
      description: string
      addDescription: string
      pickRepo: string
      pickGroup: string
      refPlaceholder: string
      subdirPlaceholder: string
      readonly: string
      pendingImports: string
      emptyDirectory: string
      pendingRepo: string
      selectNode: string
      bulkAddRepos: string
      bulkDialogTitle: string
      cachedReposTab: string
      urlsTab: string
      bulkMode: string
      pasteUrls: string
      selectAllAttachments: string
      newDirectoryPlaceholder: string
      addDirectory: string
      addTo: string
      searchRepos: string
      selectVisibleRepos: string
      clearSelection: string
      addSelected: string
      pasteUrlsPlaceholder: string
      invalidUrlLines: string
      duplicateUrlsIgnored: string
      addUrls: string
      selectedCount: string
      batchApplied: string
      batchMoved: string
      markReadonly: string
      markWritable: string
      detach: string
      moveTo: string
      move: string
      validating: string
      finishDraftBeforeSave: string
      error: string
      layoutSummary: string
      settingsFor: string
      inherited: string
      inheritedFrom: string
      deleteSubtree: string
      deleteSubtreeTitle: string
      deleteSubtreeDescription: string
      deleteSubtreeConfirm: string
      directoryName: string
      parentDirectory: string
      attachRepo: string
      attachGroup: string
      attachedRepo: string
      attachedGroup: string
      ref: string
      subdir: string
    }
    layout: {
      rootMount: string
      subdirChip: string
      readonlyChip: string
      via: string
      empty: string
    }
  }
  code: {
    title: string
    subtitle: string
    journey: Record<string, unknown>
    employeePlaybook: Record<string, unknown>
    build: Record<string, unknown>
    executors: Record<string, unknown>
    control: {
      eyebrow: string
      headline: string
      description: string
      inbox: string
      outcomes: string
      startWork: string
      checking: string
      setupReady: string
      setupNeeded: string
      setupTitle: string
      unavailable: string
      readyCount: string
      actionNeeded: string
      employeeTitle: string
      employeeBody: string
      policyTitle: string
      policyBody: string
      assignmentTitle: string
      assignmentBody: string
      operationsTitle: string
      operationsBody: string
      readyMissions: string
    }
    operations: {
      eyebrow: string
      title: string
      subtitle: string
      allMissions: string
      attentionTitle: string
      attentionHint: string
      readyTitle: string
      readyHint: string
      noActiveTitle: string
      noActiveBody: string
      stageAria: string
      employeeFallback: string
      blockedReason: string
      awaitingInput: string
      missionUpdated: string
      missionUpdatedUnknown: string
      stage: Record<
        'intake' | 'develop' | 'publish' | 'care',
        {
          title: string
          body: string
          empty: string
        }
      >
    }
    outcomes: {
      title: string
      employeeTitle: string
      subtitle: string
      backToCode: string
      backToTasks: string
      showAll: string
      historyTitle: string
      historyHint: string
      emptyTitle: string
      emptyBody: string
      colMission: string
      colResult: string
      colEmployee: string
      colRepository: string
      colCompleted: string
      employeeFallback: string
      summaryAria: string
      summary: Record<
        'merged' | 'noChange' | 'closed' | 'failed',
        {
          title: string
          body: string
        }
      >
      capabilityTitle: string
      employeeSummaryTitle: string
      employeeSummaryOpen: string
      employeeSummaryHint: string
      employeeActive: string
      employeeReady: string
      employeeDelivered: string
    }
    tab: { matrix: string; activity: string; metrics: string; templates: string }
    config: {
      title: string
      subtitle: string
      technicalSubtitle: string
      kindSwitch: string
      kind: {
        employees: string
        actionTemplates: string
        verificationProfiles: string
        adapters: string
      }
      backToList: string
      colName: string
      colDetail: string
      colRevision: string
      colVisibility: string
      notPublished: string
      archived: string
      emptyTitle: string
      emptyBody: string
      create: string
      creating: string
      createTitle: string
      name: string
      capability: string
      purpose: string
      executableRef: string
      executableRefHint: string
      edit: string
      editTitle: string
      save: string
      saving: string
      publish: string
      publishing: string
      publishBlocked: string
      archive: string
      archiveTitle: string
      archiveBody: string
      acl: string
      draftJsonTitle: string
      draftJsonHint: string
      draftInvalidJson: string
      description: string
      promptSupplement: string
      promptHint: string
      employeeSummary: string
      routesTitle: string
      noRoutes: string
      colCapability: string
      colRules: string
      colFallback: string
      bindingsTitle: string
      defaultPolicy: string
      requirementSources: string
      pipelineProviders: string
      templateSummary: string
      executor: string
      verificationProfile: string
      retryDefaults: string
      retryText: string
      profileSummary: string
      stopPolicy: string
      noSteps: string
      colStep: string
      colProgram: string
      colTimeout: string
      colExitCodes: string
      adapterSummary: string
      operations: string
      executable: string
      connection: string
      secretProjection: string
      outputBudget: string
      budgetText: string
      timeout: string
      scriptsAuthorHint: string
      editor: {
        identitySection: string
        versionedRefHint: string
        resourceId: string
        revision: string
        routesHint: string
        routeNumber: string
        fallbackHint: string
        rulesPreserved: string
        addRoute: string
        requirementSourcesHint: string
        sourceNumber: string
        sourceKey: string
        adapterRef: string
        defaultSource: string
        addSource: string
        pipelineProvidersHint: string
        providerNumber: string
        providerKey: string
        addProvider: string
        executionSection: string
        capabilityLocked: string
        contractVersion: string
        executorKind: string
        agent: string
        workgroup: string
        workgroupRef: string
        runtimeProfile: string
        resourcesSection: string
        labels: string
        skills: string
        mcps: string
        readOnlyResources: string
        contextProfile: string
        writablePathPolicy: string
        protectedPathClasses: string
        sameSessionRetries: string
        freshSessionRetries: string
        verificationStrategy: string
        firstFailure: string
        collectAll: string
        maxParallel: string
        verificationStepsHint: string
        stepNumber: string
        argsRef: string
        networkProfile: string
        exitCodeInvalid: string
        evidenceSelectorsPreserved: string
        addStep: string
        adapterProgramSection: string
        operationsHint: string
        parameterSchema: string
        secretKeysHint: string
        outputBudgetHint: string
        maxFiles: string
        maxFileBytes: string
        maxTotalBytes: string
        advancedReadOnly: string
        advancedJson: string
        advancedJsonHint: string
        applyAdvanced: string
        applyAdvancedFirst: string
        draftMustBeObject: string
      }
    }
    assignments: {
      title: string
      description: string
      create: string
      empty: string
      dialogTitle: string
      globalScope: string
      repoRef: string
      groupRef: string
      publishedOnly: string
      warnEmployeeUnpublished: string
      warnPolicyUnpublished: string
      colScope: string
      colEmployee: string
      colSelectionPolicy: string
      colExecutionPolicy: string
      colSourceKey: string
      scope: {
        repository: string
        'repository-group': string
        'global-default': string
      }
    }
    missions: {
      title: string
      subtitle: string
      backToCode: string
      backToList: string
      launch: string
      launching: string
      launchTitle: string
      emptyTitle: string
      emptyBody: string
      colMission: string
      colStatus: string
      colRepository: string
      colSource: string
      colBlock: string
      colUpdated: string
      sourceDirect: string
      sourceExternal: string
      formKind: string
      kindBody: string
      kindUploads: string
      kindExternal: string
      formRepository: string
      pickRepository: string
      formEmployee: string
      employeeHint: string
      pickEmployee: string
      formTitle: string
      formBody: string
      formExternalId: string
      formSourceKey: string
      sourceKeyHint: string
      formUploads: string
      uploadsHint: string
      detailTitle: string
      retry: string
      blockTitle: string
      questionsTitle: string
      submitAnswers: string
      actionTitle: string
      actionOutcome: string
      actionCapability: string
      actionCandidate: string
      sourcesTitle: string
      refreshPreview: string
      refreshChanged: string
      refreshApply: string
      refreshUnchanged: string
      noSources: string
      colGeneration: string
      colRevision: string
      colState: string
      manifestTitle: string
      noManifest: string
      colFile: string
      colRole: string
      colBytes: string
      colActions: string
      viewFile: string
      effectsTitle: string
      noEffects: string
      colEffect: string
      colCreated: string
      collaborationTitle: string
      childMissionTitle: string
      collaborationPending: string
      childMissionCreating: string
      openChildMission: string
      approvalTitle: string
      openApproval: string
      approvalWaiting: string
      collaborationDeadline: string
      readinessTitle: string
      noReadiness: string
      handoff: string
      resume: string
      attachMr: string
      attachTitle: string
      attachHint: string
      attachMrIid: string
      attachEndpoint: string
      attachEndpointAuto: string
      attachProject: string
      attachProjectHint: string
      attachSubmit: string
      configOutdated: string
      configUpgradeHint: string
      timelineTitle: string
      timelineEmpty: string
      timelineDecision: string
      timelineEffect: string
      timelineExpand: string
      timelineCollapse: string
      evidenceTitle: string
      evidenceNone: string
      evidenceHead: string
      evidenceCollectedAt: string
      evidenceGatesTitle: string
      evidenceFilesTitle: string
      evidenceNoFiles: string
      evidenceUntrusted: string
      evidenceLoaded: string
      evidenceLoadMore: string
      colGate: string
      colRun: string
      status: Record<string, string>
      wizard: Record<string, string | Record<string, string>>
      guidance: Record<string, string>
      readiness: Record<string, string | Record<string, string>>
    }
    policies: {
      title: string
      subtitle: string
      backToCode: string
      backToList: string
      create: string
      createTitle: string
      createHint: string
      nameLabel: string
      namePlaceholder: string
      emptyTitle: string
      emptyBody: string
      colName: string
      colPublished: string
      colVisibility: string
      colUpdated: string
      draftOnly: string
      revisionN: string
      save: string
      saved: string
      publish: string
      publishNeedsSave: string
      neverPublished: string
      publishedAt: string
      violationsTitle: string
      tabRules: string
      tabSettings: string
      tabSimulate: string
      tabsLabel: string
      fixedGuardsTitle: string
      fixedGuardsHint: string
      actionRulesTitle: string
      selectionRulesTitle: string
      selectionRulesHint: string
      firstMatchHint: string
      noRules: string
      ruleId: string
      ruleIdPlaceholder: string
      capability: string
      employeeRef: string
      employeeRefPlaceholder: string
      moveUp: string
      moveDown: string
      predicatesN: string
      removeRule: string
      addRule: string
      addPredicate: string
      removePredicate: string
      predicateKind: string
      predicateFact: string
      predicateValue: string
      predicateOp: string
      predicateValuesPlaceholder: string
      predicateJson: string
      predicateJsonHint: string
      predicateJsonError: string
      requirementJson: string
      requirementJsonHint: string
      requirementJsonError: string
      secAdmission: string
      admissionDirect: string
      admissionExternal: string
      admissionDuplicate: string
      secFeedback: string
      feedbackClass: string
      feedbackBatch: string
      feedbackLatest: string
      secPipeline: string
      pipelineStale: string
      gateKey: string
      gateRequired: string
      gateDisposition: string
      gateCategories: string
      gateMaxReruns: string
      gateRemove: string
      gateAdd: string
      secConflict: string
      conflictMode: string
      conflictAttempts: string
      secDelivery: string
      deliveryPrefix: string
      deliveryCollision: string
      deliveryDraft: string
      deliveryHumanPush: string
      secVerification: string
      verificationProfiles: string
      verificationProfilesHint: string
      verificationStop: string
      secRetry: string
      retry_sameSessionRetries: string
      retry_freshSessionReruns: string
      retry_actionRunsPerMission: string
      retry_commitsPerMission: string
      retry_missionWallTimeMs: string
      secReadiness: string
      readinessGates: string
      readinessFeedback: string
      secNotification: string
      notificationOverview: string
      notificationEscalation: string
      secRetention: string
      retention_requirementBundleTerminalTtlDays: string
      retention_pipelineBundleTerminalTtlDays: string
      retention_attemptLedgerTtlDays: string
      secRequirement: string
      simGuards: string
      simGuardTerminal: string
      simGuardActiveAction: string
      simGuardUnsettled: string
      simGuardMrTerminal: string
      simGuardMode: string
      simGuardUploadSeed: string
      simCells: string
      simCellsHint: string
      simCellFact: string
      simCellValue: string
      simCellValuePlaceholder: string
      simCellRemove: string
      simCellAdd: string
      simRun: string
      simSelected: string
      simNoMatch: string
      simNoMatchHint: string
      simGuardTrace: string
      simRuleTrace: string
      simRuleTraceEmpty: string
      simMatched: string
      simMissed: string
      simSelectionTitle: string
      simSelectionEmployee: string
      simSelectionRun: string
    }
    flow: {
      capability: string
      hint: string
      sharedSlot: string
      agent: string
      agentNone: string
      prompt: string
      script: string
      scriptLanguage: string
      scriptRedacted: string
      scriptsRedactedChip: string
      params: string
      saveParams: string
      hooks: string
      noHooks: string
      hookPhase: string
      hookPre: string
      hookPost: string
      hookScript: string
      addHook: string
    }
    repoLabel: string
    repoHint: string
    load: string
    pickRepo: string
    noCapabilities: string
    noActivity: string
    noActivityHint: string
    enabled: string
    round: string
    roundPicker: string
    bulk: {
      open: string
      title: string
      repos: string
      reposHint: string
      capability: string
      template: string
      enabled: string
      preview: string
      apply: string
      undo_one: string
      undo_other: string
      failures_one: string
      failures_other: string
    }
    roundsHidden_one: string
    roundsHidden_other: string
    roundsShowMore: string
    templateLabel: string
    templateHint: string
    templateNone: string
    capability: {
      'mr-review': string
      'mr-comment-fix': string
      requirement: string
      'ci-fix': string
      'mr-monitor': string
    }
    templates: {
      newTemplate: string
      createAction: string
      nameLabel: string
      capabilityLabel: string
      slotLabel: string
      title: string
      hint: string
      none: string
      builtin: string
      scriptsHidden: string
      copy: string
      copiedFrom: string
      params: string
      slots: string
      backToList: string
      detailSubtitle: string
    }
    upstream: {
      title: string
      from: string
      state: {
        current: string
        'update-available': string
        conflicted: string
        orphaned: string
      }
      action: {
        'take-upstream': string
        'keep-local': string
        conflict: string
      }
      noBase: string
      merge_one: string
      merge_other: string
      merged: string
    }
    launch: {
      title: string
      hint: string
      notLaunchable: string
      repo: string
      repoNone: string
      reqTitle: string
      reqBody: string
      reqBodyHint: string
      mrIid: string
      mrIidHint: string
      discussionId: string
      discussionIdHint: string
      pipelineId: string
      submit: string
    }
    metrics: {
      empty: string
      emptyHint: string
      window: string
      adoptionTitle: string
      runsTitle: string
      capability: string
      published: string
      adopted: string
      quietFix: string
      disagreed: string
      outstanding: string
      rounds: string
      roundsPublished: string
      roundsFailed: string
      roundsAwaiting: string
      roundsIncomplete: string
    }
    attempts: {
      show: string
      hide: string
      none: string
      label: string
      openTask: string
    }
    readiness: { ready: string; misconfigured: string; disabled: string }
  }
  repos: {
    title: string
    pageTitle: string
    remoteTab: string
    operations: {
      subtitle: string
      viewAria: string
      views: { all: string; referenced: string; attention: string; unused: string }
      searchPlaceholder: string
      searchLabel: string
      filters: string
      activeFilters: string
      filterTitle: string
      submodulesLabel: string
      submodules: { all: string; with: string; without: string }
      autoRefreshLabel: string
      autoRefreshFilters: { all: string; refreshed: string; never: string }
      applyFilters: string
      noMatchesDescription: string
      columns: { repository: string; freshness: string; usage: string }
      branch: string
      fetched: string
      /** RFC-287 G7：仓库身份已登记但尚未克隆过（last_fetched_at=0 哨兵）。 */
      neverFetched: string
      autoRefresh: string
      referencingTasks: string
      loadMore: string
      loadingMore: string
    }
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
    webhookEndpoints: {
      eyebrow: string
      title: string
      add: string
      hint: string
      empty: string
      emptyDescription: string
      emptyReadonlyDescription: string
      enabled: string
      disabled: string
      enabledSwitch: string
      providerLabel: string
      lastDeliveryLabel: string
      neverDelivered: string
      noPublicBaseUrlTitle: string
      noPublicBaseUrl: string
      secretHint: string
      createSubmit: string
      createDescription: string
      copyUrl: string
      urlCopied: string
      copyFailed: string
      rotateSecret: string
      rotateConfirmTitle: string
      rotateConfirmDescription: string
      rotateConfirmAction: string
      deleteConfirm: string
      addTitle: string
      nameLabel: string
      namePlaceholder: string
      providerHintGitlab: string
      providerHintGithub: string
      protocolLabel: string
      protocolHint: string
      secretTitle: string
      secretOnceTitle: string
      secretDone: string
      secretOnce: string
      secretLabel: string
      copySecret: string
      secretCopied: string
      urlLabel: string
      urlMaskedHint: string
      secretPasteHintGitlab: string
      secretPasteHintGithub: string
    }
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
      codeHosts: string
      network: string
      appearance: string
      rendering: string
      authentication: string
    }
    cardGroups: {
      limitsBudgetsTitle: string
      limitsBudgetsHint: string
      limitsSharedRetryTitle: string
      limitsSharedRetryHint: string
      limitsConcurrencyTitle: string
      limitsConcurrencyHint: string
      limitsLoggingTitle: string
      limitsLoggingHint: string
      recoveryAutomationTitle: string
      recoveryAutomationHint: string
      recoverySafetyTitle: string
      recoverySafetyHint: string
      gitCheckoutTitle: string
      gitCheckoutHint: string
      gitAutoCommitTitle: string
      gitAutoCommitHint: string
      gitRefreshTitle: string
      gitRefreshHint: string
      gcWorktreesTitle: string
      gcWorktreesHint: string
      gcEventsTitle: string
      gcEventsHint: string
      gcRetentionTitle: string
      gcRetentionHint: string
      taskArchiveTitle: string
      diskReclaimTitle: string
      diskReclaimHint: string
      taskArchiveHint: string
      gcWebhooksTitle: string
      gcWebhooksHint: string
      networkListenerTitle: string
      networkListenerHint: string
      networkExternalTitle: string
      networkExternalHint: string
      appearanceDisplayTitle: string
      appearanceDisplayHint: string
      renderingServiceTitle: string
      renderingServiceHint: string
    }
    tabRuntime: string
    tabSystemAgents: string
    tabLimits: string
    tabRecovery: string
    tabGc: string
    tabGit: string
    tabCodeHosts: string
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
    numericOutOfRange: string
    numericDecimalOutOfRange: string
    numericRangeZeroOr: string
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
    diskRetiredStores: string
    diskNothingToReclaim: string
    diskFreelist: string
    diskCompactHint: string
    diskCleanup: string
    diskCleanupConfirmAction: string
    diskCleanupConfirmTitle: string
    diskCleanupConfirmBody: string
    taskArchiveRunNow: string
    taskArchiveScanning: string
    taskArchiveNothing: string
    taskArchiveConfirmTitle: string
    taskArchiveConfirmBody: string
    taskArchiveConfirmAction: string
    taskArchiveDone: string
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
    changeNarrativeRuntimeLabel: string
    changeNarrativeRuntimeHint: string
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
      narrativeTitle: string
      narrativeHint: string
      intentTitle: string
      intentHint: string
      intentRuntime: string
      intentRuntimeHint: string
      intentLang: string
      intentLangHint: string
      intentLangDefault: string
      intentTimeout: string
      intentTimeoutHint: string
      intentRounds: string
      intentRoundsHint: string
      intentExtra: string
      intentExtraHint: string
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
      oidcDefaultRoleLabel: string
      oidcDefaultRoleHint: string
      oidcDefaultRoleGuest: string
      oidcDefaultRoleUser: string
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
      discardTitle: string
      discardDescription: string
      discardKeepEditing: string
      discardConfirm: string
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
  resourcePackage: {
    importTitle: string
    file: string
    fileHint: string
    dropTitle: string
    chooseFile: string
    replaceFile: string
    removeFile: string
    replaceConfirmTitle: string
    replaceConfirmBody: string
    removeConfirmBody: string
    replaceAfterCommitConfirmBody: string
    removeAfterCommitConfirmBody: string
    replaceConfirmAction: string
    invalidFile: string
    reviewPackage: string
    previewing: string
    importing: string
    retryCurrentTitle: string
    retryCurrentBody: string
    repreviewRequiredTitle: string
    repreviewRequiredBody: string
    overwriteResetTitle: string
    overwriteResetBody: string
    previewExpiringTitle: string
    previewExpiringBody: string
    repreviewAction: string
    reviewTitle: string
    working: string
    emptyPackage: string
    commit: string
    finalName: string
    target: string
    notYours: string
    actionLabel: string
    chooseTarget: string
    chooseTargetHint: string
    secretsTitle: string
    secretFieldLabel: string
    secretRequiredHint: string
    secretOptionalHint: string
    skippedSecretsTitle: string
    rootMismatchTitle: string
    rootMismatchBody: string
    openImportedRoot: string
    permissionBlockedTitle: string
    permissionBlockedBody: string
    requirementsTitle: string
    requirementsHint: string
    requirement: {
      runtimes: string
      codeHosts: string
      executables: string
      pluginSources: string
      projectSkills: string
      mcpKinds: string
      humanMembers: string
    }
    humanMappingsTitle: string
    humanMappingsHint: string
    humanRequired: string
    humanOptional: string
    humanSource: string
    humanMap: string
    humanSkip: string
    humanActionLabel: string
    humanTarget: string
    humanTargetPlaceholder: string
    humanTargetRequired: string
    humanSkipped: string
    secretsNotice_one: string
    secretsNotice_other: string
    importedCount_one: string
    importedCount_other: string
    completeTitle: string
    completeSummary: string
    importAnother: string
    createMethod: string
    createManually: string
    createMethodHint: string
    exportPackage: string
    exporting: string
    exportHint: string
    saveBeforeExport: string
    type: {
      agent: string
      skill: string
      mcp: string
      plugin: string
      workflow: string
      workgroup: string
    }
    appliedAction: {
      create: string
      update: string
    }
    action: {
      new: string
      reuse: string
      overwrite: string
    }
  }
  common: {
    pagination: {
      aria: string
      prev: string
      next: string
      pageOf: string
      jumpFormAria: string
      jumpLabel: string
      jumpAction: string
      jumpActionAria: string
    }
    range: string
    rangeZeroOr: string
    rangeMaxOnly: string
    rangeConverted: string
    done: string
    searchEllipsis: string
    searchCards: string
    noMatches: string
    noAvailableOptions: string
    allOptionsUnavailable: string
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
    remove: string
    deleteResourceActionHint: string
    save: string
    saved: string
    saving: string
    creating: string
    unknownError: string
    resumeFailedAfterSubmit: string
    yes: string
    no: string
    details: string
    more: string
    moreActions: string
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
  unit: {
    hour_one: string
    hour_other: string
    minute_one: string
    minute_other: string
    second_one: string
    second_other: string
    year_one: string
    year_other: string
    day_one: string
    day_other: string
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
    unsavedSaveAndProceed: string
    unsavedSaveFailed: string
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
    launchTitle: string
    launchHint: string
    profileTitle: string
    profileHint: string
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
    fieldExtraArgs: string
    fieldExtraArgsHint: string
    fieldIsSandbox: string
    fieldIsSandboxHint: string
    configDirEnvInvalid: string
    configDirEnvReserved: string
    configDirNameInvalid: string
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
    versionSourceImport: string
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
      resourcesInvalid: string
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
    copying: string
    copyActionHint: string
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
    sectionOutputContract: string
    fieldOutputContract: string
    outputContractFiles: string
    outputContractFilesHint: string
    outputContractDiscussion: string
    outputContractDiscussionHint: string
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
    systemMessages: Record<WorkgroupSystemTemplateKey, string>
    // RFC-164 PR-4 — workgroup task chat room (tasks.detail default tab).
    room: {
      empty: string
      roundDivider: string
      authorSystem: string
      replyingTo: string
      openReferencedMessage: string
      referencedMessageUnavailable: string
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
  webhooksPage: {
    title: string
    subtitle: string
    tabAria: string
    forbiddenTitle: string
    forbiddenDescription: string
    tabs: { endpoints: string; triggers: string; deliveries: string }
  }
  runtimeParameters: {
    insert: string
    insertFor: string
    back: string
    categoryAria: string
    categoryCount: string
    openCategory: string
    selectEventsFirst: string
    invalidLocalParameter: string
    search: string
    noMatches: string
    inserted: string
    stale: string
    unavailable: string
    invalidJsonTarget: string
    replaceWholeValue: string
    optionalWebhook: string
    scope: { global: string; local: string }
    type: { trigger: string; runtime: string; node: string; context: string }
    source: { webhook: string; task: string; currentNode: string; review: string }
    group: {
      webhookContext: string
      webhookApi: string
      repository: string
      identity: string
      iteration: string
      review: string
      clarify: string
      input: string
    }
    webhookLabels: Record<WebhookTemplateVar, string>
    builtins: Record<RuntimeBuiltinName, { label: string; agent: string; workgroup?: string }>
    localInputLabel: string
    localInputDescription: string
    reviewCommentsLabel: string
    reviewCommentsDescription: string
  }
  webhookTriggers: {
    eyebrow: string
    title: string
    subtitle: string
    new: string
    empty: string
    emptyDescription: string
    emptyReadonlyDescription: string
    ownerLabel: string
    ownedByMe: string
    enabledChip: string
    disabledChip: string
    corruptBadge: string
    scopeAll: string
    scopeExact: string
    scopePrefix: string
    enabledSwitch: string
    firesButton: string
    deleteConfirm: string
    dialogCreate: string
    dialogEdit: string
    firesTitle: string
    firesEmpty: string
    resetCircuit: string
    eventCount: string
    terminalProtectionChip: string
    flowAria: string
    saveAction: string
    commonOnlySaveAction: string
    historyActions: string
    undo: string
    redo: string
    historyCompositionBlocked: string
    discardTitle: string
    discardDescription: string
    discardAction: string
    columns: { name: string; rule: string; target: string; state: string }
    kinds: {
      workflow: string
      agent: string
      workgroup: string
      'digital-employee': string
    }
    kindDescriptions: {
      workflow: string
      agent: string
      workgroup: string
      'digital-employee': string
    }
    spaces: { eventRepo: string; scratch: string }
    spaceDescriptions: { eventRepo: string; scratch: string }
    inputKinds: { text: string; files: string; enum: string; git: string; upload: string }
    last: { launched: string; failed: string }
    outcomes: {
      launched: string
      'launch-failed': string
      'skipped-circuit-open': string
      'skipped-repo-unregistered': string
      'skipped-owner-invalid': string
      'skipped-trigger-disabled': string
      'skipped-mr-stream-closed': string
      'skipped-mr-stream-merged': string
      'skipped-mr-stream-terminal': string
      'skipped-mr-stream-identity-missing': string
      'skipped-trigger-invalid': string
      'skipped-legacy-admission-frozen': string
    }
    flow: { scope: string; events: string; target: string }
    steps: { scope: string; events: string; target: string; review: string }
    stepLeads: { scope: string; events: string; target: string; review: string }
    review: {
      endpoint: string
      scope: string
      events: string
      terminalProtection: string
      terminalProtectionOn: string
      terminalProtectionOff: string
      target: string
      space: string
      separator: string
      safetyNote: string
    }
    events: {
      push: string
      tag_push: string
      mr_opened: string
      mr_updated: string
      mr_merged: string
      mr_closed: string
      note: string
      pipeline_failed: string
      pipeline_succeeded: string
      issue_labeled: string
      issue_comment: string
    }
    scope: { all: string; prefix: string; exact: string; exactPlaceholder: string }
    fields: {
      name: string
      endpoint: string
      endpointPlaceholder: string
      endpointImmutable: string
      scope: string
      scopeHint: string
      events: string
      cancelOnMrTerminal: string
      cancelOnMrTerminalLabel: string
      cancelOnMrTerminalHint: string
      cancelOnMrTerminalError: string
      eventsHint: string
      pipelineException: string
      branchFilter: string
      branchFilterHint: string
      commandPrefix: string
      commandPrefixHint: string
      ignoreUsernames: string
      ignoreUsernamesHint: string
      launchKind: string
      kindImmutable: string
      target: string
      targetPlaceholder: string
      executionSpace: string
      workingBranchTemplateHint: string
      scratchNotice: string
      inputMappings: string
      inputMappingsHint: string
      inputMappingsScratchHint: string
      noInputs: string
      eventBranch: string
      templatePlaceholder: string
      unmappable: string
      description: string
      goal: string
      employeeUnsupportedTitle: string
      employeeUnsupportedBody: string
      agentDescriptionHint: string
      agentInputHint: string
      agentInputListHint: string
      agentLoading: string
      agentRefreshing: string
      agentDefinitionChangedTitle: string
      agentDefinitionChangedBody: string
      agentApplyDefinition: string
      agentUnavailableTitle: string
      agentUnavailableBody: string
      agentOpaqueSummary: string
      agentCommonOnly: string
      retryAgent: string
      agentRepairsTitle: string
      agentRepairsBody: string
      agentRepairAction: string
      agentBlockersTitle: string
      agentBlockersBody: string
      agentIssueDescriptionRequired: string
      agentIssueDescriptionTooLong: string
      agentIssueRequiredInputs: string
      agentTargetSwitchTitle: string
      agentTargetSwitchDescription: string
      agentTargetSwitchAction: string
      templateVarsLabel: string
      /** RFC-263：变量表 13→30 后按两组呈现。 */
      varGroupContext: string
      varGroupApi: string
      /**
       * RFC-263：每个变量的悬停说明。Record 而非逐条声明 —— 新增变量时漏写说明
       * 会在 typecheck 期变红，而不是在 UI 上显示一个空 title。
       */
      vars: Record<WebhookTemplateVar, string>
      maxFires: string
      maxFiresHint: string
      autoRegister: string
      autoRegisterLabel: string
    }
    firesColumns: {
      stream: string
      outcome: string
      result: string
      task: string
      employeeCase: string
      time: string
    }
  }
  webhookDeliveries: {
    eyebrow: string
    title: string
    subtitle: string
    filterAria: string
    empty: string
    emptyDescription: string
    filteredEmpty: string
    filteredEmptyDescription: string
    totalCount: string
    filterAll: string
    filterAllEvents: string
    filterAllRepos: string
    filterEventAria: string
    filterRepoAria: string
    filtersLabel: string
    filterEventLabel: string
    filterRepoLabel: string
    replay: string
    replayBadge: string
    replaySuccess: string
    rejectedNotReplayable: string
    detailTitle: string
    bodyPruned: string
    columns: { event: string; repo: string; status: string; time: string }
    detail: {
      status: string
      event: string
      repo: string
      received: string
      uuid: string
      stream: string
      payload: string
    }
    terminalControl: {
      title: string
      kind: string
      status: string
      revision: string
      targets: string
      hiddenTargets: string
      targetTable: string
      task: string
      cancel: string
      release: string
      workspace: string
      kinds: Record<'fence-closed' | 'fence-merged' | 'clear-closed', string>
      statuses: Record<
        'pending' | 'leased' | 'waiting-launches' | 'retryable' | 'succeeded',
        string
      >
      cancelOutcomes: Record<'canceled' | 'already-terminal' | 'not-applicable', string>
      releaseOutcomes: Record<'pending' | 'no-active-owner' | 'released' | 'unreaped', string>
      workspaceStates: Record<'retained' | 'pruning' | 'pruned', string>
    }
    statuses: {
      received: string
      processing: string
      rejected: string
      ignored: string
      matched: string
      failed: string
    }
    reasons: {
      'invalid-token': string
      'missing-token': string
      'endpoint-disabled': string
      'no-trigger-matched': string
      'unsupported-event': string
      'parse-failed': string
      'internal-error': string
      interrupted: string
      'terminal-control-accepted': string
      'mr-stream-identity-missing': string
    }
  }
  scheduled: {
    repairBadge: string
    title: string
    operations: {
      subtitle: string
      viewAria: string
      views: { all: string; enabled: string; attention: string; paused: string }
      searchPlaceholder: string
      searchLabel: string
      filters: string
      activeFilters: string
      filterTitle: string
      launchKindLabel: string
      launchKinds: { all: string; workflow: string; workgroup: string; agent: string }
      outcomeLabel: string
      outcomes: { all: string; never: string; launched: string; failed: string }
      applyFilters: string
      noMatchesDescription: string
      columns: { schedule: string; state: string; next: string }
    }
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
    runNowBlocked: {
      'migration-needed': string
      'payload-missing': string
      'spec-missing': string
    }
    runNowUnknownTitle: string
    runNowUnknownBody: string
    runNowUnknownInspect: string
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
      'code-round': string
    }
    /** RFC-243 PR-5: child-task nesting on /tasks + detail call-node links.
     *  scopeFilter toggles the flat `include_children=true` listing; the
     *  expand/collapse pair labels the lazy per-parent children loader;
     *  parentTask* is the flat-mode badge (link ↔ neutral degrade when the
     *  parent is not visible to the viewer); childTask* is the detail-page
     *  call node_run jump link (+ its deleted/invisible placeholder). */
    scopeFilter: {
      top: string
      all: string
    }
    scopeFilterAria: string
    expandChildren: string
    collapseChildren: string
    expandChildrenCount: string
    noChildTasks: string
    childBadge: string
    parentTaskChip: string
    parentTaskUnavailable: string
    /** RFC-245: node-runs table entry into the drawer for call rows. */
    runDetailButton: string
    childTaskLink: string
    childTaskUnavailable: string
    /** RFC-244: dense task operations list. */
    operations: {
      subtitle: string
      updated: string
      refresh: string
      viewAria: string
      views: { all: string; active: string; attention: string; finished: string }
      searchPlaceholder: string
      searchLabel: string
      filters: string
      activeFilters: string
      filterTitle: string
      statuses: string
      statusPlaceholder: string
      scopeLabel: string
      scope: { mine: string; shared: string; all: string }
      originLabel: string
      origin: {
        all: string
        manual: string
        scheduled: string
        event: string
        webhook: string
        api: string
      }
      categoryLabel: string
      category: { all: string; orchestration: string; 'digital-employee': string }
      digitalEmployeeSection: string
      digitalEmployeeSectionHint: string
      digitalEmployeeTask: string
      digitalEmployeeOwner: string
      applyFilters: string
      resultCount: string
      addedCount: string
      addedChildrenCount: string
      columns: { task: string; execution: string; time: string }
      loadMore: string
      loadingMore: string
      loadMoreChildren: string
      loadingMoreChildren: string
      childCount: string
      openAlertDetail: string
      contextMatches: string
      awaitingReview: string
      awaitingHuman: string
      pendingDetail: string
      runningDetail: string
      finishedDetail: string
      duration: { queued: string; running: string; accumulated: string }
    }
    detailTitleIdLabel: string
    webhookSource: {
      comment: string
      mergeRequest: string
      issue: string
      pipeline: string
      commit: string
      project: string
    }
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
    commitOutcomeSkippedExcluded: string
    commitOutcomeExcludedHistory: string
    subrepoPushed: string
    subrepoNotPushed: string
    commitOutcomeSkippedEmpty: string
    commitExclusions: string
    commitExclusionsHistory: string
    commitFiles: string
    metaStarted: string
    metaFinished: string
    metaError: string
    /** RFC-066: multi-repo summary `<details>` label on the task detail page. */
    multiRepoSummary: string
    /** RFC-248: 任务详情的组溯源 chip / 只读成员 chip。 */
    repoGroupChip: string
    repoReadonlyChip: string
    repoReadonlyDirty: string
    repoReadonlyDirtyBanner: string
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
    /**
     * RFC-287 G7：卡在**仓库准备**的失败。与「工作区已回收」在 status/worktreePath
     * 上同形，但下一步动作完全相反——该重试准备那一步，而不是另起一个任务。
     */
    resumeRepoPrepFailed: string
    /** RFC-287 AC-11：横幅自带的「重试准备仓库」动作——准备行画不到画布上，
     *  这是它唯一的重试入口。 */
    /** RFC-287 G7：合成的「准备仓库」第 0 步在节点表里的显示名。 */
    repoPrepStepName: string
    retryRepoPrep: string
    retryRepoPrepPending: string
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
    workspacePruning: string
    workspacePruned: string
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
    tabChanges: string
    changesEmptyScratch: string
    changesEmptyNoChanges: string
    changesStructuralUnavailable: string
    changesGroupCode: string
    changesGroupMiscCode: string
    changesGroupDeps: string
    changesGroupDocs: string
    changesGroupConfig: string
    changesGroupMoves: string
    changesGroupOther: string
    changesGroupCount: string
    changesSummaryLine: string
    changesDrillGraph: string
    changesDrillImpact: string
    changesDrillCallChain: string
    changesDrillDeps: string
    changesDrillFocusAll: string
    changesDrillFocusFile: string
    changesDrillFocusGroup: string
    changesDrillFocusLabel: string
    changesNarrativeGenerate: string
    changesNarrativeGenerating: string
    changesNarrativeFailed: string
    changesNarrativeRetry: string
    changesNarrativeRegenerate: string
    changesNarrativeStale: string
    changesRenamedFrom: string
    changesJumpToHunk: string
    changesImportsAggregated: string
    changesContainerCollapsed: string
    changesTopLevelGroup: string
    changesOutlineTitle: string
    changesOutlineExpand: string
    changesOutlineCollapse: string
    changesDrillBackToGraph: string
    changesNarrativeTitle: string
    codeViewerOversized: string
    codeViewerBinary: string
    codeViewerGone: string
    codeViewerMissing: string
    codeViewerOutsideDiff: string
    codeViewerFoldedLines: string
    codeIntelMenuLabel: string
    codeIntelLoading: string
    codeIntelEngineDeep: string
    codeIntelEngineBaseline: string
    codeIntelDegraded: string
    codeIntelNoResult: string
    codeIntelDefinitions: string
    codeIntelReferences: string
    codeIntelRefsGuessed: string
    codeIntelInferred: string
    codeIntelTruncated: string
    codeIntelError: string
    codeNavBack: string
    changesCodeViewHunk: string
    changesCodeViewFull: string
    changesCodeViewLabel: string
    fileSymbolsIncomplete: string
    structOpenSource: string
    drillSourceClose: string
    drillSourceSymbolMissing: string
    changesPureMove: string
    changesTextUnavailable: string
    changesDocRendered: string
    changesDocText: string
    changesDocViewLabel: string
    changesDocLoading: string
    changesDocFallback: string
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
    /** RFC-304: fourth subject kind — one round of a code capability. */
    codeRoundBadge: string
    /** RFC-304: subject text for a code-round row (no link until /code exists). */
    codeRoundSubject: string
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
    copying: string
    copyActionHint: string
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
      /** RFC-243 — Calls category (call-workflow). */
      categoryCalls: string
      categoryIntegrations: string
      categoryScripts: string
      categoryIo: string
      categoryHuman: string
      noMatches: string
      resultsCount: string
      resultsCountInCategory: string
      dragHint: string
      /** RFC-270 —— 特权节点条目被置灰时的原因，带上所需权限点名字。 */
      requiresPermission: string
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
    /** RFC-243 — Calls palette section + call-workflow entry. */
    /** RFC-253 — Scripts section (deterministic compute, no model). */
    paletteScripts: string
    paletteCodeHostLabel: string
    paletteCodeHostDesc: string
    paletteIntegrations: string
    paletteScriptLabel: string
    paletteScriptDesc: string
    paletteCalls: string
    paletteCallWorkflowLabel: string
    paletteCallWorkflowDesc: string
    /** RFC-243 PR-4 — call-workgroup entry (Calls section). */
    paletteCallWorkgroupLabel: string
    paletteCallWorkgroupDesc: string
    menuPaste: string
    menuSelectAll: string
    menuDuplicate: string
    menuCopy: string
    menuWrapGit: string
    menuWrapLoop: string
    menuDecompose: string
    boxSelectHint: string
    layoutToolbar: string
    canvasToolbar: string
    canvasAdd: string
    cameraViewFullGraph: string
    cameraReturnReadable: string
    cameraFocusSelection: string
    layoutAll: string
    layoutSelection: string
    menuSelectedCount: string
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
      /** RFC-270 —— author 门 403 的专属横幅（与「保存失败」区分）。 */
      authorForbiddenTitle: string
      authorForbiddenBody: string
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
    kindDigitalEmployee: string
    kindHintWorkflow: string
    kindHintAgent: string
    kindHintWorkgroup: string
    kindHintDigitalEmployee: string
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
    /** RFC-248 仓库组空间 */
    spaceGroupChip: string
    spaceReplayChip: string
    spaceReplaySummary: string
    spaceReplayHint: string
    spaceGroupChange: string
    spaceGroupSummary: string
    spaceGroupRepoCount: string
    spaceGroupLayoutTitle: string
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
    draftStorageUnavailable: string
    draftTooLarge: string
    draftExpired: string
    draftInvalid: string
    draftCollaboratorsChanged: string
    draftSourceChanged: string
    draftWriteFailed: string
    draftReadFailed: string
    draftReadRetry: string
    draftReentryTitle: string
    draftReentryBody: string
    draftRecoveryTitle: string
    draftRecoveryBody: string
    draftRecoveryUnknownBody: string
    draftRestore: string
    draftDiscard: string
    outcomeUnknownTitle: string
    outcomeUnknownBody: string
    outcomeUnknownInspect: string
    outcomeUnknownFinish: string
    unnamedTask: string
    unsavedTitle: string
    unsavedBody: string
    unsavedUnknownBody: string
    unsavedBusyBody: string
    unsavedStay: string
    unsavedDiscard: string
    unsavedForceLeave: string
    unsavedForceLeaveWarning: string
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
      overwriteHint: string
      duplicateName: string
    }
    repoSource: {
      bar: string
      path: string
      url: string
      urlField: string
      urlHint: string
      spaceField: string
      spaceHint: string
      urlPlaceholder: string
      urlInvalid: string
      refField: string
      refHint: string
      refPlaceholder: string
      recentUrlsPlaceholder: string
      spacePlaceholder: string
      manualUrlOption: string
      /** RFC-248: 下拉里的仓库组条目标签 */
      groupOption: string
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
    enum: {
      choices: string
      choicesHint: string
      choicesPlaceholder: string
      multiSelect: string
      allowOther: string
    }
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
      onConflict: string
      onConflictHint: string
      onConflictRename: string
      onConflictOverwrite: string
    }
    fieldJoinMode: string
    fieldJoinModeHint: string
    joinModeAny: string
    joinModeAll: string
    fieldNodeTitle: string
    fieldNodeTitleHint: string
    fieldReviewDescription: string
    fieldReviewDescriptionHint: string
    fieldReviewInputSourceNode: string
    fieldReviewInputSourceNodeHint: string
    fieldReviewInputSourcePort: string
    fieldReviewInputSourcePortHint: string
    fieldReviewGuideReadyTitle: string
    fieldReviewGuideReadyBody: string
    fieldReviewGuideEmptyTitle: string
    fieldReviewGuideEmptyBody: string
    fieldReviewGuideUnavailableTitle: string
    fieldReviewGuideUnavailableBody: string
    fieldReviewGuideInvalidTitle: string
    fieldReviewGuideInvalidBody: string
    fieldReviewConfigureAgentOutputs: string
    fieldReviewSourceNonAgent: string
    fieldReviewSourceAgentMissing: string
    fieldReviewSourceNoMarkdown: string
    fieldReviewSourceAvailable: string
    fieldReviewSourceCount: string
    fieldReviewPortSingle: string
    fieldReviewPortMulti: string
    fieldReviewPortUnsupported: string
    fieldReviewModeSingle: string
    fieldReviewModeMulti: string
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
    fieldContinueOnMaxIterations: string
    fieldContinueOnMaxIterationsHint: string
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
    openReferencedResource: string
    openReferencedResourceAria: string
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
    sectionReviewInput: string
    sectionAdvanced: string
    sectionTechnical: string
    missingRefsLabel: string
    missingRefsHint: string
    invalidRefsLabel: string
    invalidRefsHint: string
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
    // RFC-243 call-workflow node inspector
    fieldCallWorkflow: string
    fieldCallWorkflowHint: string
    pickCallWorkflow: string
    callWorkflowNoRef: string
    /** Neutral same-shape placeholder — invisible and deleted references are
     *  indistinguishable by design (no existence leak). */
    callWorkflowRefUnavailable: string
    callWorkflowPortsPreview: string
    callWorkflowPortsPreviewHint: string
    callWorkflowChildInputs: string
    callWorkflowChildOutputs: string
    fieldCallMaxDurationMs: string
    fieldCallMaxDurationMsHint: string
    fieldCallMaxTotalTokens: string
    fieldCallMaxTotalTokensHint: string
    // RFC-243 PR-4 call-workgroup node inspector
    fieldCallWorkgroup: string
    fieldCallWorkgroupHint: string
    pickCallWorkgroup: string
    fieldCallGoalTemplate: string
    fieldCallGoalTemplateHint: string
    /** Read-only line for the FIXED `result` output port. */
    callWorkgroupResultInfo: string
  }
  promptPreview: {
    mockTitle: string
    noPorts: string
    assembledTitle: string
    webhookSample: string
    webhookSampleHint: string
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
    resourceValidationBadge: string
    resourceValidationTitle: string
    resourceLaunchBlocked: string
    resourceStatusLoadFailed: string
    resourceKind: {
      skill: string
      mcp: string
      plugin: string
      agent: string
    }
    resourceMissingLabel: string
    resourceHiddenLabel: string
    resourceUnavailableLabel: string
    resourceLoadingLabel: string
    resourceDirectIssue: string
    resourceClosureIssue: string
    resourceHiddenAgent: string
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
        branch: string
        managed: string
        managedHint: string
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
      fieldBranch: string
      fieldBranchToggle: string
      fieldBranchHint: string
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
    fieldExecutionContracts: string
    fieldExecutionContractsHint: string
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
    runtimeLoading: string
    runtimeLoadFailed: string
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
    outputBranchClosed: string
    outputBranchClosedNoReason: string
    outputBranchClosedReason: string
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
      loadFailed: string
      faceUnobservable: string
      fieldUnobservable: string
      chip: { agents: string; skills: string; mcps: string; plugins: string; tools: string }
      subtitle: { agents: string; skills: string; mcps: string; plugins: string; tools: string }
      provenance: { injected: string; ambient: string; declaredMissing: string }
      col: {
        name: string
        provenance: string
        mode: string
        model: string
        source: string
        path: string
        description: string
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
        'runtime-has-no-inventory': string
        'no-observation-recorded': string
        'no-init-event': string
        'inventory-not-read': string
        'session-reused': string
      }
    }
    startupVerification: {
      title: string
      mcpUnusable: string
      skillsMissing: string
      subagentsMissing: string
      toolsMissing: string
      skippedDisabled: string
      droppedParams: string
      outputTailTruncated: string
      unsupported: string
      unobservable: string
      unavailable: string
      malformed: string
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
    taskCommitExcludePatterns: string
    taskCommitExcludePatternsHint: string
    taskCommitExcludePatternsError: string
    mergeAgentRuntime: string
    mergeAgentRuntimeHint: string
    maxConcurrentNodes: string
    maxConcurrentNodesHint: string
    maxConcurrentScriptNodes: string
    maxConcurrentScriptNodesHint: string
    multiProcessConc: string
    multiProcessConcHint: string
    maxConcurrentCodeHostCalls: string
    maxConcurrentCodeHostCallsHint: string
    maxActiveChildTasks: string
    maxActiveChildTasksHint: string
    maxInvocationDepth: string
    maxInvocationDepthHint: string
    logLevel: string
    logLevelHint: string
    perTaskDuration: string
    perTaskTokens: string
    perNodeTimeout: string
    nodeRetries: string
    nodeRetriesHint: string
    sessionRestartBudget: string
    sessionRestartBudgetHint: string
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
    periodicOrphanReconcileHint: string
    zeroDisabled: string
    largeOutputThreshold: string
    zeroUnlimited: string
    autoGcLabel: string
    webhookTaskWorkspaceAutoCleanup: string
    webhookTaskWorkspaceAutoCleanupHint: string
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
    submoduleRefreshIntervalHint: string
    submoduleOnlyRecentDays: string
    submoduleOnlyRecentDaysHint: string
    autoGcHint: string
    olderThanDays: string
    onlyMerged: string
    archivePerNodeRun: string
    archivePerNodeRunHint: string
    archiveGlobal: string
    archiveGlobalHint: string
    archivePerNodeRunBytes: string
    archivePerNodeRunBytesHint: string
    archiveGlobalBytes: string
    archiveGlobalBytesHint: string
    backupProtectedKeepCount: string
    backupProtectedKeepCountHint: string
    eventStreamRetentionDays: string
    eventStreamRetentionDaysHint: string
    webhookTriggerFiresRetentionDays: string
    webhookTriggerFiresRetentionDaysHint: string
    taskArchiveEnabled: string
    taskArchiveRetentionDays: string
    taskArchiveRetentionDaysHint: string
    webhookBodyRetention: string
    webhookBodyRetentionHint: string
    webhookRowRetention: string
    webhookRowRetentionHint: string
    bindHost: string
    bindHostHint: string
    bindPort: string
    bindPortHint: string
    bindPortCurrent: string
    bindPortUseCurrent: string
    mcpSurfaceLabel: string
    mcpSurfaceHint: string
    mcpSurfaceDocsLink: string
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
    /** RFC-270 —— 拖动 wrapper 会改变特权节点归属时的提示。 */
    privilegedMembershipBlocked: string
    /** RFC-270 —— 中央守卫拒绝了一次会改变特权节点执行面的本地编辑。 */
    privilegedScriptChangeBlocked: string
    privilegedCodeHostChangeBlocked: string
    layoutCrossScope: string
    layoutCycles: string
    layoutLockedOverflow: string
  }
  /** Canvas chip label for review nodes (⚖ icon). */
  reviewNode: {
    label: string
    sourceUnset: string
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
  /** RFC-243 — canvas chip label + unset-reference line for call-workflow
   *  nodes (⧉ icon). */
  callWorkflowNode: {
    label: string
    unsetWorkflow: string
  }
  /** RFC-243 PR-4 — canvas chip label + unset-reference line for
   *  call-workgroup nodes (⬡ icon). */
  codeHostSettings: {
    baseUrl: string
    baseUrlHint_gitlab: string
    baseUrlHint_github: string
    repositoryUrlPrefixes: string
    repositoryUrlPrefixesHint: string
    repositoryUrlPrefixesPlaceholder: string
    repositoryUrlPrefixInvalid: string
    token: string
    tokenHint: string
    tokenStored: string
    rejectUnauthorized: string
    rejectUnauthorizedHint: string
    test: string
    testOk: string
    testFailed: string
    testCode_unauthorized: string
    'testCode_not-found': string
    testCode_unreachable: string
    'testCode_bad-response': string
    loading: string
    intro: string
  }
  codeRoundNode: {
    label: string
    notEditable: string
    capabilityHint: string
  }
  codeCapability: {
    mr_review: string
    mr_comment_fix: string
    requirement: string
    ci_fix: string
    mr_monitor: string
  }
  codeHostNode: {
    label: string
    destructive: string
    unsupported: string
  }
  codeHostProvider: {
    gitlab: string
    github: string
  }
  codeHostActionGroup: {
    comment: string
    mr: string
    pipeline: string
    read: string
    custom: string
  }
  codeHostAction: {
    'comment_reply-thread': string
    comment_create: string
    'comment_create-inline': string
    comment_update: string
    'comment_create-issue': string
    'comment_list-issue': string
    'comment_update-issue': string
    thread_resolve: string
    'commit-status_set': string
    label_add: string
    assignee_set: string
    mr_approve: string
    mr_merge: string
    mr_create: string
    pipeline_trigger: string
    pipeline_retry: string
    pipeline_cancel: string
    job_list: string
    job_log: string
    'review_draft-create': string
    'review_draft-publish': string
    'review_draft-discard': string
    review_submit: string
    comment_list: string
    mr_get: string
    mr_diff: string
    mr_list: string
    file_read: string
    custom: string
  }
  codeHostActionDescription: {
    'comment_reply-thread': string
    comment_create: string
    'comment_create-inline': string
    comment_update: string
    'comment_create-issue': string
    'comment_list-issue': string
    'comment_update-issue': string
    thread_resolve: string
    'commit-status_set': string
    label_add: string
    assignee_set: string
    mr_approve: string
    mr_merge: string
    mr_create: string
    pipeline_trigger: string
    pipeline_retry: string
    pipeline_cancel: string
    job_list: string
    job_log: string
    'review_draft-create': string
    'review_draft-publish': string
    'review_draft-discard': string
    review_submit: string
    comment_list: string
    mr_get: string
    mr_diff: string
    mr_list: string
    file_read: string
    custom: string
  }
  codeHostField: {
    project: string
    mr: string
    issue: string
    thread: string
    comment: string
    comment_scope: string
    body: string
    position: string
    sha: string
    state: string
    context: string
    description: string
    target_url: string
    labels: string
    assignees: string
    ref: string
    workflow: string
    pipeline: string
    job: string
    job_scope: string
    job_filter: string
    path: string
    file_ref: string
    mr_state: string
    per_page: string
    source_branch: string
    target_branch: string
    title: string
    merge_method: string
    squash: string
  }
  codeHostFieldHint: {
    project: string
    thread: string
    comment: string
    position: string
    labels: string
    assignees: string
    workflow: string
    pipeline: string
    path: string
  }
  codeHostOption: {
    pending: string
    success: string
    failed: string
    pulls: string
    issues: string
    open: string
    closed: string
    all: string
    latest: string
    canceled: string
    running: string
    merge: string
    squash: string
    rebase: string
    true: string
    false: string
  }
  codeHostUnsupported: {
    graphqlOnly: string
    singleRequestReview: string
    useDraftNotes: string
  }
  codeHostInspector: {
    provider: string
    providerHint: string
    manageConnections: string
    manageConnectionsAria: string
    action: string
    actionHint: string
    sectionInputs: string
    inputGuideEmptyTitle: string
    inputGuideEmpty: string
    inputGuideUnboundTitle: string
    inputGuideUnbound: string
    inputGuideBoundTitle: string
    inputGuideBound: string
    boundTargets: string
    removeBindingAria: string
    inputBindingAdvancedHint: string
    inactiveValuesTitle: string
    inactiveValuesBody: string
    clearInactive: string
    confirmClearInactive: string
    clearInactiveAria: string
    confirmClearInactiveAria: string
    clearInactiveHistory: string
    sectionParams: string
    sectionCustom: string
    method: string
    path: string
    pathHint: string
    query: string
    queryHint: string
    queryKey: string
    queryValue: string
    addQuery: string
    removeQuery: string
    body: string
    bodyHint: string
    allowDestructive: string
    allowDestructiveHint: string
    noViewPermission: { title: string; body: string }
    actionUnsupported: string
    unsupportedGeneric: string
  }
  scriptNode: {
    label: string
    dependencyCount_one: string
    dependencyCount_other: string
    readonly: string
  }
  scriptInspector: {
    language: string
    languageHint: string
    sectionCode: string
    body: string
    bodyHint: string
    fullscreenEdit: string
    retryWarning: string
    sectionInputs: string
    noInputs: string
    inputSample: string
    inputSampleHint: string
    sectionOutputs: string
    outputSingle: string
    outputEnvelope: string
    envelopeSample: string
    envelopeSampleHint: string
    copySample: string
    outputPorts: string
    outputPortsHint: string
    sectionRuntime: string
    dependencies: string
    dependenciesHint: string
    env: string
    envHint: string
    envKey: string
    envValue: string
    envAdd: string
    envRemove: string
    readonly: string
    readonlyHint: string
    noViewPermission: { title: string; body: string }
  }
  callWorkgroupNode: {
    label: string
    unsetWorkgroup: string
  }
  /** RFC-245 — shared click hint for BOTH call kinds on the task-detail canvas
   *  (one key: the text does not vary by kind). */
  callNode: {
    navChild: string
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
    namesSeparator: string
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
      draftLocalOnly: string
      draftSaveFailed: string
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
      /** RFC-248: 第 5 档 —— 仓库组。 */
      repo_group: string
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
      permissionRequired: string
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
    unknownOwner: string
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
    resourceType: { agent: string; skill: string; mcp: string; plugin: string; workflow: string }
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
    answerPanePartialFailed: string
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
  presence: {
    online: '在线',
    offline: '离线',
  },
  permissions: buildPermissionCatalogResources('zh-CN'),
  tabBar: {
    scrollStart: '向前查看更多分区',
    scrollEnd: '向后查看更多分区',
  },
  capabilityFlow: {
    kind: { program: '程序步', script: '脚本步', ai: 'AI 步', invoke: '子序列' },
    parallel: '并行分片',
    agentSlot: '代理槽位：{{slot}}',
    scriptSlot: '脚本槽位：{{slot}}',
    invokes: '内联执行 {{capability}}',
    noContract: '这条能力不由阶段序列驱动',
    noContractHint: '它是常驻的监视循环，负责发现该做事的时机并派发轮次，本身没有固定步骤。',
    staleContract:
      '这一轮跑的是第 {{ran}} 版合同，当前是第 {{current}} 版——图按当前版绘制，两者可能不一致。',
    empty: '先选一条能力，即可查看它的完整流程。',
    loading: '正在载入流程…',
    requires: '读取',
    produces: '产出',
    terminal: '流程在此结束',
    injectable: '此处的钩子可回传：{{keys}}',
    injectableNone: '此处的钩子不能回传数据，只能读写工作树或中止。',
  },
  intent: {
    title: '意图构建',
    description: '用自然语言描述目标，AI 生成/修改工作流、工作组、代理与技能，确认后落库。',
    newSession: '新建意图会话',
    emptyTitle: '还没有意图会话',
    emptyDescription: '描述你的工作目标，让 AI 为你编排所需的全部资源。',
    loadingMore: '正在加载更多……',
    columnTitle: '标题',
    columnStatus: '状态',
    columnRounds: '轮次',
    columnCommits: '提交',
    columnUpdated: '更新时间',
    statusArchived: '已归档',
    archiveAction: '归档',
    reopenAction: '重新打开',
    auditReadOnly: '你正在审计其他用户的意图任务；此处仅可查看历史与执行过程。',
    archivedReadOnly: '此任务已归档。重新打开后才能继续修改。',
    startBuilding: '开始构建',
    messageLabel: '工作目标',
    messageHint: '描述目标与过程，越具体越好；AI 拿不准时会反问澄清。',
    messagePlaceholder: '例：我要一个"先实现、再按文件分片审计、最后修复"的流水线……',
    hintLabel: '产物类型（可选）',
    hintHint: '选择目标产物类型；「自动判断」由 AI 依据意图自行决定。',
    hintPlaceholder: '工作流 / 工作组 / 代理 / 技能',
    hintAuto: '自动判断',
    hintAutoDescription: '由构建 Agent 根据目标判断最合适的资源组合。',
    modifyTargetNote: '修改目标：{{type}}（已挂载到本会话，AI 将直接基于它给出变更）',
    buildWorkspace: '构建工作区',
    timeline: '会话记录',
    roleUser: '我',
    roleAgent: '构建 Agent',
    turnKind: {
      message: '消息',
      answers: '回答',
      'mount-approval': '挂载批准',
      running: '生成中',
      questions: '反问',
      changeset: '变更集',
      error: '错误',
    },
    opCount: '{{count}} 项变更',
    retryTurn: '重试本轮',
    failureDiagnostic: {
      genericSuggestion: '展开本轮执行事件查看详情后重试；重复失败时可依据下方证据定位运行时。',
      reason: {
        'output-cap-hit': {
          title: '输出超过本轮保留窗口',
          suggestion: '结果信封可能落在被截断部分。请缩小本轮变更，分批提交后重试。',
        },
        'no-assistant-text': {
          title: '运行时没有产生 assistant 文本',
          suggestion:
            '模型可能在读取清单后停止，尚未开始输出结果。请先重试；若持续出现，请检查运行时事件。',
        },
        'terminal-without-envelope': {
          title: '运行时已结束，但没有提交结果信封',
          suggestion: '模型完成或报错时没有遵循输出协议。查看终态事件后重试本轮。',
        },
        'assistant-stopped-without-envelope': {
          title: 'assistant 已输出文本，但在结果信封前停止',
          suggestion: '请缩小本轮目标并重试，确保每批都先提交完整结果信封。',
        },
        'runtime-shape-unknown': {
          title: '没有检测到可识别的结果信封',
          suggestion: '当前运行时事件形态不足以进一步分类。请展开执行事件并重试。',
        },
      },
      observedRetained: 'assistant 文本：观察到 {{observed}}，保留 {{retained}}',
      lastEvent: '最后事件：规范类型 {{kind}}；运行时类型 {{type}}',
      terminalResult: '运行时终态：{{result}}',
      terminal: {
        success: '成功',
        error: '错误',
        'not-observed': '未观察到',
      },
      notObserved: '未观察到',
      unparsedStdout: 'stdout 中还出现了无法解析的行。',
      scratchRetained: '本轮诊断现场已保留，最长约 {{hours}} 小时后自动清理。',
      scratchRetainedUnknown: '本轮诊断现场已暂存，并会由后台自动清理。',
    },
    generating: '正在生成……',
    answerQuestions: '回答澄清问题',
    submitAnswers: '提交回答并继续生成',
    questionsAsked: '{{count}} 个澄清问题',
    answersSubmitted: '已提交 {{count}} 个回答',
    answerSeparator: '、',
    mountApprovalSubmitted: '已处理挂载建议。',
    mountApproved: '已挂载',
    mountRejected: '已跳过',
    mountApprovalFirst: '请先处理全部挂载建议，再提交这些回答。',
    mountSuggestionsTitle: '复核建议上下文',
    mountSuggestionsDescription: '构建 Agent 希望引用这些已有资源。整批确认前不会挂载任何内容。',
    mountSuggestionsReadOnly: '仍有 {{count}} 项上下文建议待处理；请由任务所有者重新打开后决定。',
    mountDecisionFor: '{{name}} 的处理方式',
    mountApprove: '挂载',
    mountReject: '跳过',
    mountCandidateUnavailable: '当前没有你可访问的匹配资源；此项将被跳过。',
    mountCandidateLabel: '选择匹配资源',
    mountCandidateFor: '{{name}} 的匹配资源',
    mountCandidatePlaceholder: '请选择一个资源',
    mountBatchAtomic: '所有决定会一起应用；任一选择已失效时，整批都不会变更。',
    mountDecisionSubmit: '应用上下文决定',
    currentActionTitle: '当前待办',
    currentActionDescription: '一次完成问题回答和资源决定，构建 Agent 只会继续一轮。',
    currentActionReadOnly: '当前待办只能由会话所有者处理。',
    currentActionAtomic: '回答与资源决定会一次性提交。',
    currentActionSubmit: '提交并继续',
    mounts: '已挂载元素',
    mountUnavailable: '资源不可用',
    mountUnavailableHint: '生成时将跳过',
    unmount: '取消挂载',
    workingContextEyebrow: '工作上下文',
    workingContextTitle: '下一轮可用资源',
    workingContextCount: '已挂载 {{count}} 项',
    workingContextMore: '另有 {{count}} 项',
    workingContextEmpty: '尚未挂载资源',
    workingContextManage: '管理工作上下文',
    workingContextDismiss: '放弃待处理更新',
    workingContextQueue: '本轮后刷新',
    workingContextInterrupt: '停止本轮并立即刷新',
    workingContextSaveAndRun: '保存并生成',
    workingContextRunningHint: '可让新上下文在本轮结束后生效，也可停止本轮并立即刷新。',
    workingContextFailed: '工作上下文更新失败。',
    workingContextMounted: '移除已挂载资源',
    workingContextRemoveHint: '勾选的资源会在保存时移除。',
    workingContextDeltaSummary: '新增 {{additions}} 项 · 移除 {{removals}} 项',
    workingContextRetry: '重试更新',
    workingContextState: {
      queued: '已排队刷新',
      applying: '正在刷新上下文',
      applied: '上下文已刷新',
      failed: '刷新失败',
      canceled: '已放弃刷新',
    },
    draftTitle: '草稿变更集（第 {{revision}} 版）',
    draftStale: '已过期',
    draftStaleNotice: '会话上下文已变化，此草稿不可提交；发送新消息重新生成。',
    blockingErrors: '{{count}} 个阻断性校验错误，需 AI 修复后才能提交。',
    commitDisabledStale: '先更新草稿基线，才能进入提交确认。',
    commitDisabledValidation: '先解决上方校验问题，才能进入提交确认。',
    commitDisabledGenerating: '本轮生成完成后即可进入提交确认。',
    opCreate: '新增',
    opUpdate: '修改',
    openCommit: '确认并提交…',
    commits: '历次提交',
    commitState: {
      prepared: '准备中',
      applying: '应用中',
      committed: '已提交',
      failed: '失败',
    },
    fromCopy: '副本',
    composerSourceCurrent: '正在完善候选 v{{revision}}',
    composerSourceCheckpoint: '基于已提交检查点 #{{commitSeq}} 继续',
    composerSourceConversation: '继续当前对话',
    composerRefineLabel: '这个候选还要怎么改？',
    composerContinueLabel: '下一轮还要新增或调整什么？',
    composerRefinePlaceholder: '描述哪里不对、还要如何完善……',
    composerContinuePlaceholder: '描述基于这个检查点想要的下一版结果……',
    iterationKeepsHistory: '每次成功生成都会产生一个不可变的新候选版本。',
    refineDraft: '继续完善',
    continueCheckpoint: '基于检查点继续',
    discardAndRegenerate: '废弃并重新生成',
    returnToLatest: '回到最新',
    checkpointReadyTitle: '检查点 #{{commitSeq}} 已提交',
    checkpointReadyDescription: '会话仍然保持活跃，随时可从同一个输入框继续下一轮。',
    draftHistory: '候选历史',
    draftLifecycle: {
      current: '当前候选',
      committed: '已提交',
      superseded: '已被替代',
      discarded: '已废弃',
    },
    composerLabel: '继续调整',
    composerPlaceholder: '继续描述想要的调整……',
    send: '发送',
    cancelTurn: '取消生成',
    rebase: '拉取新基线',
    commitTitle: '确认提交变更集',
    commitSubmit: '提交入库',
    commitPending: '正在提交……',
    commitBack: '上一步',
    commitNext: '下一步',
    commitStepsAria: '提交步骤',
    commitStep: {
      strategy: '应用策略',
      details: '补充信息',
      review: '最终复核',
    },
    commitStrategyCreateOnly: '本次提议全部为新建资源，无需选择原件修改策略。',
    commitDetailsNone: '本变更集无需补充名称、密钥、豁免或人类成员绑定。',
    commitReviewSafety: '这是最终复核。密钥值会刻意隐藏，且不会进入构建 Agent 上下文。',
    commitReviewResources: '资源数',
    commitReviewUpdates: '修改数',
    commitReviewDetails: '补充项',
    commitReviewDetailStatus: '补充信息',
    commitSlotKind: {
      secret: '密钥',
      secretWaiver: '凭据豁免',
      humanBinding: '人类成员绑定',
      finalName: '最终名称',
    },
    commitDetailProvided: '已提供',
    commitDetailRequired: '必须完成',
    commitDetailDefault: '使用默认',
    commitGuard: {
      title: '提交仍在处理中',
      busyBody: '服务端可能正在应用这批变更。请留在当前页面，避免无法判断提交是否成功。',
      stay: '留在这里',
    },
    applyModeTitle: '修改方式',
    applyModeHint: '直接修改原件，或复制为新的私有元素。',
    applyModify: '直接修改',
    applyCopy: '新增副本',
    secretsTitle: '补填密钥',
    secretPlaceholder: '在此输入真实密钥（不会进入 AI 上下文）',
    waiversTitle: '疑似凭据豁免',
    waiverLabel: '我确认这不是真实凭据：',
    humansTitle: '人类成员绑定',
    humanLabel: '占位成员「{{name}}」',
    humanHint: '绑定平台用户，或留空以移除该成员。',
    namesTitle: '命名调整（可选）',
    nameHint: '留空使用 AI 提议的名称。',
    namePlaceholder: '新名称',
    entryCreate: '意图创建',
    entryModify: '意图修改',
    entryModifyHint: '挂载本资源开启意图会话，AI 基于其现状提出修改。',
    provenanceBadge: '意图构建',
    addMount: '添加挂载',
    addMountTitle: '添加挂载',
    addMountSubmit: '挂载',
    addMountType: '资源类型',
    addMountResources: '选择资源',
    mountPickerLoading: '加载中…',
    mountPickerEmpty: '没有可选资源',
    mountPickerLoadFailed: '资源列表加载失败',
    mountPickerUnresolved: '解析中…',
    previewRawJson: '原始 JSON',
    previewSideSwitch: '前后对比',
    executionTitle: '执行过程',
    executionEvents: '{{count}} 条事件',
    executionState: {
      live: '实时',
      complete: '完整',
      truncated: '已截断',
      incomplete: '记录不完整',
    },
    executionTruncatedNotice: '执行事件已达到保存上限；生成结果仍可正常复核与提交。',
    executionIncompleteNotice: '部分执行记录未能保存；这不会改变本轮业务结果。',
    createLead: '从目标开始，不必先决定要建哪些资源。',
    draftSafety: '只生成草稿；复核提交前不会修改任何资源',
    examplesLabel: '目标示例',
    exampleWorkflow: '构建一个“实现 → 按文件审计 → 修复”的工作流',
    exampleWorkgroup: '组建一个会分工、汇总并向我确认的工作组',
    exampleAgent: '创建一个专注安全审计、输出结构化发现的 Agent',
    recentSessions: '最近会话',
    recentSessionsHint: '继续上次构建，或查看已经生成和提交的版本。',
    loadMore: '加载更多任务',
    roundsCount: '{{count}} 轮',
    commitsCount: '{{count}} 次提交',
    reviewWorkspace: '草稿复核区',
    workspaceTabs: '意图构建工作区',
    draftPendingTitle: '草稿复核',
    draftPendingDescription: '生成完成后，变更预览与校验结果会出现在这里；确认提交前不会修改资源。',
    opOutline: '拟议变更',
    opErrorsCount: '{{count}} 个问题',
    draftEmptyState: {
      goal: {
        title: '先描述最终结果',
        description: '在「构建」中说明目标，生成的资源提议会出现在这里。',
      },
      generating: {
        title: '正在构建草稿',
        description: '可在「构建」中实时查看执行过程，完成后这里会出现可复核的变更集。',
      },
      clarifying: {
        title: '需要你的决定',
        description: '请在「构建」中回答澄清问题，随后会继续生成。',
      },
      error: {
        title: '本轮生成需要处理',
        description: '到「构建」展开失败轮次、查看证据并重试；当前没有资源被修改。',
      },
      applied: {
        title: '本轮已应用',
        description: '可查看下方提交记录，或回到「构建」继续调整结果。',
      },
      archived: {
        title: '会话已归档',
        description: '当前为只读状态，会话过程与提交记录仍可查看。',
      },
    },
    journey: {
      ariaLabel: '意图构建进度',
      currentStage: '第 {{current}}/{{total}} 步',
      stageStatus: '第 {{current}}/{{total}} 步 · {{stage}}',
      archivedStageStatus: '已归档 · {{stageStatus}}',
      goal: '目标',
      generate: '生成',
      review: '复核',
      apply: '应用',
      state: {
        generating: '正在生成草稿',
        clarifying: '等待你的回答',
        'review-ready': '草稿已就绪，请复核',
        'review-blocked': '草稿需要先修正',
        applying: '正在应用变更',
        applied: '本轮已提交，可继续调整',
        error: '本轮遇到错误，请在会话中处理',
        'idle-active': '输入下一条目标开始新一轮',
        archived: '会话已归档，只读',
      },
      reason: {
        'describe-goal': '描述你想构建的最终结果',
        'generation-running': '构建 Agent 正在生成草稿',
        'working-set-queued': '新工作上下文会在本轮结束后自动生成',
        'working-set-applying': '正在刷新工作上下文',
        'working-set-failed': '工作上下文刷新失败，请调整或重试',
        'draft-refining': '构建 Agent 正在完善当前候选',
        'draft-regenerating': '旧候选已废弃，正在生成全新候选',
        'generation-retrying': '正在重试上一轮失败的生成',
        'answer-questions': '回答构建 Agent 的问题后继续',
        'review-draft': '应用前请复核拟创建或修改的资源',
        'draft-stale': '上下文已变化，请重新生成此草稿',
        'draft-invalid': '草稿仍有阻断性校验问题',
        'apply-running': '正在应用已确认的变更',
        'generation-failed': '生成失败，请查看本轮执行并重试',
        'apply-failed': '应用失败，请先检查错误再重试',
        applied: '本轮已应用，可继续提出调整',
        'checkpoint-ready': '检查点已提交，可随时继续下一轮',
        archived: '任务已归档，只读',
      },
    },
    previewBefore: '修改前',
    previewAfter: '修改后',
    previewWorkflowGraph: '工作流节点图',
    previewNodeCount: '{{count}} 个节点',
    previewEdgeCount: '{{count}} 条连接',
    previewOpenCanvas: '查看大图',
    previewCanvasDialogTitle: '工作流节点图预览',
    previewCanvasHint: '拖动画布查看完整结构，使用左下角控件缩放或适应窗口。',
    previewCanvasUnavailable: '画布预览不可用（定义未通过本地校验），请查看原始 JSON。',
    previewPromptDiff: '工作流模板变更',
    previewMembers: '成员（{{count}}）',
    previewLeader: '组长',
    previewHumanPlaceholder: '人类占位',
    previewBodyDiff: '正文对比',
    previewFiles: '文件（{{count}}）',
    previewScriptBadge: '脚本',
    previewBeforeUnavailable: '修改前内容不可用（目标未挂载）。',
    resourceType: {
      agent: '代理',
      skill: '技能',
      mcp: 'MCP',
      plugin: '插件',
      workflow: '工作流',
      workgroup: '工作组',
    },
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
    intent: '意图构建',
    reviews: '评审',
    clarify: '反问',
    repos: '远端仓',
    webhooks: 'Webhook',
    events: '事件中心',
    code: '代码',
    digitalEmployees: '数字员工',
    executors: '执行者库',
    employeeAssignments: '适用仓库',
    employeeOutcomes: '运行成效',
    settings: '设置',
    brand: 'Agent Workflow',
    openMenu: '打开导航菜单',
    home: '首页',
    group: {
      agents: '能力资源',
      workflows: '编排',
      digitalEmployees: '数字员工',
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
        unlaunchable: '{{name}} 无法启动',
        protocolIncompatible: '{{name}} 协议不兼容',
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
    priorCommentsTitle: '上一版 v{{version}} 的检视意见',
    priorCommentsCount_one: '{{count}} 条',
    priorCommentsCount_other: '{{count}} 条',
    priorCommentsEmpty: '上一版没有检视意见',
    priorCommentsUnanchored_one: '未能定位到原文 · {{count}} 条',
    priorCommentsUnanchored_other: '未能定位到原文 · {{count}} 条',
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
  apiDocs: {
    title: 'API 与 MCP 接入',
    subtitle: '本页内容由守护进程按当前路由表与工具注册表实时生成，不会与实现脱节。',
    intro:
      '本平台可以被外部模型和脚本远程驱动：MCP 走 `POST /api/mcp`，REST 走 `/api/*`。两条通道用同一枚个人访问令牌，权限也完全一致——令牌能做什么，两边就都能做什么。令牌在[账号页](/account)创建。',
    quickStart: '快速开始',
    quickStartBody:
      '在账号页创建令牌时选择用途：**仅 MCP**（推荐给模型客户端）或 **REST API + MCP**。读取权限恒定开启，写入与执行按矩阵勾选，删除必须逐项显式勾选。',
    connecting: '客户端配置',
    toolsHeading: 'MCP 工具',
    toolsIntro:
      '`tools/list` 只返回当前令牌真正能调用的工具。下表列出全部工具；不可用项表示所需权限不在当前账户的有效权限集合中。',
    restHeading: 'REST 端点',
    restIntro:
      '下表只列出令牌可达、且当前账户能够授权的端点。账户管理与 ACL bypass 权限永不进入令牌，故对应端点不在此列。',
    permissionsHeading: '权限矩阵',
    permissionsIntro:
      '当前账户的有效权限可以放入令牌的档位。账户未持有的档位不会出现在这里，也不会出现在账号页。',
    alwaysGrantedHeading: '恒定开启的读取权限',
    alwaysGrantedIntro: '任何有效令牌都带这些读取权限（可见范围仍受资源 ACL 约束），无需勾选。',
    resourcesHeading: '资源类型',
    resourcesIntro:
      '`resource_read` / `resource_write` 支持的资源与操作。形状特殊的会在表格上方标注。',
    colTool: '工具',
    colNeeds: '需要权限',
    colDescription: '说明',
    colMethod: '方法',
    colPath: '路径',
    colSummary: '说明',
    colOperation: '操作',
    colPermission: '权限',
    needsNothing: '无需额外权限',
    notAvailableToYou: '当前账户不可用',
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
    copy: '复制',
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
    patStatusActive: '有效',
    patStatusRevoked: '已吊销',
    token: {
      create: '创建令牌',
      docsLink: '接入文档',
      createTitle: '创建访问令牌',
      createdTitle: '令牌已创建',
      nameHint: '给它一个能看出用途的名字，例如哪台机器、哪条流水线。吧名字只在这里显示。',
      matrixLabel: '权限矩阵',
      cellLabel: '{{resource}}：{{verb}}',
      resource: {
        agents: '代理',
        skills: '技能',
        mcps: 'MCP',
        plugins: '插件',
        workflows: '工作流',
        workgroups: '工作组',
        tasks: '任务',
        'scheduled-tasks': '定时任务',
        repos: '仓库',
        memory: '记忆',
      },
      verb: {
        create: '新建',
        update: '修改',
        delete: '删除',
        execute: '执行',
      },
      purposeLabel: '用途',
      purpose: {
        general: 'REST API + MCP',
        mcp_only: '仅 MCP',
      },
      purposeHint: {
        general: '可调用 REST API，也可接入 MCP。',
        mcp_only: '只能接入 MCP；直接调 /api/* 会被拒。模型客户端选这一档。',
      },
      templateLabel: '权限模板',
      templateHint:
        '读取权限始终开启（不超过你自己的可见范围），模板只决定写入与执行。任何模板都不含删除。',
      template: {
        'read-only': '只读',
        'task-automation': '任务自动化',
        full: '完整（不含删除）',
        custom: '自定义',
      },
      advanced: '逐项选择权限',
      advancedHint: '只列出当前账户有效权限中可以放入这枚令牌的权限。',
      deleteWarningTitle: '这枚令牌可以删除数据',
      deleteWarningDescription: '已勾选：{{points}}。删除不可撤销；只在确实需要时保留它。',
      expiryLabel: '有效期',
      expiryHint: '到期后令牌自动失效，无需你记得去吊销。',
      expiry: {
        '30d': '30 天',
        '90d': '90 天',
        '365d': '1 年',
        never: '永不过期',
      },
      shownOnceTitle: '令牌只会显示这一次',
      shownOnceDescription: '关闭后无法再次查看。现在就把它存到密钥管理器或 CI 变量里。',
      copied: '已复制',
      copyFailed: '复制失败，请手动选中上方文本。',
      markerClearFailed: '未能清除本次创建的恢复标记。请先重试“完成”，再创建下一枚令牌。',
      markerUnavailable: '无法保存安全恢复标记，因此尚未发送创建请求。请检查浏览器存储权限后重试。',
      inventoryRefreshFailed: '令牌已创建，但令牌列表刷新失败。请保留当前密钥显示并重试刷新。',
      inventoryRefreshRetry: '重试刷新令牌列表',
      inventoryRefreshing: '正在刷新令牌列表…',
      reconcileTitle: '检查令牌创建结果',
      reconcileRefresh: '再次检查令牌列表',
      reconcileDone: '我已完成检查',
      reconcileWarningTitle: '创建结果暂时未知',
      reconcileWarningDescription:
        '服务端可能已经创建令牌，但其一次性密钥无法恢复。请勿再次创建；先检查下方候选项，完成后再从列表吊销不需要的令牌。',
      reconcileInvalidMarker:
        '保存的创建记录无法读取，系统不能安全定位本次请求。请手动检查令牌列表；完成检查前不要再次创建。',
      reconcileCandidatesTitle: '可能新建的令牌',
      reconcileNoCandidates: '当前没有完全匹配的候选项，但这不能证明令牌未被创建。',
      reconcileCandidateCount: '完全匹配的候选项：{{count}} 个。',
      reconcileCandidateAction:
        '如有不需要的候选项，请完成本次检查后从令牌列表吊销，再创建新令牌。',
      leaveTitle: '离开令牌创建流程？',
      leaveRevealBody: '这枚密钥只显示一次；离开会永久清除当前密钥，即使你还没有复制。',
      leaveUnknownBody: '离开会结束结果检查并清除安全恢复标记。只有确认已检查令牌列表后才应继续。',
      leaveCreatingBody: '令牌创建请求仍在等待结果。请留在本页，直到结果明确。',
      leaveStay: '留在这里',
      leaveDiscard: '确认离开并清除',
      leaveForce: '停止等待并离开',
      leaveForceWarning:
        '这只会终止浏览器等待，无法证明服务端没有创建令牌。安全恢复标记会保留，下次进入令牌管理时必须先检查结果。',
    },
    pleaseSignIn: '请先登录。',
    pleaseSignInDescription: '登录后即可查看账户资料与安全设置。',
    sectionGroup: '账户设置',
    sectionNavLabel: '账户设置分区',
    sections: {
      overview: '账户概览',
      security: '登录与安全',
      tokens: '外部对接令牌',
    },
    sectionDescriptions: {
      overview: '查看账户状态和已关联的登录身份。',
      security: '管理本地密码与当前 Web 会话。',
      tokens: '创建并管理个人访问令牌——外部模型与脚本通过 API / MCP 驱动本平台时用它。',
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
    noPatsDescription: '还没有创建过令牌。创建一枚即可让外部模型或脚本接入本平台。',
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
      manager: '资源管理员',
      user: '用户',
      guest: '游客',
    },
  },
  users: {
    title: '用户',
    new: '新建用户',
    summary: '{{total}} 位用户 · {{admin}} 位管理员 · {{invited}} 位待登录 · {{disabled}} 位已停用',
    empty: '还没有用户',
    emptyDescription: '创建本地密码账户，或为用户首次通过身份提供方登录预先建档。',
    filteredEmpty: '没有符合当前筛选条件的用户',
    filteredEmptyDescription: '换一个姓名搜索，或清除状态和权限预设筛选。',
    filtersLabel: '查找和筛选用户',
    searchLabel: '搜索用户',
    searchPlaceholder: '搜索显示名、用户名或邮箱…',
    statusFilterLabel: '按状态筛选用户',
    roleFilterLabel: '按权限预设筛选用户',
    filterAll: '全部',
    allRoles: '全部预设',
    directoryLabel: '真人用户账户',
    username: '用户名',
    displayName: '显示名',
    email: '邮箱',
    noEmail: '未填写邮箱',
    role: '权限预设',
    roleHint: '预设只提供默认权限组合；运行时不判断角色，下方可继续逐项追加权限。',
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
      guest: '游客',
      user: '普通用户',
      admin: '管理员',
      manager: '资源管理员',
      guestDesc: '默认只能读取公开的 Agent、Skill、MCP、Plugin、Workflow 与 Workgroup。',
      userDesc: '默认包含资源读取、任务启动与个人账户管理；其余权限可在清单中追加。',
      adminDesc: '默认包含当前目录中的全部权限。',
      managerDesc: '默认包含资源、记忆、仓库与任务管理；其余权限可在清单中追加。',
    },
    statusOption: {
      active: '活跃',
      invited: '待首次登录',
      disabled: '已停用',
    },
    selfRoleLocked: '不能修改自己的访问预设或附加授权 —— 需要另一位访问管理员代为操作。',
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
      title: '需要用户目录权限',
      body: '该页面需要 users:read。',
    },
  },
  repoGroups: {
    tabLabel: '仓库组',
    subtitle: '用目录树组织多个代码仓，创建可复用的任务工作空间',
    searchPlaceholder: '搜索组名或描述…',
    noMatchesDescription: '没有匹配的仓库组。',
    deleteTitle: '删除仓库组',
    deleteBody:
      '确定删除「{{name}}」？绑在它上面的 {{memories}} 条记忆会被归档（不硬删，但立即停止注入）。',
    deleteConflictBody:
      '「{{name}}」仍被别的仓库组或启用中的定时任务引用。强制删除会摘除那些引用、并把引用它的计划停发。',
    deleteForce: '强制删除',
    deleteReport:
      '已删除：归档 {{memories}} 条记忆、摘除 {{refs}} 处引用、停发 {{schedules}} 个计划。',
    tabAria: '仓库视图',
    newButton: '新建仓库组',
    loading: '正在加载仓库组…',
    empty: '还没有仓库组',
    emptyDescription:
      '仓库组描述「哪几个仓 + 各自 checkout 什么 + 在运行目录里怎么摆」，是多仓任务的唯一启动方式。',
    expandLayout: '展开「{{name}}」的目录树',
    collapseLayout: '收起「{{name}}」的目录树',
    columns: { name: '名称', repoCount: '展平仓数', memories: '绑定记忆' },
    editor: {
      createTitle: '新建仓库组',
      editTitle: '编辑仓库组',
      name: '名称',
      description: '描述',
      addDescription: '添加说明',
      pickRepo: '— 选择一个已缓存仓 —',
      pickGroup: '— 选择一个仓库组 —',
      refPlaceholder: 'ref（留空 = 默认分支）',
      subdirPlaceholder: '仓内子目录（留空 = 整仓）',
      readonly: '只读',
      pendingImports: '还有 {{count}} 个仓按 URL 填写，将在保存时导入',
      emptyDirectory: '空目录',
      pendingRepo: '待导入仓库',
      selectNode: '选择节点 {{path}}',
      bulkAddRepos: '批量加仓',
      bulkDialogTitle: '添加代码仓',
      cachedReposTab: '已缓存仓库',
      urlsTab: '仓库 URL',
      bulkMode: '仓库来源',
      pasteUrls: '粘贴 URL',
      selectAllAttachments: '全选挂载',
      newDirectoryPlaceholder: '新目录名',
      addDirectory: '添加目录',
      addTo: '添加到 {{path}}',
      searchRepos: '搜索已缓存仓库…',
      selectVisibleRepos: '全选当前 {{count}} 个',
      clearSelection: '清空选择',
      addSelected: '添加选中的 {{count}} 个',
      pasteUrlsPlaceholder: '每行一个 Git URL',
      invalidUrlLines: '第 {{lines}} 行不是支持的 Git URL',
      duplicateUrlsIgnored: '已忽略 {{count}} 个重复 URL',
      addUrls: '添加这些 URL',
      selectedCount: '已选 {{count}} 个节点',
      batchApplied: '已更新 {{count}} 个挂载，跳过 {{skipped}} 个空目录节点',
      batchMoved: '已移动 {{count}} 棵子树',
      markReadonly: '设为只读',
      markWritable: '设为可写',
      detach: '摘除挂载',
      moveTo: '移动到目录',
      move: '移动',
      validating: '正在校验布局…',
      finishDraftBeforeSave: '请先应用或清空尚未完成的编辑，再保存。',
      error: '错误',
      layoutSummary: '{{nodes}} 个目录节点 · {{repos}} 个仓库',
      settingsFor: '{{path}} 的设置',
      inherited: '继承',
      inheritedFrom: '继承自 {{group}}',
      deleteSubtree: '删除子树',
      deleteSubtreeTitle: '删除目录子树',
      deleteSubtreeDescription:
        '本次编辑将删除 {{nodes}} 个目录节点，其中包含 {{attachments}} 个仓库或仓库组挂载。保存前仍可取消整次编辑。',
      deleteSubtreeConfirm: '删除这些节点',
      directoryName: '目录名',
      parentDirectory: '上级目录',
      attachRepo: '挂载已缓存仓库',
      attachGroup: '挂载仓库组',
      attachedRepo: '已挂载仓库',
      attachedGroup: '已挂载仓库组',
      ref: 'Ref',
      subdir: '仓内子目录',
    },
    layout: {
      rootMount: '（任务根）',
      subdirChip: '子目录：{{subdir}}',
      readonlyChip: '只读',
      via: '经由 {{chain}}',
      empty: '这个组还没有目录节点。',
    },
  },
  code: {
    title: '数字员工',
    subtitle: '构建可复用的员工能力与规则化工作方式；实际执行统一进入任务管理',
    build: {
      title: '数字员工能力构建',
      employees: {
        title: '员工工作说明书',
        body: '定义每一步业务动作、具体执行者、重试方式与确定的下一步。',
      },
      executors: {
        title: '执行者库',
        body: '集中维护步骤可选择的 AI、程序、其他数字员工与外部系统。',
      },
      assignments: {
        title: '适用仓库',
        body: '指定每个仓库或仓库组使用哪名已发布员工与规则。',
      },
      outcomes: {
        title: '成效',
        body: '根据已完成任务和能力信号持续调整员工策略。',
      },
      runtimeTitle: '实际执行与其他任务统一管理',
      runtimeBody: '发起、阻塞处理、MR 看护与合入生命周期都在任务列表的“数字员工”分类中完成。',
      openTasks: '查看数字员工任务',
    },
    executors: {
      title: '执行者库',
      subtitle: '这里是每个员工步骤都能直接选择的完整执行者清单。',
      back: '← 数字员工',
      addAi: '新增 AI 执行者',
      addProgram: '新增程序',
      addEmployee: '新增数字员工',
      addSystem: '新增外部系统',
      ai: {
        title: 'AI 执行者',
        body: '在明确输入输出封套内执行的 Agent 实现。',
        empty: '还没有已发布 AI 执行者',
      },
      program: {
        title: '程序',
        body: '由平台任务引擎运行的确定性脚本。',
        empty: '还没有已发布程序执行者',
      },
      employee: {
        title: '可调用数字员工',
        body: '可接手 child 任务的已发布员工，也可在另一仓库工作。',
        empty: '还没有可调用数字员工',
      },
      system: {
        title: '外部系统',
        body: '负责需求取件、流水线门禁、审批提交与观察的程序。',
        empty: '还没有已发布外部系统',
      },
      platform: {
        title: '平台内建动作',
        body: '平台固定执行，无需单独创建资源，也不能由 AI 改写。',
      },
    },
    journey: {
      progress: '完整操作进度',
      current: '当前位置 · 第 {{current}} / {{total}} 步',
      nextAction: '下一步',
      owner: '负责人：{{owner}}',
      ownerName: {
        'current-user': '你',
        committer: 'Committer',
        platform: '平台',
        'digital-employee': '其他数字员工',
        'external-system': '外部系统',
      },
      noActionRequired: '无需你操作，系统会自动继续',
      unavailable: '当前账号缺少权限：{{reason}}',
      resumeAt: '预计 {{time}} 再次检查',
      deadlineAt: '最晚等待到 {{time}}',
      step: {
        'employee-setup': {
          define: '定义员工',
          publish: '发布员工',
          assign: '设置使用范围',
          launch: '交付第一项工作',
        },
        'mission-delivery': {
          intake: '接收需求',
          develop: '开发与修复',
          publish: '验证并发布',
          care: '看护 MR',
          merged: '确认合入',
        },
      },
      next: {
        createEmployee: '创建数字员工',
        employeeArchived: '创建新的数字员工',
        configureAndPublish: '完善这名员工的工作方式',
        publishEmployee: '发布这名数字员工',
        assignRepository: '设置它服务哪些仓库',
        launchFirstMission: '交给它第一项工作',
        answerQuestions: '回答数字员工的问题',
        waitChildMission: '等待另一名数字员工完成',
        openApproval: '打开审批并完成审核',
        waitApproval: '等待审批系统结果',
        retryMission: '修复原因后重试',
        attachMergeRequest: '挂接人工创建的 MR',
        resumeAutomation: '恢复自动开发',
        reviewAndMerge: '打开 MR 检视并合入',
        watchMergeRequest: '持续看护 MR',
        continueAutomatically: '继续自动开发',
        settleTransition: '结算正在进行的操作',
        viewOutcome: '查看本次成效',
        viewNoChangeOutcome: '查看无需修改的结果',
        launchAnotherMission: '再交一项工作',
      },
      detail: {
        setupDefineDetail: '先定义这名员工负责什么、收到工作后按哪几步执行。',
        setupPublishDetail: '检查工作步骤与连接，发布后才能被仓库选择。',
        setupAssignDetail: '把已发布员工绑定到仓库、仓库组或全局默认范围。',
        setupLaunchDetail: '配置已就绪，可以提交正文、文件或外部需求 ID。',
        createEmployeeDetail: '选择通用、Java 或 C++ 预置；创建后会直接进入完整工作说明书。',
        employeeArchivedDetail: '这名员工已归档，创建新员工后继续设置。',
        configureAndPublishDetail: '补齐有序步骤、问题处理、跨仓协作和系统连接，再发布不可变修订。',
        publishEmployeeDetail: '所有规则和依赖已校验，可以发布并进入仓库使用范围设置。',
        assignRepositoryDetail: '选择仓库或仓库组，保存后即可从同页发起第一项工作。',
        launchFirstMissionDetail: '可写正文、上传带目标路径的文件，或只提交外部系统 ID。',
        missionIntakeDetail: '平台正在取得并冻结需求材料，歧义时会在这里要求你选择。',
        missionDevelopDetail: '数字员工按已发布步骤处理，Agent 或程序只生产当前步骤结果。',
        missionPublishDetail: '平台验证真实工作区，再提交、推送并创建或更新 MR。',
        missionCareDetail: '平台持续采集检视意见、流水线和审批状态，按规则修复。',
        missionMergedDetail: '平台已经观察到权威合入事实，生命周期结束。',
        terminalCompleteDetail: '完整执行记录与成效已保留，平台不再写入该 MR。',
        terminalStoppedDetail: '该任务已经停止；可以查看记录或再发起一项工作。',
        settleTransitionDetail: '平台先核对已发出的副作用，再安全完成取消或交接。',
        answerQuestionsDetail: '答案表单就在下方；提交后会冻结进下一轮输入并自动继续。',
        waitChildMissionDetail:
          '另一仓库的独立任务正在推进；父任务不占用 Agent，会按完成条件自动恢复。',
        openApprovalDetail: '审批材料已提交，需有权限的审核人完成外部审批；平台继续观察结果。',
        waitApprovalDetail: '申请号和 deadline 已持久化；平台按 webhook 或定时短轮询取得权威状态。',
        retryMissionDetail: '先按阻断原因修复配置或外部状态，再从确定现场恢复。',
        attachMergeRequestDetail: '填写已有 MR，平台核对仓库、分支和 head 后继续生命周期看护。',
        resumeAutomationDetail: '重新采集当前事实并按已发布规则恢复写入，不沿用交接前的旧现场。',
        reviewAndMergeDetail:
          '自动化条件已经满足；平台永不自动合入，由 committer 做最终检视与合入。',
        watchMergeRequestDetail: '无需手工刷新；新意见、红门禁、冲突或合入事件都会唤醒规则。',
        continueAutomaticallyDetail: '无需你操作；平台正在执行规则选定的下一步。',
      },
      wake: {
        settleTransitionWake: '外部副作用结算后自动更新',
        waitChildMissionWake: 'child 任务状态或 deadline 变化时自动继续',
        waitApprovalWake: '审批 webhook 或定时观察时自动继续',
        waitMergeWake: '代码托管合入事件或主动采集时更新',
        watchMergeRequestWake: '新 webhook 或定期事实采集时自动继续',
        continueAutomaticallyWake: '当前动作完成或到达恢复时间时自动继续',
      },
    },
    employeePlaybook: {
      // 落库内容而非渲染期文案：创建向导按创建者语言把它写进说明书 draft。
      standardStep: {
        requirementAnalyze: '理解需求',
        changeImplement: '实现修改',
        changeReview: '检查修改',
        mrFeedbackApply: '处理检视意见',
        pipelineRepair: '修复流水线',
      },
      employeesTitle: '数字员工',
      employeesSubtitle: '用业务步骤定义它收到工作后怎么做；平台严格按规则执行。',
      createEmployee: '创建数字员工',
      createAndConfigure: '创建并查看工作说明书',
      createHint: '选择最接近的预置，平台会生成完整步骤；创建后直接进入下一步。',
      employeesEmpty: '还没有数字员工',
      employeesEmptyHint: '先创建一名员工，随后发布并设置它服务的仓库。',
      basics: '负责什么',
      preset: '擅长的项目类型',
      presetGeneral: '通用研发',
      presetJava: 'Java 项目',
      presetCpp: 'C / C++ 项目',
      ruleSet: '业务规则集',
      ruleSetHint: '规则决定何时执行、重试和停止；AI 不选择下一步。',
      chooseRuleSet: '选择已发布规则集',
      noRuleSet: '请先发布一套业务规则集',
      detectedExecutors: '将使用 {{count}} 个已发布执行者生成初始步骤。',
      enabled: '允许接收新工作',
      enabledShort: '启用',
      disabled: '停用',
      colSteps: '工作步骤',
      colStatus: '接单状态',
      stepCount: '{{count}} 步',
      steps: '收到任务后怎么做',
      stepsHint: '步骤从上到下执行；每一步只说明何时做、谁来做、成功或失败后去哪。',
      addStep: '增加一步',
      stepNumber: '第 {{number}} 步',
      stepName: '步骤名称',
      stepDescription: '这一步完成什么',
      trigger: '什么时候执行',
      triggerAlways: '到达这一步就执行',
      triggerRequirementReady: '需求材料完整时',
      triggerReviewFeedback: '收到未处理检视意见时',
      triggerPipelineFailed: '流水线门禁失败时',
      triggerMergeConflict: 'MR 发生冲突时',
      executorType: '由谁完成',
      executor: '具体执行者',
      executorPlatform: '平台固定动作',
      executorAgent: 'AI Agent',
      executorScript: '程序 / 脚本',
      executorEmployee: '另一名数字员工（可跨仓）',
      executorApprovalPrepare: '准备审批材料（Agent 或程序）',
      executorApprovalSubmit: '提交审批（程序）',
      executorApprovalObserve: '等待审批（程序）',
      chooseExecutor: '选择已发布执行者',
      createExecutor: '新增执行者',
      openExecutorLibrary: '查看执行者库',
      createPublishAndSelect: '创建、发布并选中',
      inlineExecutorHint:
        '执行者会在当前页面创建并发布，然后直接选给这一步，不会丢失数字员工草稿。',
      executorName: '执行者业务名称',
      executorAbility: '它能完成的工作',
      selectAgent: 'AI Agent',
      programLanguage: '程序语言',
      programPath: '已发布程序路径或引用',
      executorInstructions: '执行要求',
      approvalProgramPath: '审批连接程序',
      approvalProgramHint: '程序需要实现提交、按幂等键查询和审批状态观察。',
      capabilityRequirementAnalyze: '理解并梳理需求',
      capabilityChangeImplement: '实现代码修改',
      capabilityChangeReview: '检查本次修改',
      capabilityVerificationRepair: '修复本地验证失败',
      capabilityFeedbackApply: '处理 MR 检视意见',
      capabilityPipelineRepair: '修复流水线门禁',
      capabilityConflictRepair: '修复合并冲突',
      capabilityExternalReview: '执行外部 MR 检视',
      capabilityProblemClassify: '识别并分类问题',
      capabilityApprovalPrepare: '准备审批材料',
      platformAction: '平台动作',
      childEmployee: '调用的数字员工',
      chooseEmployee: '选择已发布数字员工',
      targetRepository: '它工作的目标仓库',
      childCompletion: '等待到什么状态',
      completionAutomationReady: '自动化工作完成',
      completionReadyToMerge: 'child MR 随时可合入',
      completionMerged: 'child MR 已合入',
      completionCompleted: 'child 任务已完成',
      approvalDraftExecutor: '审批材料由谁准备',
      approvalType: '审批业务类型',
      approvalSystem: '审批系统',
      chooseApprovalSystem: '选择已发布审批系统',
      pollMinutes: '每隔多少分钟检查',
      deadlineHours: '最长等待小时数',
      sameSceneRetries: '保留现场重试次数',
      freshSceneRetries: '回退现场重做次数',
      whenRetriesExhausted: '多次失败后',
      afterSuccess: '这一步成功后',
      continueByRules: '回到规则判断',
      finishCurrentPlaybook: '结束本次工作步骤',
      whenRejected: '外部请求被拒绝时',
      whenExpired: '等待超时时',
      useExhaustedAction: '沿用上面的失败动作',
      waitForSeveralSteps: '等多项步骤结果齐备后再继续',
      stepsToWaitFor: '需要等待的步骤',
      waitCondition: '满足什么条件继续',
      waitAll: '所选步骤全部成功',
      waitAny: '任一步骤成功',
      waitQuorum: '达到指定成功数量',
      quorumCount: '需要成功的数量',
      whenJoinDeadline: '到达截止时间时',
      whenJoinPartial: '已经不可能满足条件时',
      blockAndAskHuman: '阻断并说明原因',
      handoffToHuman: '交给人工并继续跟踪',
      moveUp: '上移一步',
      moveDown: '下移一步',
      problems: '遇到 MR 或流水线问题时',
      problemsHint: '先定义问题类型，再指定谁识别、谁修复；未匹配的问题不会让 AI 猜。',
      problemTypes: '1. 可以识别的问题类型',
      problemTypeNumber: '问题类型 {{number}}',
      problemName: '业务名称',
      evidenceSource: '从哪里发现',
      evidencePipeline: '流水线门禁',
      evidenceVerification: '本地验证',
      evidenceFeedback: 'MR 检视意见',
      evidenceConflict: '分支冲突',
      evidenceMr: 'MR 状态',
      priority: '处理优先级',
      repairable: '允许自动修复',
      unknownFallback: '作为无法分类时的明确兜底',
      newProblemType: '问题类型 {{number}}',
      addProblemType: '增加问题类型',
      problemProducers: '2. 谁负责识别问题',
      problemProducerNumber: '问题识别者 {{number}}',
      producerName: '识别者名称',
      producerCanReport: '允许产出哪些类型',
      newProducer: '问题识别者 {{number}}',
      addProducer: '增加识别者',
      problemHandlers: '3. 每类问题由谁修',
      problemHandlerNumber: '修复规则 {{number}}',
      problemType: '问题类型',
      verifyAfterRepair: '修复后重新执行',
      addHandler: '增加修复规则',
      connections: '使用哪些业务系统',
      connectionsHint: '这里只选择系统业务名称；具体程序与密钥由平台管理员发布。',
      requirementSystem: '需求 / 问题系统',
      pipelineSystem: '流水线门禁系统',
      noConnection: '暂不连接',
      manualTitle: '工作说明书',
      responsibility: '负责范围',
      sequenceTitle: '标准工作顺序',
      noBusinessSteps: '尚未配置工作步骤。',
      triggerLabel: '触发：{{trigger}}',
      executorLabel: '执行：{{executor}}',
      successLabel: '成功后：{{target}}',
      failureLabel: '失败后重试 {{same}} + {{fresh}} 次，再 {{target}}',
      problemsSummary: '问题识别与修复',
      noProblems: '没有配置自动问题分类；未知问题将阻断并交人。',
      externalCollaboration: '跨仓与审批',
      noExternalCollaboration: '没有跨仓数字员工或外部审批步骤。',
      connectionsSummary: '业务系统连接',
      assignmentSummary: '使用范围',
      assignmentCount: '已在 {{count}} 个范围生效',
      readyToPublish: '规则校验通过，可以发布',
      needsAttention: '还有 {{count}} 项需要完善',
      technicalDetails: '高级：技术实现与完整配置',
      success: '成功后',
      failure: '失败后',
      unavailableResource: '所选资源不可用或无权查看',
      unconfigured: '尚未配置',
      problemFlow: '识别：{{producer}} · 修复：{{handler}}',
      childWaitSummary: '目标仓库：{{repository}} · 等待：{{completion}}',
      target: {
        reconcile: '回到平台，按最新事实继续',
        complete: '完成任务',
        block: '阻断并说明原因',
        handoff: '交给人工并继续跟踪',
      },
      completion: {
        'automation-ready': '自动化工作完成',
        'ready-to-merge': 'MR 随时可合入',
        merged: 'MR 已合入',
        completed: '任务完成',
      },
      platform: {
        requirement_acquire: '下载并冻结需求材料',
        repository_inspect: '检查仓库事实',
        pipeline_collect: '采集流水线门禁和日志',
        verification_run: '运行程序化验证',
        change_publish: '提交并推送变更',
        mr_ensure: '创建或更新 MR',
        mr_collect: '采集 MR 状态和检视意见',
        pipeline_rerun: '重跑失败门禁',
        pipeline_trigger: '触发缺失流水线',
        readiness_evaluate: '判断 MR 是否随时可合入',
      },
    },
    control: {
      eyebrow: '规则驱动的 AI 研发同事',
      headline: '你给出需求，数字员工让 MR 始终保持可合入',
      description:
        '平台按已发布的员工能力、执行策略与仓库指派运行；Agent 只在封套边界内修改文件，提交、推送、MR 与门禁看护由平台执行。',
      inbox: '任务收件箱',
      outcomes: '成效',
      startWork: '交给数字员工',
      checking: '正在检查配置',
      setupReady: '已可接单',
      setupNeeded: '先完成能力配置',
      setupTitle: '数字员工启用清单',
      unavailable: '无权查看',
      readyCount: '已就绪 {{count}}',
      actionNeeded: '待配置',
      employeeTitle: '1. 定义员工能力',
      employeeBody: '选择 C++、Java 等模板，绑定 Agent、验证、需求取件和流水线门禁程序。',
      policyTitle: '2. 发布执行策略',
      policyBody: '定义何时执行、如何重试、预算与停机条件；所有决策都可追溯到规则。',
      assignmentTitle: '3. 指派到仓库',
      assignmentBody: '按仓库、仓库组或全局默认绑定已发布员工和策略。',
      operationsTitle: '4. 看护任务与 MR',
      operationsBody: '当前 {{count}} 条运行中任务；平台追踪反馈、流水线、冲突与最终合入。',
      readyMissions: '{{count}} 条 MR 可合入',
    },
    operations: {
      eyebrow: '实时看护',
      title: '当前任务，按负责阶段归位',
      subtitle: '每一项都能下钻处理；历史结果不再混在控制中心里。',
      allMissions: '打开任务收件箱',
      attentionTitle: '需要人工处理',
      attentionHint: '这些任务必须先补充信息或解除明确阻塞，自动化才能继续。',
      readyTitle: '等待 committer 合入',
      readyHint: '自动化工作已经完成；平台继续看护，由 committer 决定何时合入。',
      noActiveTitle: '当前没有运行中的任务',
      noActiveBody: '有需求时，直接交给数字员工即可。',
      stageAria: '进行中任务阶段',
      employeeFallback: '按仓库指派的数字员工',
      blockedReason: '阻塞：{{reason}}',
      awaitingInput: '等待补充所需信息',
      missionUpdated: '{{time}} 更新',
      missionUpdatedUnknown: '更新时间不可用',
      stage: {
        intake: {
          title: '1. 需求取件',
          body: '获取文件、澄清输入并冻结需求包。',
          empty: '当前没有需求停在这里。',
        },
        develop: {
          title: '2. 开发与修复',
          body: '执行受封套约束的 Agent 动作并校验输出。',
          empty: '当前没有 Agent 动作在执行。',
        },
        publish: {
          title: '3. 验证与发布',
          body: '程序化验证、提交、推送并创建或更新 MR。',
          empty: '当前没有候选变更在发布。',
        },
        care: {
          title: '4. MR 看护',
          body: '跟踪流水线门禁与检视意见，直到 MR 随时可合入。',
          empty: '当前没有 MR 需要自动看护。',
        },
      },
    },
    outcomes: {
      title: '运行成效',
      employeeTitle: '{{employee}} 的成效',
      subtitle: '用历史任务结果和能力信号调整数字员工与执行策略。',
      backToCode: '← 数字员工',
      backToTasks: '← 数字员工任务',
      showAll: '查看全部员工',
      historyTitle: '任务结果历史',
      historyHint: '终态结果留在这里；运行中的工作统一在任务列表中管理。',
      emptyTitle: '还没有已完成任务',
      emptyBody: '任务进入生命周期终态后，结果会出现在这里。',
      colMission: '任务',
      colResult: '结果',
      colEmployee: '数字员工',
      colRepository: '仓库',
      colCompleted: '完成时间',
      employeeFallback: '按仓库指派的数字员工',
      summaryAria: '任务成效摘要',
      summary: {
        merged: { title: '已合入', body: 'committer 审核并合入了准备好的 MR。' },
        noChange: { title: '无需变更', body: '需求已满足，并经规则要求的确认收束。' },
        closed: { title: '未合入关闭', body: '任务取消或 MR 未合入即关闭。' },
        failed: { title: '失败', body: '进入终态失败，需要调整能力或流程。' },
      },
      capabilityTitle: '能力成效信号',
      employeeSummaryTitle: '该员工的任务成效',
      employeeSummaryOpen: '查看成效',
      employeeSummaryHint: '该已发布员工产生的实时负载与终态结果。',
      employeeActive: ' 条进行中',
      employeeReady: ' 条可合入',
      employeeDelivered: ' 条已交付',
    },
    tab: { matrix: '仓库', activity: '活动', metrics: '成效', templates: '模板' },
    config: {
      title: '员工配置',
      subtitle: '数字员工、动作模板、验证 profile 与 adapter',
      technicalSubtitle: '高级技术资源；仅供平台管理员维护执行实现与系统连接。',
      kindSwitch: '配置类型',
      kind: {
        employees: '数字员工',
        actionTemplates: '动作模板',
        verificationProfiles: '验证 profile',
        adapters: 'Adapter',
      },
      backToList: '← 员工配置',
      colName: '名称',
      colDetail: '类型信息',
      colRevision: '发布',
      colVisibility: '可见性',
      notPublished: '仅草稿',
      archived: '已归档',
      emptyTitle: '还没有配置',
      emptyBody: '创建一个资源，开始配置数字员工。',
      create: '创建',
      creating: '创建中…',
      createTitle: '创建{{kind}}',
      name: '名称',
      capability: '能力',
      purpose: '用途',
      executableRef: '可执行引用',
      executableRefHint:
        'daemon 为该适配器执行的程序。创建时必填——适配器写入即严格校验，不能以空草稿保存。本用途的操作：{{operations}}。',
      edit: '编辑草稿',
      editTitle: '编辑草稿',
      save: '保存',
      saving: '保存中…',
      publish: '发布',
      publishing: '发布中…',
      publishBlocked: '发布被拒——先修复以下问题',
      archive: '归档',
      archiveTitle: '归档这个资源？',
      archiveBody: '“{{name}}”对既有引用仍可解析，但不再出现在选择器里。',
      acl: '访问控制',
      draftJsonTitle: '草稿内容（JSON）',
      draftJsonHint: '发布时会做完整 schema 与闭包校验；错误逐条列出。',
      draftInvalidJson: '草稿不是合法 JSON',
      description: '描述',
      promptSupplement: '提示词补充',
      promptHint: '追加在固定协议块之前的领域知识；不能改变运行合同。',
      employeeSummary: '员工画像',
      routesTitle: '能力路由',
      noRoutes: '还没有能力路由——发布至少需要一条。',
      colCapability: '能力',
      colRules: '规则数',
      colFallback: '兜底模板',
      bindingsTitle: '绑定',
      defaultPolicy: '默认策略',
      requirementSources: '需求源',
      pipelineProviders: '门禁 provider',
      templateSummary: '模板合同',
      executor: '执行 Agent',
      verificationProfile: '验证 profile',
      retryDefaults: '重试默认',
      retryText: '同会话 {{same}} 次，全新会话 {{fresh}} 次',
      profileSummary: '验证步骤',
      stopPolicy: '停止策略',
      noSteps: '还没有定义步骤。',
      colStep: '步骤',
      colProgram: '程序',
      colTimeout: '超时',
      colExitCodes: '成功退出码',
      adapterSummary: 'Adapter 合同',
      operations: '操作',
      executable: '可执行程序',
      connection: '连接',
      secretProjection: '密钥（仅显示名称）',
      outputBudget: '输出预算',
      budgetText: '{{files}} 个文件，共 {{bytes}} 字节',
      timeout: '超时',
      scriptsAuthorHint:
        '编辑 adapter 草稿需要 scripts:author 权限（可执行程序与密钥投影是 daemon 级字段）。',
      editor: {
        identitySection: '员工定位与默认策略',
        versionedRefHint: '引用已发布的精确修订，任务运行后不会随新草稿漂移。',
        resourceId: '资源 ID',
        revision: '发布修订',
        routesHint: '为每项能力指定兜底模板；高级事实规则在页底 JSON 中编辑。',
        routeNumber: '能力路由 {{number}}',
        fallbackHint: '规则都不匹配时使用的已发布动作模板。',
        rulesPreserved: '已保留 {{count}} 条高级选择规则。',
        addRoute: '添加能力路由',
        requirementSourcesHint: '允许输入外部需求 ID 时，在这里绑定程序化取件 Adapter。',
        sourceNumber: '需求源 {{number}}',
        sourceKey: '需求源 key',
        adapterRef: 'Adapter 精确修订',
        defaultSource: '作为默认需求源',
        addSource: '添加需求源',
        pipelineProvidersHint:
          '绑定自建系统的门禁采集程序；大日志由平台落入 .agent-workflow/pipeline。',
        providerNumber: '门禁源 {{number}}',
        providerKey: '门禁 provider key',
        addProvider: '添加门禁源',
        executionSection: '执行者与运行合同',
        capabilityLocked: '能力在创建模板时确定，此处只读。',
        contractVersion: '能力合同版本',
        executorKind: '执行形式',
        agent: '单 Agent',
        workgroup: '工作组',
        workgroupRef: '工作组引用',
        runtimeProfile: '运行时 profile',
        resourcesSection: '知识、工具与工作区边界',
        labels: '标签',
        skills: 'Skill 引用',
        mcps: 'MCP 引用',
        readOnlyResources: '只读资源',
        contextProfile: '上下文 profile（可选）',
        writablePathPolicy: '可写路径策略（可选）',
        protectedPathClasses: '附加受保护路径类',
        sameSessionRetries: '同会话重试',
        freshSessionRetries: '全新会话重跑',
        verificationStrategy: '验证策略',
        firstFailure: '首个失败即停止',
        collectAll: '执行并汇总全部步骤',
        maxParallel: '最大并行步骤',
        verificationStepsHint: '每步由程序退出码裁定，不让 Agent 根据日志文字自行判断。',
        stepNumber: '验证步骤 {{number}}',
        argsRef: '参数引用（可选）',
        networkProfile: '网络 profile',
        exitCodeInvalid: '请输入 0–255 之间的整数退出码。',
        evidenceSelectorsPreserved: '已保留 {{count}} 个高级证据选择器。',
        addStep: '添加验证步骤',
        adapterProgramSection: '外部系统程序与操作',
        operationsHint: '必需操作已锁定；只能启用该用途允许的附加操作。',
        parameterSchema: '参数 schema 引用（可选）',
        secretKeysHint: '只配置注入的密钥名称，密钥值不进入该资源。',
        outputBudgetHint: '程序输出会先落入任务临时目录，超出这里的文件数或字节预算即拒绝收编。',
        maxFiles: '最大文件数',
        maxFileBytes: '单文件最大字节',
        maxTotalBytes: '总字节上限',
        advancedReadOnly: '高级：查看完整草稿',
        advancedJson: '高级：编辑完整 JSON',
        advancedJsonHint: '仅在配置事实谓词、证据选择器等高级字段时使用。修改后必须先应用回表单。',
        applyAdvanced: '应用 JSON 到表单',
        applyAdvancedFirst: '请先将高级 JSON 应用回表单，再保存。',
        draftMustBeObject: '草稿顶层必须是 JSON 对象。',
      },
    },
    assignments: {
      title: '员工指派',
      description: '仓库 / 仓库组 / 全局三级的数字员工绑定',
      create: '新建指派',
      empty: '暂无指派',
      dialogTitle: '编辑指派',
      globalScope: '全局默认',
      repoRef: '仓库',
      groupRef: '仓库组',
      publishedOnly: '只提供已发布的资源',
      warnEmployeeUnpublished: '员工没有已发布修订',
      warnPolicyUnpublished: '策略没有已发布修订',
      colScope: '范围',
      colEmployee: '数字员工',
      colSelectionPolicy: '选择策略',
      colExecutionPolicy: '执行策略',
      colSourceKey: '默认需求源',
      scope: {
        repository: '仓库',
        'repository-group': '仓库组',
        'global-default': '全局默认',
      },
    },
    missions: {
      title: '研发任务（Mission）',
      subtitle: '规则驱动的数字员工任务：从需求到 Merge Request',
      backToCode: '← 代码能力',
      backToList: '← 任务列表',
      launch: '发起任务',
      launching: '发起中…',
      launchTitle: '发起研发任务',
      emptyTitle: '还没有任务',
      emptyBody: '用需求正文、上传文件或外部需求 ID 发起一条任务。',
      colMission: '任务',
      colStatus: '状态',
      colRepository: '仓库',
      colSource: '来源',
      colBlock: '阻塞',
      colUpdated: '更新时间',
      sourceDirect: '直接输入',
      sourceExternal: '外部',
      formKind: '输入形态',
      kindBody: '正文',
      kindUploads: '文件',
      kindExternal: '外部 ID',
      formRepository: '仓库',
      pickRepository: '选择仓库…',
      formEmployee: '数字员工',
      employeeHint: '仅已发布员工；留空则使用仓库指派。',
      pickEmployee: '选择员工…',
      formTitle: '标题',
      formBody: '需求正文',
      formExternalId: '外部需求 ID',
      formSourceKey: '需求源 key',
      sourceKeyHint: '可选；缺省用员工的默认需求源。',
      formUploads: '文件与仓库目标路径',
      uploadsHint: '每个文件都必须指定仓库相对目标路径。',
      detailTitle: '任务 {{id}}',
      retry: '重试',
      blockTitle: '阻塞中',
      questionsTitle: '待回答的问题',
      submitAnswers: '提交答案',
      actionTitle: 'Agent 动作',
      actionOutcome: '最近结果',
      actionCapability: '能力',
      actionCandidate: '变更候选',
      sourcesTitle: '需求来源',
      refreshPreview: '检查上游变化',
      refreshChanged: '有变化 → {{revision}}',
      refreshApply: '应用刷新',
      refreshUnchanged: '已是最新',
      noSources: '还没有需求来源代际。',
      colGeneration: '代际',
      colRevision: '版本',
      colState: '状态',
      manifestTitle: '需求包',
      noManifest: '还没有物化的需求包。',
      colFile: '文件',
      colRole: '角色',
      colBytes: '字节',
      colActions: '操作',
      viewFile: '查看',
      effectsTitle: '平台副作用',
      noEffects: '还没有副作用记录。',
      colEffect: '副作用',
      colCreated: '创建时间',
      collaborationTitle: '外部协作',
      childMissionTitle: '调起的数字员工',
      collaborationPending: '正在创建',
      childMissionCreating: '平台正在幂等创建子任务。',
      openChildMission: '打开子任务',
      approvalTitle: '外部审批',
      openApproval: '打开审批单',
      approvalWaiting: '平台正在等待外部审批结果。',
      collaborationDeadline: '截止时间：{{time}}',
      readinessTitle: '就绪度',
      noReadiness: '还没有就绪度快照。',
      handoff: '交接',
      resume: '恢复自动化',
      attachMr: '挂接 MR',
      attachTitle: '挂接已有的合并请求',
      attachHint:
        '平台会先向代码托管方核实这个 MR——仓库、分支与当前 head 以托管方读取为准，不信表单自述。',
      attachMrIid: 'MR 编号（iid）',
      attachEndpoint: '代码托管方',
      attachEndpointAuto: '按仓库推导',
      attachProject: '项目路径覆盖',
      attachProjectHint: '留空则从仓库绑定推导。',
      attachSubmit: '挂接',
      configOutdated: '策略钉在 r{{pinned}}，已发布 r{{published}}',
      configUpgradeHint:
        '策略已有新版本。运行中任务的配置升级随迁移批次（PR-9）交付；在那之前本任务继续使用钉定版本。',
      timelineTitle: '时间线',
      timelineEmpty: '还没有决策或外发副作用记录。',
      timelineDecision: '决策',
      timelineEffect: '副作用',
      timelineExpand: '轨迹',
      timelineCollapse: '收起',
      evidenceTitle: '流水线证据',
      evidenceNone: '本任务还没有采集到流水线证据。',
      evidenceHead: '采集时的 head',
      evidenceCollectedAt: '采集时间',
      evidenceGatesTitle: '门禁',
      evidenceFilesTitle: '证据文件',
      evidenceNoFiles: '证据包中没有文件。',
      evidenceUntrusted: '外部程序输出——不可信内容。只以纯文本展示，链接与标记永不渲染。',
      evidenceLoaded: '已加载 {{loaded}} / {{total}} 字节',
      evidenceLoadMore: '继续加载',
      colGate: '门禁',
      colRun: '运行',
      status: {
        admitting: '正在校验准入规则',
        'awaiting-information': '等待补充信息',
        working: '数字员工处理中',
        publishing: '正在交付变更',
        watching: '持续看护 MR',
        'ready-to-merge': '随时可合入',
        'waiting-committer': '等待 Committer 合入',
        blocked: '需要处理',
        'completed-no-change': '确认无需变更',
        merged: '已合入',
        'closed-unmerged': '已关闭未合入',
        canceled: '已取消',
        failed: '失败',
      },
      wizard: {
        title: '交给数字员工',
        subtitle: '说明要做什么，确认规则与交付方式；之后平台会持续开发并看护 MR，直到合入。',
        stepRepository: '仓库与交付',
        stepRequirement: '需求或问题',
        stepAutomation: '员工与规则',
        stepReview: '预检并启动',
        continueTo: '下一步：{{step}}',
        repositoryWhyTitle: '先确认工作边界',
        repositoryWhyBody:
          '数字员工只在所选仓库的隔离工作区修改业务文件；commit、push、MR 和流水线由平台按规则执行。',
        deliveryLabel: '如何交付变更',
        deliveryCreate: '创建新的 MR',
        deliveryCreateHint: '平台创建分支与 MR，并持续处理检视和流水线意见。',
        deliveryAdopt: '接管已有 MR',
        deliveryAdoptHint: '从已有 MR 的当前 head 继续处理并看护生命周期。',
        targetRef: '目标分支（可选）',
        targetRefHint: '留空时使用仓库默认分支。',
        mergeRequestRef: '已有 MR 引用',
        mergeRequestRefHint: '填写代码托管系统中的 MR 编号或平台可识别引用。',
        directLabel: '直接描述或上传文件',
        directHint: '正文、文件可任选，也可以同时提供；上传文件会按指定路径随提交进入仓库。',
        externalLabel: '从内建系统读取 ID',
        externalHint: '数字员工通过已配置的需求源程序下载该 ID 对应的多文件需求包。',
        bodyHint: '可粘贴完整需求、问题现象、验收标准；若已上传文件，正文可以留空。',
        filesHint: '每个文件必须明确仓库路径、碰撞方式以及 Agent 是否可编辑。',
        filesDropTitle: '拖入需求附件或待提交文件',
        filesDropBody: '文件先暂存；预检通过并启动后，才会绑定到本次任务。',
        filesChoose: '选择文件',
        fileTarget: '提交到仓库路径',
        collisionMode: '目标已存在时',
        collisionCreate: '只允许新建',
        collisionReplace: '精确替换现有文件',
        contentPolicy: '数字员工对文件的权限',
        contentPreserve: '原样保留',
        contentPreserveHint: 'Agent 不得修改、移动或删除此文件。',
        contentEditable: '允许继续编辑',
        contentEditableHint: 'Agent 可修改内容，但不得删除或改变文件模式。',
        executable: '作为可执行文件提交',
        executableHint: '策略必须允许 executable 模式，预检会给出最终判定。',
        externalInfoTitle: 'ID 不是正文',
        externalInfoBody:
          '平台先用数字员工绑定的需求源 Adapter 程序化下载多文件内容，再把内容以只读需求包交给 Agent。',
        rulesTitle: 'AI 不决定流程，规则决定',
        rulesBody:
          '员工选择、动作顺序、重试、流水线门禁与就绪判定都来自已发布策略；Agent 只在一次动作的输入/输出边界内完成工作。',
        employeeAuto: '按仓库指派自动选择',
        employeeAutoHint: '使用仓库 → 仓库组 → 全局默认的确定性优先级。',
        employeeExplicit: '本次指定数字员工',
        employeeExplicitHint: '将已发布员工的精确版本固定到本任务。',
        employeePublished: '已发布数字员工',
        assignmentResolved: '由仓库指派在预检时确定',
        assignmentHint: '预检会显示最终选中的员工与策略；没有可用指派时不会允许启动。',
        openAssignments: '查看员工指派',
        policyOverride: '执行策略覆盖（可选）',
        policyOverrideHint: '通常使用员工默认策略；只有本任务需要特殊规则时才覆盖。',
        employeeDefaultPolicy: '使用员工默认策略',
        manageEmployees: '管理数字员工',
        managePolicies: '管理自动化策略',
        reviewRepository: '工作与交付',
        reviewRequirement: '输入内容',
        reviewAutomation: '自动化规则',
        preflight: '运行配置与文件预检',
        preflightAgain: '重新预检',
        preflightRunning: '正在预检…',
        preflightRequiredTitle: '启动前还差一次预检',
        preflightRequiredBody:
          '平台将按启动时的同一条规则链解析员工、策略和需求源，并在仓库当前 baseline 上验证每个上传目标。',
        preflightBlocked: '当前配置无法启动',
        sourceSelectionTitle: '需要明确选择需求源',
        sourceSelectionPlaceholder: '选择已绑定的需求源…',
        uploadBlockedTitle: '存在不能提交的文件目标',
        uploadBlockedBody: '按表格中的原因返回修改文件路径或策略，然后重新预检。',
        preflightReady: '规则与文件边界已确认',
        preflightReadyBody: '将固定员工 {{employee}} 与策略 {{policy}}，启动后由平台持续推进。',
        uploadPlanTitle: '文件提交计划',
        baselineSha: '依据仓库当前 baseline {{sha}} 计算；启动时仍会原子重验。',
        disposition: '预检结果',
        dispositionValue: {
          create: '新建',
          replace: '替换',
          'already-present': '内容已存在',
          blocked: '阻塞',
        },
        launch: '启动并交给数字员工',
      },
      guidance: {
        mergedTitle: '任务生命周期已完成',
        mergedBody: 'MR 已由 Committer 合入；平台停止写入并保留完整任务轨迹。',
        readyTitle: 'MR 已经随时可合入',
        readyBody: '自动化门禁已清零。平台不会自动合入，接下来由 Committer 审核并合入。',
        answersTitle: '数字员工需要你补充信息',
        answersBody: '回答下方问题后，平台会把答案冻结进下一轮输入并自动继续。',
        blockedTitle: '有一个确定性条件阻止继续',
        blockedBody: '查看下方阻塞原因，修复配置或外部状态后点击重试；平台不会自行猜测。',
        handoffTitle: '当前由人工接管',
        handoffBody: '平台只跟踪生命周期，不再写入；确认外部状态后可恢复自动化或挂接 MR。',
        watchingTitle: '数字员工正在看护 MR',
        watchingBody: '平台持续采集检视意见、流水线门禁和 head 变化，并按策略触发修复。',
        terminalTitle: '任务已停止',
        terminalBody: '平台不再执行写操作；时间线与证据仍可供复核。',
        workingTitle: '数字员工正在推进任务',
        workingBody: '平台正在按已发布规则选择并执行下一动作，无需人工轮询。',
        deliveryCreated: '平台创建 MR',
        deliveryAdopted: '接管已有 MR',
      },
      readiness: {
        automation: '自动化就绪度',
        ready: '机器条件已全部满足',
        inProgress: '仍有机器条件待处理',
        hostMergeable: '托管平台可合入性',
        head: '判定对应的 head',
        machineHolds: '平台仍需处理',
        humanHolds: '需要 Committer 处理',
        none: '无',
        advanced: '高级：原始就绪回执',
        mergeable: { yes: '可合入', no: '不可合入', unknown: '尚未确认' },
        hold: {
          'active-action': 'Agent 动作仍在运行',
          'unconfirmed-effect': '平台副作用尚未确认',
          'unhandled-feedback': '仍有检视意见待处理',
          conflict: '与目标分支存在冲突',
          'required-gate-not-pass': '必需流水线门禁未通过',
          'facts-incomplete': '外部事实尚未完整采集',
          'head-mismatch': '证据对应旧 head',
          'upload-fulfillment-pending': '上传文件尚未完成提交',
          'approval-required': '仍需批准',
          'thread-unresolved': '仍有人工检视线程未解决',
          'committer-policy-hold': '策略要求 Committer 最终确认',
        },
      },
    },
    policies: {
      title: '自动化策略',
      subtitle: '驱动数字员工的 first-match 规则、预算与交付设置',
      backToCode: '← 代码能力',
      backToList: '← 策略列表',
      create: '新建策略',
      createTitle: '创建自动化策略',
      createHint: '策略从平台默认模板起步；编辑并发布后才能被任务使用。',
      nameLabel: '名称',
      namePlaceholder: '例如 java-service-default',
      emptyTitle: '还没有策略',
      emptyBody: '创建一个策略来配置数字员工如何选择与执行动作。',
      colName: '名称',
      colPublished: '发布',
      colVisibility: '可见性',
      colUpdated: '更新时间',
      draftOnly: '草稿',
      revisionN: '第 {{n}} 版',
      save: '保存草稿',
      saved: '已保存',
      publish: '发布',
      publishNeedsSave: '发布前请先保存草稿',
      neverPublished: '从未发布——任务还无法固定使用此策略。',
      publishedAt: '已发布第 {{n}} 版。运行中的任务仍使用其固定的旧版本。',
      violationsTitle: '发布被拒',
      tabRules: '规则',
      tabSettings: '设置',
      tabSimulate: '模拟',
      tabsLabel: '策略分区',
      fixedGuardsTitle: '固定守卫（只读）',
      fixedGuardsHint: '守卫按此顺序先于所有规则执行；它们是产品不变量，不可配置。',
      actionRulesTitle: '动作优先级（首条命中即停）',
      selectionRulesTitle: '员工选择规则',
      selectionRulesHint: '可选；当仓库指派按规则选择员工时使用。',
      firstMatchHint: '规则自上而下求值；谓词全部满足的第一条规则胜出。',
      noRules: '还没有规则。',
      ruleId: '规则 id',
      ruleIdPlaceholder: 'rule-id',
      capability: '能力',
      employeeRef: '员工引用',
      employeeRefPlaceholder: 'employee-id@rev',
      moveUp: '上移',
      moveDown: '下移',
      predicatesN: '{{n}} 个谓词',
      removeRule: '删除规则',
      addRule: '添加规则',
      addPredicate: '添加谓词',
      removePredicate: '删除谓词',
      predicateKind: '谓词类型',
      predicateFact: '事实',
      predicateValue: '值',
      predicateOp: '比较符',
      predicateValuesPlaceholder: '输入一个值…',
      predicateJson: '组合谓词（JSON）',
      predicateJsonHint: 'all / any / not 组合子以原始 JSON 编辑。',
      predicateJsonError: '规则 {{rule}}：谓词 JSON 无效',
      requirementJson: '需求段（JSON）',
      requirementJsonHint: '需求 / 上传段嵌套较深，这里以原始 JSON 编辑。',
      requirementJsonError: '需求段：JSON 无效',
      secAdmission: '准入',
      admissionDirect: '允许直接提交',
      admissionExternal: '允许外部需求 ID',
      admissionDuplicate: '外部 ID 重复时',
      secFeedback: '反馈',
      feedbackClass: '处理 {{cls}} 反馈',
      feedbackBatch: '批量上限',
      feedbackLatest: '只处理最新线程修订',
      secPipeline: '流水线门禁',
      pipelineStale: '证据过期时间（毫秒）',
      gateKey: '门禁键',
      gateRequired: '必需',
      gateDisposition: '缺少运行时',
      gateCategories: '可重跑的失败类别',
      gateMaxReruns: '最大重跑次数',
      gateRemove: '删除门禁',
      gateAdd: '添加门禁',
      secConflict: '冲突',
      conflictMode: '模式',
      conflictAttempts: '最大修复次数',
      secDelivery: '交付',
      deliveryPrefix: '源分支前缀',
      deliveryCollision: '分支冲突时',
      deliveryDraft: '以草稿开 MR',
      deliveryHumanPush: '人工推送到源分支时',
      secVerification: '验证',
      verificationProfiles: '必需的验证档案',
      verificationProfilesHint: 'profile-id@revision；全部通过才发布 candidate。',
      verificationStop: '停止策略',
      secRetry: '重试与预算',
      retry_sameSessionRetries: '同会话重试',
      retry_freshSessionReruns: '全新会话重跑',
      retry_actionRunsPerMission: '每任务动作上限',
      retry_commitsPerMission: '每任务提交上限',
      retry_missionWallTimeMs: '任务墙钟时间（毫秒）',
      secReadiness: '就绪判定',
      readinessGates: '额外必需门禁键',
      readinessFeedback: '未解决反馈阻塞就绪',
      secNotification: '通知',
      notificationOverview: 'MR 总览评论',
      notificationEscalation: '升级提醒间隔（毫秒）',
      secRetention: '保留',
      retention_requirementBundleTerminalTtlDays: '需求包保留（天）',
      retention_pipelineBundleTerminalTtlDays: '流水线包保留（天）',
      retention_attemptLedgerTtlDays: '尝试台账保留（天）',
      secRequirement: '需求与上传',
      simGuards: '守卫夹具',
      simGuardTerminal: '任务已终态',
      simGuardActiveAction: '可写动作进行中',
      simGuardUnsettled: '有未结算 effect',
      simGuardMrTerminal: 'MR 终态',
      simGuardMode: '自动化模式',
      simGuardUploadSeed: '上传种子状态',
      simCells: '事实夹具',
      simCellsHint: '未列出的事实视为 indeterminate——读它的规则会老实停下。',
      simCellFact: '事实',
      simCellValue: '值',
      simCellValuePlaceholder: '值（集合用逗号分隔）',
      simCellRemove: '删除事实',
      simCellAdd: '添加事实',
      simRun: '运行模拟',
      simSelected: '选中的决策',
      simNoMatch: '无规则命中',
      simNoMatchHint: '守卫全部通过但没有规则命中——生产中该任务会以 no-policy-match 阻塞。',
      simGuardTrace: '守卫轨迹',
      simRuleTrace: '规则轨迹',
      simRuleTraceEmpty: '守卫在任何规则求值前已停止。',
      simMatched: '命中',
      simMissed: '未中',
      simSelectionTitle: '员工选择预览',
      simSelectionEmployee: '显式员工引用',
      simSelectionRun: '预览选择',
    },
    flow: {
      capability: '能力',
      hint: '点任意一步即可查看并修改它实际用到的配置。结构（有哪些步、怎么连）由平台固定。',
      sharedSlot: '此槽位同时被另外 {{count}} 步使用（{{stages}}）——在这里改动会一并影响它们。',
      agent: '代理',
      agentNone: '（未指定）',
      prompt: '提示词',
      script: '脚本',
      scriptLanguage: '解释器',
      scriptRedacted:
        '你没有查看脚本正文的权限（需要 scripts:author）。这里留空是「未展示」，不是「没有脚本」。',
      scriptsRedactedChip: '脚本未展示',
      params: '参数',
      saveParams: '保存参数',
      hooks: '钩子',
      noHooks: '这一步的前后还没有挂任何钩子。',
      hookPhase: '挂在哪一侧',
      hookPre: '这一步之前',
      hookPost: '这一步之后',
      hookScript: '钩子脚本',
      addHook: '新增钩子',
    },
    repoLabel: '仓库',
    repoHint: '事件所属的项目路径，例如 group/project',
    load: '查看',
    pickRepo: '输入一个仓库以查看它的能力',
    noCapabilities: '这个仓库还没有配置任何能力',
    noActivity: '还没有跑过任何轮次',
    noActivityHint: '当 MR 事件唤醒一个已启用的能力后，工作项会出现在这里。',
    enabled: '已启用',
    round: '第 {{seq}} 轮',
    roundPicker: '查看哪一轮',
    bulk: {
      open: '批量修改多个仓库',
      title: '把一项能力变更应用到多个仓库',
      repos: '仓库',
      reposHint: '一个仓库 id 一个标签。每个都会被显式写入——没有「继承值」需要事后去别处查。',
      capability: '能力',
      template: '模板',
      enabled: '开启该能力',
      preview: '预览',
      apply: '应用',
      undo_one: '撤销（{{count}} 个仓库）',
      undo_other: '撤销（{{count}} 个仓库）',
      failures_one: '{{count}} 个失败',
      failures_other: '{{count}} 个失败',
    },
    // 中文没有单复数变化，两个键给同一句——i18next 仍会按 count 选键，
    // 少一个就会在 count===1 时回落到英文。
    roundsHidden_one: '还有 {{count}} 轮未显示。',
    roundsHidden_other: '还有 {{count}} 轮未显示。',
    roundsShowMore: '显示更多轮次',
    templateLabel: '使用哪份模板',
    templateHint: '没选模板的能力永远不会就绪——它不知道该用哪个 agent 干活。',
    templateNone: '（未选择）',
    capability: {
      'mr-review': 'MR 检视',
      'mr-comment-fix': '评论驱动改码',
      requirement: '需求实现（issue → MR）',
      'ci-fix': 'CI 修复',
      'mr-monitor': 'MR 监视器',
    },
    templates: {
      createAction: '创建',
      newTemplate: '新建模板',
      nameLabel: '名称',
      capabilityLabel: '驱动哪条能力',
      slotLabel: '「{{slot}}」这一步用哪个 agent',
      title: '模板',
      hint: '一份模板就是一条能力的全部配置：跑什么脚本、挂什么钩子、每一步用哪个 agent 和提示词。复制一份改成自己的即可；改脚本另需「脚本编写」权限——那些脚本是以平台自己的身份跑的。',
      none: '还没有模板',
      builtin: '内置',
      scriptsHidden: '脚本已隐藏',
      copy: '复制一份',
      copiedFrom: '复制自另一个模板',
      params: '参数：{{names}}',
      slots: 'agent：{{pairs}}',
      backToList: '全部模板',
      detailSubtitle: '这份模板一步步跑些什么',
    },
    // RFC-309 T16 —— 一份复制品与它的来源之间是什么关系。
    upstream: {
      title: '来自哪里',
      from: '复制自「{{name}}」',
      state: {
        current: '已是最新',
        'update-available': '有更新',
        conflicted: '需要你决定',
        orphaned: '来源已删除',
      },
      action: {
        'take-upstream': '对方改了',
        'keep-local': '你改了',
        conflict: '双方都改了',
      },
      noBase:
        '这份复制品早于变更追踪，平台无从判断某个字段是谁改的。因此所有差异都按「需要你决定」呈现，不会自动合并任何内容。',
      merge_one: '合入你没有改过的 {{count}} 处',
      merge_other: '合入你没有改过的 {{count}} 处',
      merged: '合入 {{applied}} 处，保留你自己的 {{kept}} 处，还剩 {{conflicted}} 处等你决定。',
    },
    // RFC-309 T23 —— 用这份模板发起一轮。
    launch: {
      title: '用这份模板发起',
      hint: '立即开一轮。不需要先在矩阵里为该仓库启用这条能力——那个开关管的是「自动响应代码托管平台」，和手动发起是两回事。',
      notLaunchable: '这条能力是常驻监视循环、不是轮次概念，没有可手动发起的东西。',
      repo: '仓库',
      repoNone: '（请选择）',
      reqTitle: '要做什么',
      reqBody: '详细说明',
      reqBodyHint: '把原本会写在 issue 正文里的都写这里——约束、验收、链接。',
      mrIid: 'MR 编号',
      mrIidHint: '代码托管平台上显示的那个编号，不是内部 id。',
      discussionId: '讨论串 id',
      discussionIdHint: '从代码托管平台上该讨论串的永久链接里复制。',
      pipelineId: '流水线 id',
      submit: '发起',
    },
    metrics: {
      empty: '还没有可统计的数据',
      emptyHint: '当能力发布过评论或跑过轮次后，这里会出现数字。',
      window: '最近 {{days}} 天',
      adoptionTitle: '发出去的评论后来怎么样了',
      runsTitle: '轮次是怎么结束的',
      capability: '能力',
      published: '已发布',
      // 四列，不合成一个采纳率：「已解决」与「代码已改」恰恰在最值得知道的
      // 情况下互相矛盾，合成一个数就必然在其中一种上说谎。
      adopted: '改了且已解决',
      quietFix: '改了但没解决',
      disagreed: '解决了但没改',
      outstanding: '仍未处理',
      rounds: '轮次',
      roundsPublished: '已发布',
      roundsFailed: '失败',
      roundsAwaiting: '等待人处理',
      roundsIncomplete: '中断未完成',
    },
    attempts: {
      show: '模型调用',
      hide: '收起模型调用',
      none: '这个阶段没有记录到模型调用',
      // 两个计数分开显示：同会话重试是「告诉了模型哪里不对」，换会话重跑是
      // 「从头再来」，合成一个数字就把两级重试的设计意图丢了。
      label: '第 {{rerun}} 次会话 · 第 {{attempt}} 次尝试',
      openTask: '打开任务',
    },
    readiness: {
      ready: '就绪',
      misconfigured: '待配置',
      disabled: '已关闭',
    },
  },
  repos: {
    title: '远端仓缓存',
    pageTitle: '代码仓库',
    remoteTab: '远端仓库',
    operations: {
      subtitle: '集中查看缓存新鲜度、使用情况与仓库健康状态',
      viewAria: '远端仓业务视图',
      views: { all: '全部', referenced: '使用中', attention: '需关注', unused: '未使用' },
      searchPlaceholder: '搜索远端地址、路径或分支…',
      searchLabel: '搜索远端仓缓存',
      filters: '筛选',
      activeFilters: '已启用 {{count}} 个高级筛选',
      filterTitle: '筛选远端仓缓存',
      submodulesLabel: 'Submodule',
      submodules: { all: '全部', with: '包含', without: '不包含' },
      autoRefreshLabel: '后台自动刷新',
      autoRefreshFilters: { all: '全部', refreshed: '刷新过', never: '从未刷新' },
      applyFilters: '应用筛选',
      noMatchesDescription: '当前业务视图和筛选条件下没有匹配的远端仓缓存。',
      columns: { repository: '仓库', freshness: '新鲜度', usage: '使用情况' },
      branch: '分支 {{branch}}',
      fetched: '抓取于',
      neverFetched: '从未同步',
      autoRefresh: '自动刷新',
      referencingTasks: '个关联任务',
      loadMore: '加载更多仓库',
      loadingMore: '正在加载…',
    },
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
    webhookEndpoints: {
      eyebrow: '接收事件',
      title: '接收端点',
      add: '新建Webhook端点',
      hint: '为 GitLab / GitHub 创建一个稳定的事件入口。创建后，把 URL 和 Secret 一起粘贴到代码平台的 Webhook 配置。',
      empty: '还没有接收端点',
      emptyDescription: '先创建端点，拿到只显示一次的 Secret，再回到代码平台完成连接。',
      emptyReadonlyDescription: '尚未有持有 webhook-endpoints:manage 权限的用户配置接收端点。',
      enabled: '已启用',
      disabled: '已禁用',
      enabledSwitch: '启用',
      providerLabel: '代码平台',
      lastDeliveryLabel: '最近投递',
      neverDelivered: '尚未收到事件',
      noPublicBaseUrlTitle: '还不能复制完整 URL',
      noPublicBaseUrl: '请先在网络设置中配置 publicBaseUrl。端点路径已保留：{{path}}',
      secretHint: 'Secret（尾 4 位：{{hint}}）',
      createSubmit: '创建',
      createDescription: '端点负责接收并验签事件；具体启动什么任务由下一步的触发规则决定。',
      copyUrl: '复制 URL',
      urlCopied: 'Webhook URL 已复制。',
      copyFailed: '复制失败，请手动选中文本复制。',
      rotateSecret: '轮换 Secret',
      rotateConfirmTitle: '轮换 Secret？',
      rotateConfirmDescription:
        '“{{name}}” 的旧 Secret 会立即失效。轮换后必须立刻把新 Secret 更新到代码平台，否则后续投递都会验签失败。',
      rotateConfirmAction: '确认轮换',
      deleteConfirm: '确认删除？',
      addTitle: '新建 Webhook 端点',
      nameLabel: '名称',
      namePlaceholder: '内网 GitLab / GitHub.com',
      providerHintGitlab: '按 GitLab 语义验签（Secret token 明文比对）。',
      providerHintGithub:
        '按 GitHub 语义验签（HMAC 签名）。在 GitHub 侧 Content type 必须选 application/json。',
      protocolLabel: '自动注册用协议',
      protocolHint: '事件仓库尚未导入时，平台会优先使用这种地址自动拉取。',
      secretTitle: 'Secret Token（仅此一次）',
      secretOnceTitle: '现在保存，关闭后不再显示',
      secretDone: '我已保存',
      secretOnce:
        '以下 Secret 只显示这一次，请立即复制并粘贴到 {{provider}} webhook 配置的 Secret 字段。',
      secretLabel: 'Secret Token',
      copySecret: '复制',
      secretCopied: '已复制',
      urlLabel: 'Webhook URL',
      urlMaskedHint: '查看完整 URL 需要 webhook-endpoints:manage。',
      secretPasteHintGitlab:
        '在 GitLab：Settings → Webhooks，把 URL 与 Secret token 一起粘贴保存。',
      secretPasteHintGithub:
        '在 GitHub：Settings → Webhooks → Add webhook——粘贴 Payload URL 与 Secret，Content type 选 application/json。',
    },
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
      limits: '统一设置工作流与数字员工的任务、token、超时、并发和重试边界。',
      recovery: '创建备份并配置恢复行为。',
      gc: '控制数据保留与自动清理。',
      git: '控制平台代理提交排除、submodule 与后台刷新。',
      codeHosts: '配置 GitLab / GitHub 的出站凭据',
      network: '设置 daemon 监听地址与端口。',
      appearance: '选择主题与界面语言。',
      rendering: '配置外部图表渲染服务。',
      authentication: '管理 OIDC 登录提供商。',
    },
    cardGroups: {
      limitsBudgetsTitle: '任务预算',
      limitsBudgetsHint: '统一限制单个任务可用的时长、token、步骤与讨论轮次。',
      limitsSharedRetryTitle: '这里也是数字员工唯一的重试设置',
      limitsSharedRetryHint:
        '节点重试次数和会话重启预算同时用于工作流与数字员工。数字员工任务启动时会固化当时的值，运行中的任务不会随设置变更漂移。',
      limitsConcurrencyTitle: '并发与吞吐',
      limitsConcurrencyHint: '控制 daemon 与单个工作流可以并行执行的工作量。',
      limitsLoggingTitle: '日志保留',
      limitsLoggingHint: '限制每个任务保留的运行输出规模。',
      recoveryAutomationTitle: '自动恢复',
      recoveryAutomationHint: '选择中断任务在什么条件下无需人工操作即可继续。',
      recoverySafetyTitle: '恢复安全边界',
      recoverySafetyHint: '设置恢复尝试的重试次数与超时边界。',
      gitCheckoutTitle: '检出与子模块',
      gitCheckoutHint: '定义任务工作树如何拉取并初始化仓库内容。',
      gitAutoCommitTitle: '平台代理提交排除规则',
      gitAutoCommitHint: '阻止平台运行物与管理员指定路径进入提交及待推送历史。',
      gitRefreshTitle: '后台刷新',
      gitRefreshHint: 'daemon 运行期间持续保持仓库引用为最新状态。',
      gcWorktreesTitle: '工作树清理',
      gcWorktreesHint: '在清理前按期限保留已完成任务的工作树。',
      gcEventsTitle: '事件清理',
      gcEventsHint: '按固定周期移除已过期的工作流与投递事件。',
      gcRetentionTitle: '保留期与清理',
      gcRetentionHint: '这些旋钮会真的删文件 / 删行,且守护进程启动即生效。0 一律表示不清理。',
      taskArchiveTitle: '终态任务归档(会让任务从界面消失)',
      diskReclaimTitle: '可回收空间',
      diskReclaimHint: '退役目录与数据库内部空洞的盘点;删除不可撤销。',
      taskArchiveHint:
        '把久远的已完成任务整树导出到归档目录并从库中删除,以控制数据库体积。默认关闭。',
      gcWebhooksTitle: 'Webhook 清理',
      gcWebhooksHint: '独立于任务数据保留并清理 Webhook 投递历史。',
      networkListenerTitle: 'Daemon 监听',
      networkListenerHint: '选择 daemon 接受连接的本地地址与端口。',
      networkExternalTitle: '外部访问',
      networkExternalHint: '配置浏览器、回调与生成链接使用的公开基础地址。',
      appearanceDisplayTitle: '显示与语言',
      appearanceDisplayHint: '选择当前安装的界面主题与语言。',
      renderingServiceTitle: 'PlantUML 服务',
      renderingServiceHint: '连接可选的外部服务来渲染 PlantUML 图表。',
    },
    tabRuntime: '运行时',
    tabSystemAgents: '系统 Agent',
    tabLimits: '限额',
    tabRecovery: '恢复',
    tabGc: 'GC',
    tabGit: 'Git',
    tabCodeHosts: '代码平台',
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
    numericOutOfRange: '请输入 {{min}} 到 {{max}} 之间的整数',
    numericDecimalOutOfRange: '请输入 {{min}} 到 {{max}} 之间的数值',
    numericRangeZeroOr: '请输入 0，或 {{min}} 到 {{max}} 之间的整数',
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
    diskRetiredStores: '退役运行时存储目录',
    diskNothingToReclaim: '无(目录不存在)',
    diskFreelist: '数据库内部可回收 {{reclaimable}}(文件总大小 {{total}})',
    diskCompactHint: '回收数据库内部空间需停机执行:',
    diskCleanup: '删除退役目录',
    diskCleanupConfirmAction: '永久删除',
    diskCleanupConfirmTitle: '删除退役运行时存储?',
    diskCleanupConfirmBody:
      '将永久删除 {{path}}({{size}})。它是运行时加固退役后遗留的死数据,平台已无任何代码读写它;删除不可撤销。',
    taskArchiveRunNow: '立即归档…',
    taskArchiveScanning: '扫描中…',
    taskArchiveNothing: '没有可归档的任务树(保留期 {{days}} 天以内的都保留)。',
    taskArchiveConfirmTitle: '归档并删除这些任务?',
    taskArchiveConfirmBody:
      '将把 {{trees}} 棵任务树(共 {{tasks}} 个任务,最近完成时间早于 {{days}} 天)导出到 ~/.agent-workflow/archive/tasks/,并从数据库删除。归档后它们在列表 / 详情 / 搜索里一律不可见,且不提供在线回看。',
    taskArchiveConfirmAction: '归档并删除',
    taskArchiveDone: '已归档 {{trees}} 棵任务树,共 {{tasks}} 个任务。',
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
    changeNarrativeRuntimeLabel: '变更导读运行时',
    changeNarrativeRuntimeHint:
      '任务「结构变更」页签生成 AI 导读所用的运行时 profile；留空则继承全局默认运行时。',
    systemAgents: {
      commitPushTitle: '提交推送',
      commitPushHint: '自动提交时生成 commit message、修复被拒推送的内置 agent（RFC-075）。',
      memoryTitle: '记忆提取',
      memoryHint: '从任务产物提炼长期记忆候选的内置 agent（RFC-041）。',
      mergeTitle: '合并冲突解决',
      mergeHint: '按节点隔离合并回主干、遇真实三方冲突时解决冲突的内置 agent（RFC-130）。',
      narrativeTitle: '变更导读',
      narrativeHint: '为任务代码变更生成总述、分组一句话与推荐阅读顺序的内置 agent（RFC-239）。',
      intentTitle: '意图构建',
      intentHint: '把自然语言目标转成工作流/工作组/代理/技能变更集的内置 agent（RFC-234）。',
      intentRuntime: '意图构建运行时',
      intentRuntimeHint: '用于生成意图变更集的运行时；留空继承全局默认。',
      intentLang: '产物语言',
      intentLangHint: '生成的 prompt/描述所用语言；默认跟随使用者输入语言。',
      intentLangDefault: '跟随输入',
      intentTimeout: '单轮超时（ms）',
      intentTimeoutHint: '每轮生成的最长时长；默认 600000。',
      intentRounds: '会话轮数上限',
      intentRoundsHint: '单个会话允许的生成轮数上限；默认 50。',
      intentExtra: '追加指令',
      intentExtraHint: '叠加在平台内置系统 prompt 之上的团队约定（如命名规范）；≤8KB。',
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
      oidcDefaultRoleLabel: 'OAuth/OIDC 新用户默认角色',
      oidcDefaultRoleHint:
        '仅用于身份提供方首次自动创建账号；既有账号和管理员预先邀请的账号不受影响。',
      oidcDefaultRoleGuest: '游客（只读）',
      oidcDefaultRoleUser: '普通用户',
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
      discardTitle: '放弃提供商更改？',
      discardDescription: '未保存的提供商更改（包括客户端密钥）将丢失。',
      discardKeepEditing: '继续编辑',
      discardConfirm: '放弃更改',
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
    // 已退役的示例流程死键随概念一并清除，仅保留 tour 启动页活键。
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
  resourcePackage: {
    importTitle: '导入配置包',
    file: '配置包文件',
    fileHint: '从本实例或其它 Agent Workflow 实例导出的 .zip。',
    dropTitle: '将配置包拖到这里',
    chooseFile: '选择配置包',
    replaceFile: '替换',
    removeFile: '移除',
    replaceConfirmTitle: '放弃当前导入选择？',
    replaceConfirmBody: '选择其它配置包会清空你已经确认的资源处理方式和用户映射。',
    removeConfirmBody: '移除当前配置包会清空你已经确认的资源处理方式和用户映射。',
    replaceAfterCommitConfirmBody:
      '上次导入响应失败。如果结果可能不确定，请先重试当前选择；换包会开启新的幂等会话。',
    removeAfterCommitConfirmBody:
      '上次导入响应失败。如果结果可能不确定，请先重试当前选择；移除配置包会结束当前幂等会话。',
    replaceConfirmAction: '放弃选择',
    invalidFile: '请选择 .zip 格式的配置包。',
    reviewPackage: '检查配置包',
    previewing: '正在检查配置包…',
    importing: '正在导入配置包…',
    retryCurrentTitle: '重试这次已确认的导入',
    retryCurrentBody: '重试时请保留当前配置包和选择，服务端才能安全重放同一次导入会话。',
    repreviewRequiredTitle: '重新检查配置包',
    repreviewRequiredBody:
      '当前预检已过期，或已有资源发生了变化。请重新检查同一个包；仍然有效的选择会被保留。',
    overwriteResetTitle: '已清除覆盖选择',
    overwriteResetBody:
      '这些目标已变化或不再是之前确认的版本，因此已重置为安全操作：{{names}}。再次选择覆盖前请重新核对。',
    previewExpiringTitle: '当前预检即将过期',
    previewExpiringBody: '现在重新检查可以刷新基线，并保留仍然有效的选择。',
    repreviewAction: '重新检查',
    reviewTitle: '确认导入方式',
    working: '处理中…',
    emptyPackage: '这个包里没有资源。',
    commit: '导入',
    finalName: '新名字',
    target: '已有资源',
    notYours: '属于他人',
    actionLabel: '{{name}} 的导入方式',
    chooseTarget: '选择资源',
    chooseTargetHint: '找到多个匹配项，请明确选择要使用的资源。',
    secretsTitle: '凭据需要补充',
    secretFieldLabel: '{{type}} · {{name}} · {{field}}',
    secretRequiredHint: '必须填写此项，才能创建有效资源。',
    secretOptionalHint: '可以留空；该凭据不会导入，并会记录在导入报告中。',
    skippedSecretsTitle: '未填写的凭据',
    rootMismatchTitle: '这个配置包创建的是另一类资源',
    rootMismatchBody:
      '当前打开的是{{expected}}创建页，但配置包的根资源是{{actual}}“{{name}}”。导入完成后会自动打开实际根资源；若有留空凭据，则先保留导入报告供你确认。',
    openImportedRoot: '打开 {{name}}',
    permissionBlockedTitle: '你没有权限导入这个资源',
    permissionBlockedBody: '缺少权限：{{permissions}}',
    requirementsTitle: '本实例需要自备',
    requirementsHint:
      '这些前提只被配置包引用，并未打包在内。运行导入后的资源前，请确认本机已经具备。',
    requirement: {
      runtimes: '运行时',
      codeHosts: '代码平台',
      executables: '本地可执行文件',
      pluginSources: '插件来源',
      projectSkills: '项目技能',
      mcpKinds: 'MCP 形态',
      humanMembers: '人类账号',
    },
    humanMappingsTitle: '映射人类成员',
    humanMappingsHint:
      '用户名来自另一实例，可能不是本机的同一个人。导入前请逐一确认；同一来源账号承担的多个成员角色会一并映射。',
    humanRequired: '必需组长',
    humanOptional: '可选成员',
    humanSource: '工作组 {{workgroup}} · 成员名称 {{names}}',
    humanMap: '映射到本地用户',
    humanSkip: '不导入此成员',
    humanActionLabel: '@{{username}} 的导入选择',
    humanTarget: '@{{username}} 对应的本地用户',
    humanTargetPlaceholder: '搜索本地用户…',
    humanTargetRequired: '请选择一个启用中的本地用户来对应 @{{username}}。',
    humanSkipped: '导入后的工作组不会加入 @{{username}}。',
    secretsNotice_one: '有 {{count}} 处凭据字段已被脱敏，请在导入前填写。',
    secretsNotice_other: '有 {{count}} 处凭据字段已被脱敏，请在导入前填写。',
    importedCount_one: '已导入 {{count}} 个资源。',
    importedCount_other: '已导入 {{count}} 个资源。',
    completeTitle: '配置包已导入',
    completeSummary: '新建或更新 {{applied}} 个 · 复用 {{reused}} 个',
    importAnother: '继续导入其它配置包',
    createMethod: '创建方式',
    createManually: '手动创建',
    createMethodHint: '从导出的配置包导入资源及其引用的依赖。',
    exportPackage: '导出配置包',
    exporting: '正在导出…',
    exportHint: '将此资源及其引用的依赖打包下载。',
    saveBeforeExport: '请先保存当前更改，再导出配置包。',
    type: {
      agent: '代理',
      skill: '技能',
      mcp: 'MCP',
      plugin: '插件',
      workflow: '工作流',
      workgroup: '工作组',
    },
    appliedAction: {
      create: '已新建',
      update: '已更新',
    },
    action: {
      new: '新建',
      reuse: '复用已有',
      overwrite: '覆盖我的',
    },
  },
  common: {
    pagination: {
      aria: '分页',
      prev: '上一页',
      next: '下一页',
      pageOf: '第 {{page}} / {{pageCount}} 页',
      jumpFormAria: '跳转到指定页',
      jumpLabel: '页码',
      jumpAction: '跳转',
      jumpActionAria: '跳转到该页',
    },
    range: '范围 {{min}} – {{max}}',
    rangeZeroOr: '允许 0，或范围 {{min}} – {{max}}',
    rangeMaxOnly: '最大 {{max}}',
    rangeConverted: '{{range}}（{{converted}}）',
    done: '完成',
    searchEllipsis: '搜索…',
    searchCards: '搜索名称、描述或配置…',
    noMatches: '无匹配项',
    noAvailableOptions: '当前没有可用选项',
    allOptionsUnavailable: '当前选项均不可用',
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
    remove: '移除',
    deleteResourceActionHint: '永久删除此资源。',
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
    more: '更多',
    moreActions: '更多操作',
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
  unit: {
    hour_one: '{{count}} 小时',
    hour_other: '{{count}} 小时',
    minute_one: '{{count}} 分钟',
    minute_other: '{{count}} 分钟',
    second_one: '{{count}} 秒',
    second_other: '{{count}} 秒',
    year_one: '{{count}} 年',
    year_other: '{{count}} 年',
    day_one: '{{count}} 天',
    day_other: '{{count}} 天',
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
    unsavedSaveAndProceed: '保存到本机并离开',
    unsavedSaveFailed: '最新草稿未能保存，你仍停留在本页。',
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
    launchTitle: '身份与启动',
    launchHint: '设置运行时名称，以及启动时使用的二进制、协议与配置目录。',
    profileTitle: '执行配置',
    profileHint: '选择每次运行应用的模型行为与运行时专用参数。',
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
    fieldExtraArgs: '附加命令行参数',
    fieldExtraArgsHint:
      '追加到该运行时每次启动 argv 末尾的 fork 私有参数（如 --skip-safe-check）。平台保留的参数会在保存时被拒绝。仅 claude-code 协议可用。',
    fieldIsSandbox: '设置 IS_SANDBOX=1',
    fieldIsSandboxHint:
      '仅用于 Claude CLI 兼容；不会启用 OS 沙箱，也不会增加平台安全防护。默认关闭。',
    configDirEnvInvalid: '必须是合法的环境变量名（字母、数字、下划线，不以数字开头）。',
    configDirEnvReserved: '该变量名被平台保留（会与注入机制冲突），请换一个。',
    configDirNameInvalid: '必须是单层目录名：不能含路径分隔符，也不能是 "." 或 ".."。',
    fieldModel: '模型',
    fieldModelHint: '可选：传给该运行时的模型。留空时由 CLI 使用自己的默认值。',
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
    versionSourceImport: '导入',
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
    runtimeTest: {
      open: '使用运行时测试',
      title: 'MCP 运行时测试',
      warningTitle: '将执行真实 MCP 调用',
      warningBody:
        '运行时只挂载当前 MCP，但调用仍可能产生真实读写或外部副作用。关闭此对话框不会停止测试会话。',
      loading: '正在恢复测试会话…',
      runtime: '运行时',
      runtimeSummary: '运行时：{{runtime}}',
      runtimeLoadError: '无法加载支持 MCP 测试的运行时。',
      runtimeUnavailable: '当前没有已启用且支持 MCP 测试的运行时。',
      idleCountdown: '空闲会话将在 {{time}} 后自动结束',
      conversationRegion: '测试对话',
      firstMessage: '第一条测试消息',
      nextMessage: '继续对话',
      messagePlaceholder: '例如：列出你提供的工具，并调用一个只读工具验证返回结果。',
      start: '开始测试',
      starting: '正在启动…',
      saveAndStart: '保存并开始',
      useSaved: '使用已保存版本',
      send: '发送',
      sending: '发送中…',
      cancelTurn: '取消当前轮次',
      canceling: '正在取消…',
      endNow: '立即结束测试',
      endConfirmTitle: '立即结束 MCP 测试？',
      endConfirmBody:
        '当前轮次会被终止，运行时进程与私有会话目录会被回收。此操作不同于仅关闭对话框。',
      endingHint: '正在终止运行时并回收会话状态；可以关闭对话框，后台会继续完成。',
      endedHint: '本次测试已结束。历史执行过程仍可查看，也可以从下方开始一条新测试。',
      dirtyBasis: '当前表单有未保存改动。可先保存并开始，或明确使用已保存版本。',
      activeUsesSaved: '当前会话固定使用启动时的已保存配置；未保存改动不会进入该会话。',
      receiptReplaced:
        '该启动请求已执行，但记录已被后续测试替代；现已显示最新测试，系统没有重复发送原请求。',
      draftChangedDuringSave: '保存期间表单又发生了修改；未启动测试，请确认后重试。',
      turnOutcome: {
        failed: '上一轮执行失败',
        canceled: '上一轮已取消',
        timedOut: '上一轮执行超时',
        interrupted: '上一轮执行被中断',
        diagnostic: '诊断代码：{{code}}',
        noDiagnostic: '运行时未返回诊断代码。',
      },
      status: {
        new: '新测试',
        running: '轮次执行中',
        idle: '等待下一条消息',
        ending: '正在结束',
        ended: '已结束',
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
    fieldNameHint: '支持中文；不能以 _ 开头，不能含换行等控制字符，至多 128 字。',
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
      nameInvalid: '名称不能以 _ 开头，不能含换行 / 制表符等控制字符，长度 ≤ 128 字。',
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
    fieldNameHint: '支持中文；不能以 _ 开头，不能含换行等控制字符，至多 128 字。',
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
      resourcesInvalid: '成员代理存在 {{count}} 项缺失或不可用的资源引用，修复前不能启动。',
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
    copying: '复制中…',
    copyActionHint: '先完整保存当前草稿，再创建一个归你所有的私有副本。',
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
    sectionOutputContract: '交付约定',
    fieldOutputContract: '主要交付形式',
    outputContractFiles: '文件交付',
    outputContractFilesHint: '成果应写入工作副本并合并回任务工作树；完成时会检查零文件变更。',
    outputContractDiscussion: '讨论结论',
    outputContractDiscussionHint: '主要成果是房间里的可执行结论；文件只作辅助，不做零变更告警。',
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
    systemMessages: {
      assignmentAgentUnresolvable: '派单「{{title}}」失败：无法解析 @{{member}} 的 agent。',
      assignmentFailed: '派单「{{title}}」失败：{{detail}}',
      assignmentProtocolViolation: '派单「{{title}}」失败：输出协议错误（{{detail}}）',
      assignmentReportedFailed: '@{{member}} 报告派单「{{title}}」失败：{{detail}}',
      assignmentCanceledByMember: '任务成员取消了派单「{{title}}」。',
      messageTurnFailed: '{{member}} 的消息轮失败：{{detail}}',
      freeCollabConverged: '自由协作已收敛，共完成 {{count}} 项任务：\n{{details}}',
      freeCollabConvergedEmpty: '自由协作已收敛，但没有已完成的任务。',
      leaderNudge:
        '自动模式：本轮既没有派发任务，也没有宣布完成。若目标已完成，请提交 wg_decision done；否则派发下一项任务，或说明阻塞原因。',
      maxRoundsFailed: '工作组已达到最大轮数（{{maxRounds}}）。',
      freeCollabDeadlock: '自由协作陷入死锁：仍有开放任务，但没有可认领的 agent 成员。',
      internalDriveError: '驱动 {{item}} 时发生内部错误：{{detail}}',
      completionGateWaiting: '完成门：等待人工确认。{{summary}}',
      zeroDeltaDone:
        '⚠️ 已完成 {{count}} 个派单，但规范工作树没有文件变更。成果可能没有合并回来；请确认 worker 使用自己的工作副本和相对路径。',
      leaderAgentUnresolvable: '无法解析 leader agent（{{member}}），任务将失败。',
      roundCapDispatchIgnored: '已达到轮数上限；最终收尾轮里的新派单已忽略，正在汇总已有成果。',
      tasksAddRejected: '拒绝 @{{member}} 提交的 wg_tasks_add：{{detail}}',
      duplicateTasksDropped: '已丢弃 @{{member}} 的 {{count}} 个重复任务（标题去重）。',
      visibilityMessagesDropped: '因可见性开关，已丢弃 @{{member}} 的 {{count}} 条消息。',
      batchAgentUnresolvable: '跳过 @{{member}} 的任务批次：无法解析 agent。',
      batchFailed: '@{{member}} 的 {{count}} 项任务批次失败：{{detail}}',
      batchProtocolViolation: '@{{member}} 的任务批次在重试后仍违反输出协议（{{detail}}）',
    },
    room: {
      empty: '还没有消息。发一条话启动讨论；@成员名 即直接派单。',
      roundDivider: '第 {{n}} 回合',
      authorSystem: '系统',
      replyingTo: '回复 {{author}}',
      openReferencedMessage: '定位到 {{author}} 的原消息',
      referencedMessageUnavailable: '原消息不可用',
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
      nameInvalid: '名称不能以 _ 开头，不能含换行 / 制表符等控制字符，长度 ≤ 128 字。',
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
  webhooksPage: {
    title: 'Webhook 自动化',
    subtitle: '把 GitLab 事件接进平台，按规则启动工作，并从投递记录快速定位问题。',
    tabAria: 'Webhook 配置分区',
    forbiddenTitle: '需要更多权限',
    forbiddenDescription: 'Webhook 配置按端点、触发规则与投递权限分别展示。',
    tabs: { endpoints: '接收端点', triggers: '触发规则', deliveries: '投递记录' },
  },
  runtimeParameters: {
    insert: '插入参数',
    insertFor: '为“{{field}}”插入参数',
    back: '返回上一级参数分类',
    categoryAria: '打开“{{category}}”分类，共 {{count}} 个参数',
    categoryCount: '{{count}} 项',
    openCategory: '打开分类查看其中的参数。',
    selectEventsFirst: '请先选择至少一种 Webhook 事件类型，再插入事件参数。',
    invalidLocalParameter: '端口“{{port}}”不能生成合法的运行期模板 token，请先重命名端口。',
    search: '搜索参数名称、说明或 token',
    noMatches: '没有匹配的参数',
    inserted: '已插入“{{parameter}}”到“{{field}}”',
    stale: '目标字段已发生变化，请重新打开参数选择器。',
    unavailable: '当前字段暂时不能插入参数。',
    invalidJsonTarget: '参数只能插入到有效 JSON 的字符串值内部。',
    replaceWholeValue: '选择参数会替换“{{field}}”的当前值。',
    optionalWebhook: '仅由 Webhook 启动时提供；其他启动方式会在预检时提示缺少上下文。',
    scope: { global: '全局参数', local: '局部参数' },
    type: { trigger: '触发参数', runtime: '运行环境', node: '当前节点', context: '上下文' },
    source: {
      webhook: 'Webhook',
      task: '任务运行期',
      currentNode: '当前节点输入',
      review: 'Review 上下文',
    },
    group: {
      webhookContext: '事件上下文',
      webhookApi: 'API 定位',
      repository: '仓库',
      identity: '任务与节点',
      iteration: '迭代与分片',
      review: 'Review',
      clarify: '反问',
      input: '输入端口',
    },
    webhookLabels: {
      event_type: '事件类型',
      provider: '代码平台',
      repo_path: '仓库路径',
      repo_http_url: '仓库 HTTP 地址',
      repo_ssh_url: '仓库 SSH 地址',
      branch: '事件分支',
      target_branch: '目标分支',
      default_branch: '默认分支',
      mr_iid: 'MR / PR 编号',
      mr_id: 'MR / PR 全局 ID',
      mr_title: 'MR / PR 标题',
      mr_url: 'MR / PR 地址',
      commit_sha: '提交 SHA',
      commit_before: '推送前 SHA',
      comment_text: '评论正文',
      comment_author: '评论作者',
      comment_id: '评论 ID',
      comment_thread_id: '评论线程 ID',
      comment_url: '评论地址',
      comment_position_json: '行内评论位置 JSON',
      pipeline_status: '流水线状态',
      pipeline_id: '流水线 ID',
      pipeline_url: '流水线地址',
      api_base_url: 'API 根地址',
      project_id: '项目 ID',
      project_web_url: '项目网页地址',
      repo_owner: '仓库所有者',
      repo_name: '仓库名称',
      author_id: '事件作者 ID',
      issue_iid: 'issue 编号',
      issue_title: 'issue 标题',
      issue_url: 'issue 地址',
      issue_body: 'issue 正文',
      issue_labels: 'issue 当前全部标签（逗号分隔）',
      added_labels: '本次新增的标签（逗号分隔）',
      event_json: '原始事件 JSON',
    },
    builtins: {
      __repo_path__: {
        label: '主仓库工作目录',
        agent: '当前 Agent 运行的主仓库工作目录绝对路径。',
        workgroup: '被调用工作组子任务的主仓库隔离工作目录绝对路径。',
      },
      __base_branch__: {
        label: '基准分支',
        agent: '当前任务主仓库的基准分支。',
        workgroup: '被调用工作组子任务主仓库的基准分支。',
      },
      __task_id__: {
        label: '任务 ID',
        agent: '当前任务的稳定 ID。',
        workgroup: '发起调用的父任务 ID。',
      },
      __node_id__: {
        label: '节点 ID',
        agent: '当前 Agent 节点 ID。',
        workgroup: '父工作流中发起调用的节点 ID。',
      },
      __iteration__: {
        label: '迭代轮次',
        agent: '当前节点所在循环的迭代序号；不在循环中时为空。',
        workgroup: '调用节点所在循环的迭代序号；不在循环中时为空。',
      },
      __shard_key__: {
        label: '分片键',
        agent: '当前 fan-out 分片键；不在分片中时为空。',
        workgroup: '调用节点的 fan-out 分片键；不在分片中时为空。',
      },
      __review_rejection__: {
        label: 'Review 驳回原因',
        agent: 'Review 驳回后重跑时的驳回说明；其他运行上下文为空。',
      },
      __review_comments__: {
        label: 'Review 评论',
        agent: 'Review 迭代注入的评论正文；其他运行上下文为空。',
      },
      __iterate_target_port__: {
        label: '迭代目标端口',
        agent: 'Review 要求重做时指定的目标输出端口；其他运行上下文为空。',
      },
      __sibling_outputs__: {
        label: '同级输出',
        agent: 'Review 迭代时提供的其他同级节点输出；其他运行上下文为空。',
      },
      __clarify_iteration__: {
        label: '反问轮次',
        agent: '当前反问上下文的轮次；未进入反问时为空。',
      },
      __clarify_remaining__: {
        label: '剩余反问次数',
        agent: '当前节点还可使用的反问次数；未进入反问时为空。',
      },
      __repos__: {
        label: '全部仓库',
        agent: '当前任务所有仓库的绝对工作目录，每行一个路径。',
        workgroup: '子任务仓库清单，每行形如“- 名称: 隔离工作目录”。',
      },
      __repo_names__: {
        label: '仓库挂载名称',
        agent: '当前任务所有仓库的相对挂载路径，每行一个；根仓库为空行。',
        workgroup: '子任务仓库名称的逗号分隔清单；根仓库显示为“(root)”。',
      },
      __repo_count__: {
        label: '仓库数量',
        agent: '当前任务挂载的仓库数量。',
        workgroup: '被调用工作组子任务挂载的仓库数量。',
      },
      __repo_group__: {
        label: '仓库组名称',
        agent: '当前任务的仓库组名称；没有仓库组时为空。',
      },
    },
    localInputLabel: '输入端口：{{port}}',
    localInputDescription: '来自已连接上游输出的运行期文本，使用当前节点的目标端口名引用。',
    reviewCommentsLabel: 'Review 评论',
    reviewCommentsDescription: '注入到 Review 提示词中的评论正文。',
  },
  webhookTriggers: {
    eyebrow: '决定何时运行',
    title: '触发规则',
    subtitle: '选择哪些仓库与事件需要响应，再指定要启动的编排或数字员工。',
    new: '新建规则',
    empty: '还没有触发规则',
    emptyDescription: '先准备一个接收端点，再创建规则，决定事件命中后启动什么工作。',
    emptyReadonlyDescription: '还没有创建任何触发规则。',
    ownerLabel: '归属',
    ownedByMe: '我的规则',
    enabledChip: '已启用',
    disabledChip: '已禁用',
    corruptBadge: '配置损坏',
    scopeAll: '全部仓库',
    scopeExact: '{{n}} 个仓库',
    scopePrefix: '{{prefix}}*',
    enabledSwitch: '启用',
    firesButton: '触发记录',
    deleteConfirm: '确认删除？',
    dialogCreate: '新建规则',
    dialogEdit: '编辑规则',
    firesTitle: '触发记录 · {{name}}',
    firesEmpty: '还没有触发记录。',
    resetCircuit: '重置熔断',
    eventCount: '{{count}} 类事件',
    terminalProtectionChip: 'MR / PR 终态即停',
    flowAria: '规则执行路径',
    saveAction: '保存规则',
    commonOnlySaveAction: '仅保存通用设置',
    historyActions: '规则草稿历史',
    undo: '撤销',
    redo: '重做',
    historyCompositionBlocked: '请先完成当前文字输入，再撤销或重做规则草稿。',
    discardTitle: '放弃未保存的修改？',
    discardDescription: '当前规则还没有保存，关闭后这些修改会丢失。',
    discardAction: '放弃修改',
    columns: { name: '名称', rule: '规则', target: '目标', state: '状态' },
    kinds: {
      workflow: '工作流',
      agent: 'Agent',
      workgroup: '工作组',
      'digital-employee': '数字员工',
    },
    kindDescriptions: {
      workflow: '运行完整编排，适合审计、修复等多阶段流程。',
      agent: '直接启动一个 Agent，适合单一、快速任务。',
      workgroup: '让多个成员协作处理同一个目标。',
      'digital-employee': '把事件交给有状态的数字员工，由它接手工作并持续关注后续事件。',
    },
    spaces: { eventRepo: '事件仓库', scratch: '临时工作区' },
    spaceDescriptions: {
      eventRepo: '使用事件对应的仓库与分支；未导入时可自动拉取。',
      scratch: '每次创建空白 Git 仓库；不拉取事件仓，也不推送远端。',
    },
    inputKinds: {
      text: '文本',
      files: '文件列表',
      enum: '选项',
      git: 'Git 分支',
      upload: '上传文件',
    },
    last: { launched: '上次成功', failed: '上次失败' },
    outcomes: {
      launched: '已启动',
      'launch-failed': '启动失败',
      'skipped-circuit-open': '已暂停：连续触发达到上限',
      'skipped-repo-unregistered': '已跳过：仓库尚未导入',
      'skipped-owner-invalid': '已跳过：规则负责人不可用',
      'skipped-trigger-disabled': '已跳过：规则已停用',
      'skipped-mr-stream-closed': '已跳过：MR / PR 已关闭',
      'skipped-mr-stream-merged': '已跳过：MR / PR 已合入',
      'skipped-mr-stream-terminal': '已跳过：终态事件先完成启动封锁',
      'skipped-mr-stream-identity-missing': '已跳过：缺少稳定的 MR / PR 标识',
      'skipped-trigger-invalid': '已跳过：终态保护配置无效',
      'skipped-legacy-admission-frozen': '已跳过：旧版入口已冻结（切换到数字员工任务）',
    },
    flow: { scope: '仓库范围', events: '响应事件', target: '启动目标' },
    steps: { scope: '范围', events: '事件', target: '执行', review: '复核' },
    stepLeads: {
      scope: '先给规则命名，并限定它接收哪个端点、覆盖哪些仓库。',
      events: '选择会触发自动化的事件；可继续用分支、评论指令和 bot 账号缩小范围。',
      target: '选择事件命中后要启动的资源，并把事件内容映射成执行输入。',
      review: '确认路由方向与安全边界。保存后，后续新事件会按这条规则执行。',
    },
    review: {
      endpoint: '接收端点',
      scope: '仓库范围',
      events: '响应事件',
      terminalProtection: '终态保护',
      terminalProtectionOn: 'MR / PR 关闭或合入时停止运行中的任务',
      terminalProtectionOff: '保持原有事件行为',
      target: '启动目标',
      space: '执行空间',
      separator: '→',
      safetyNote: '同一 MR 或分支连续触发 {{count}} 次后会暂停，避免自动化循环失控。',
    },
    events: {
      push: 'Push',
      tag_push: 'Tag Push',
      mr_opened: 'MR / PR 打开',
      mr_updated: 'MR / PR 更新',
      mr_merged: 'MR / PR 合并',
      mr_closed: 'MR / PR 关闭',
      note: 'MR / PR 评论',
      pipeline_failed: '流水线失败',
      pipeline_succeeded: '流水线成功',
      issue_labeled: 'Issue 打标签',
      issue_comment: 'Issue 评论',
    },
    scope: { all: '全部', prefix: '前缀', exact: '精确清单', exactPlaceholder: 'group/sub/repo' },
    fields: {
      name: '名称',
      endpoint: '端点',
      endpointPlaceholder: '选择端点',
      endpointImmutable: '保存后不能更换接收端点；需要换端点时请新建规则。',
      scope: '仓库范围',
      scopeHint: '可覆盖全部仓库、一个路径前缀，或明确列出的仓库。',
      events: '事件类型',
      cancelOnMrTerminal: 'MR / PR 终态保护',
      cancelOnMrTerminalLabel: 'MR / PR 关闭或合入时停止运行中的任务',
      cancelOnMrTerminalHint:
        '仅用于由 MR / PR 打开事件启动的规则；关闭和合入会成为只控制停止、不启动新任务的事件。',
      cancelOnMrTerminalError: '请选中“MR / PR 打开”，并移除“关闭”和“合入”事件后再保存。',
      eventsHint: '流水线类事件不受忽略名单过滤（修到绿循环的前提）',
      pipelineException:
        '流水线事件始终会被接收，即使作者在忽略名单中；连续触发上限负责阻止修复循环失控。',
      branchFilter: '只响应这些分支',
      branchFilterHint: '支持通配符，例如 release/*。MR 按目标分支判断；留空表示全部分支。',
      commandPrefix: '评论指令前缀',
      commandPrefixHint: '仅对 MR 评论生效，例如 /fix；留空则响应所有评论。',
      ignoreUsernames: '忽略这些 GitLab 用户',
      ignoreUsernamesHint: '常用于填写自动化 bot 账号，避免自己的 push、MR 或评论再次触发规则。',
      launchKind: '目标类型',
      kindImmutable: '目标类型保存后不能更换；需要更换时请新建规则。',
      target: '目标',
      targetPlaceholder: '选择目标',
      executionSpace: '执行空间',
      workingBranchTemplateHint: '可使用下方 webhook trigger 变量；渲染结果仍须是合法分支名。',
      scratchNotice:
        '每次触发都会创建新的空白 Git 仓库；事件仓不会被拉取，事件分支也不会作为检出 ref。',
      inputMappings: '输入映射',
      inputMappingsHint: '把仓库、分支、MR 等事件内容交给工作流；Git 输入会自动使用事件分支。',
      inputMappingsScratchHint:
        '把事件内容交给工作流；Git 输入仍携带事件分支值，但不会因此检出事件仓。',
      noInputs: '该工作流没有声明输入。',
      eventBranch: '分支来自事件',
      templatePlaceholder: '例如：检查这个 MR 的失败原因',
      unmappable: 'Webhook 事件不能提供这种输入，请改用其他目标或调整工作流。',
      description: '任务提示词模板',
      goal: '工作组目标模板',
      employeeUnsupportedTitle: '该数字员工不能接收事件任务',
      employeeUnsupportedBody:
        '它发布的受理契约只支持上传文件；请选择可接收正文或外部工作 ID 的数字员工。',
      agentDescriptionHint: '该 Agent 没有声明输入端口；Webhook 启动时把这段模板作为任务提示词。',
      agentInputHint: '{{kind}} 输入。Webhook 启动时把渲染后的文本传给端口；{{description}}',
      agentInputListHint: '{{kind}} 输入。每行一项，运行时按换行分隔；{{description}}',
      agentLoading: '正在读取 Agent 输入定义…',
      agentRefreshing: 'Agent 输入定义正在刷新；当前内容会保留，刷新完成前暂停保存和参数插入。',
      agentDefinitionChangedTitle: 'Agent 定义已变化',
      agentDefinitionChangedBody:
        '请先完成当前输入，再应用最新 Agent 定义。在应用前，保存和参数插入会保持暂停。',
      agentApplyDefinition: '应用最新定义',
      agentUnavailableTitle: '暂时无法读取 Agent 输入定义',
      agentUnavailableBody:
        '目标 {{name}}（{{id}}）的现有任务参数会原样保留。你可以重试，或仅修改名称、事件等通用设置后保存。',
      agentOpaqueSummary: '当前保留：description={{description}}，inputs={{inputs}}。',
      agentCommonOnly:
        '仅保存通用设置不会取得或重写这些 Agent 专属参数。修改过 Agent 参数后此路径会关闭。',
      retryAgent: '重试读取',
      agentRepairsTitle: '需要确认旧的 Agent 参数',
      agentRepairsBody:
        '目标的输入结构已变化，旧的 description、孤儿端口或不兼容值不会被静默删除。确认修复后才可保存。',
      agentRepairAction: '移除不兼容旧值',
      agentBlockersTitle: '该 Agent 不能由 JSON Webhook 直接启动',
      agentBlockersBody: '目标含文件上传、signal 或无效端口名；请调整 Agent 输入，或选择其他目标。',
      agentIssueDescriptionRequired: '任务提示词不能为空。',
      agentIssueDescriptionTooLong: '任务提示词超过 65536 个字符。',
      agentIssueRequiredInputs: '请填写所有必填 Agent 输入。',
      agentTargetSwitchTitle: '切换 Agent 目标？',
      agentTargetSwitchDescription:
        '当前 Agent 的参数会暂存；切回该 Agent 时会恢复。新目标会按自己的输入定义显示。',
      agentTargetSwitchAction: '切换目标',
      templateVarsLabel: '事件变量——点击插入到光标处：',
      varGroupContext: '事件上下文',
      varGroupApi: 'API 定位（回帖 / 调接口用）',
      vars: {
        event_type: '事件类型（push / mr_opened / note / pipeline_failed 等）。',
        provider: '代码平台：gitlab 或 github。调接口前用它区分两边的形态。',
        repo_path: '仓库路径（GitLab 的 group/repo、GitHub 的 owner/repo）。',
        repo_http_url: '仓库 HTTP 克隆地址。',
        repo_ssh_url: '仓库 SSH 克隆地址。',
        branch: '事件分支：push 为被推分支，MR / 评论 / 流水线为源分支，tag 事件为 tag 名。',
        target_branch: 'MR / PR 的目标分支。',
        default_branch: '仓库默认分支（自动建 MR 时可作目标分支）。',
        mr_iid: 'MR / PR 编号——REST 接口路径里用的就是它。',
        mr_title: 'MR / PR 标题。',
        commit_sha: '事件对应的提交 SHA。',
        commit_before: 'push 之前的提交 SHA，与 commit_sha 配对可算出本次推送范围。',
        comment_text: '评论正文。',
        comment_author: '评论者用户名。',
        pipeline_status: '流水线结论（failed / success 等）。',
        event_json: '原始事件 JSON（截断至 32 KiB）。优先用上面的精确变量，这里只作兜底。',
        api_base_url:
          'API 根地址：GitLab 为 <实例>/api/v4；GitHub 为 https://api.github.com，GHES 为 <实例>/api/v3。',
        project_id:
          '项目数字 ID。GitLab 的 /projects/:id 用它；GitHub 侧调接口请改用 repo_owner + repo_name。',
        project_web_url: '仓库网页地址。',
        repo_owner: 'GitHub REST 路径里的 {owner}；GitLab 侧为 namespace 路径。',
        repo_name: 'GitHub REST 路径里的 {repo}。',
        author_id: '事件作者的平台用户 ID（指派、@ 提及用）。',
        issue_iid: 'issue 编号——REST 路径用的就是它。',
        issue_title: 'issue 标题。',
        issue_url: 'issue 网页地址。',
        issue_body: 'issue 正文——需求内容本身。',
        issue_labels:
          'issue 当前的全部标签，逗号分隔。判断「有没有某个标签」用这个；本次改了什么看 added_labels。',
        added_labels:
          '本次新增的标签，逗号分隔。GitLab 侧是与改动前的差集，所以本来就有的标签不会被当成新加的。',
        mr_id: 'MR / PR 的全局 ID。REST 路径请用 mr_iid，这个只在 GraphQL 等少数接口用。',
        mr_url: 'MR / PR 网页地址。',
        comment_id: '评论本身的 ID（编辑、删除、加表情用；GitHub 的回复接口也用它）。',
        comment_thread_id:
          '讨论线程 ID——回复到同一条线程用它。GitLab 即 discussion_id；GitHub 普通 PR 评论没有线程，此处为空。',
        comment_url: '评论网页地址。',
        comment_position_json:
          '行内评论的位置参数（JSON）。键名与该平台新建评论接口的参数一一对应，可原样回传；非行内评论为空。',
        pipeline_id: '流水线 / workflow run 的 ID（重跑、列 job、拉日志用）。',
        pipeline_url: '流水线网页地址。',
      },
      maxFires: '连续触发上限',
      maxFiresHint: '同一 MR 或分支达到上限后暂停，防止自动化反复触发自己。',
      autoRegister: '自动注册仓库',
      autoRegisterLabel: '事件仓库尚未导入时，允许平台自动拉取并登记',
    },
    firesColumns: {
      stream: '流',
      outcome: '结果',
      result: '已启动工作',
      task: '编排任务',
      employeeCase: '数字员工任务',
      time: '时间',
    },
  },
  webhookDeliveries: {
    eyebrow: '观察与排障',
    title: '投递记录',
    subtitle: '查看 GitLab 事件是否到达、是否通过验签，以及有没有匹配到触发规则。',
    filterAria: '按状态过滤',
    empty: '还没有投递记录',
    emptyDescription: '在 GitLab 保存 Webhook 后，新事件会自动出现在这里。',
    filteredEmpty: '当前筛选没有记录',
    filteredEmptyDescription: '调整筛选条件，或清除筛选查看全部投递。',
    totalCount: '共 {{total}} 条',
    filterAll: '全部',
    filterAllEvents: '全部事件',
    filterAllRepos: '全部仓库',
    filterEventAria: '按事件类型过滤',
    filterRepoAria: '按仓库过滤',
    filtersLabel: '投递筛选',
    filterEventLabel: '事件',
    filterRepoLabel: '仓库',
    replay: '重放',
    replayBadge: '重放',
    replaySuccess: '已创建重放投递 {{id}}，结果会自动刷新。',
    rejectedNotReplayable: 'Secret 验证失败的请求不可信，不能重放；请先修正 GitLab 中的 Secret。',
    detailTitle: '投递详情',
    bodyPruned: '（原始 body 已按保留策略清理）',
    columns: { event: '事件', repo: '仓库', status: '状态', time: '时间' },
    detail: {
      status: '处理状态',
      event: '事件类型',
      repo: '仓库',
      received: '接收时间',
      uuid: '事件 UUID',
      stream: '事件流',
      payload: '事件内容',
    },
    terminalControl: {
      title: 'MR / PR 终态控制',
      kind: '控制事实',
      status: '收敛状态',
      revision: '事件流版本',
      targets: '命中任务',
      hiddenTargets: '另有 {{count}} 个命中任务因任务访问权限而隐藏。',
      targetTable: '可见任务的终态控制结果',
      task: '任务',
      cancel: '取消结果',
      release: '运行资源释放',
      workspace: '工作区',
      kinds: {
        'fence-closed': 'MR / PR 已关闭',
        'fence-merged': 'MR / PR 已合入',
        'clear-closed': 'MR / PR 已重新打开',
      },
      statuses: {
        pending: '待处理',
        leased: '处理中',
        'waiting-launches': '等待启动所有权释放',
        retryable: '需要重试',
        succeeded: '已收敛',
      },
      cancelOutcomes: {
        canceled: '已取消',
        'already-terminal': '此前已终态',
        'not-applicable': '不适用',
      },
      releaseOutcomes: {
        pending: '待确认',
        'no-active-owner': '无活动执行所有者',
        released: '已释放',
        unreaped: '存在未回收进程',
      },
      workspaceStates: { retained: '已保留', pruning: '清理中', pruned: '已清理' },
    },
    statuses: {
      received: '已接收',
      processing: '分发中',
      rejected: '验签失败',
      ignored: '已忽略',
      matched: '已分发',
      failed: '失败',
    },
    reasons: {
      'invalid-token': 'Secret 不匹配',
      'missing-token': '缺少 Secret',
      'endpoint-disabled': '端点已停用',
      'no-trigger-matched': '没有规则命中',
      'unsupported-event': '暂不支持该事件',
      'parse-failed': '请求内容无法解析',
      'internal-error': '平台内部错误',
      interrupted: '服务重启时中断',
      'terminal-control-accepted': '已接受终态控制',
      'mr-stream-identity-missing': '缺少稳定的 MR / PR 标识',
    },
  },
  scheduled: {
    repairBadge: '需修复',
    title: '定时任务',
    operations: {
      subtitle: '集中查看周期执行、处理失败，并按需立即运行',
      viewAria: '定时任务业务视图',
      views: { all: '全部', enabled: '启用', attention: '需关注', paused: '已暂停' },
      searchPlaceholder: '搜索日程、Owner 或执行主体…',
      searchLabel: '搜索定时任务',
      filters: '筛选',
      activeFilters: '已启用 {{count}} 个高级筛选',
      filterTitle: '筛选定时任务',
      launchKindLabel: '启动类型',
      launchKinds: { all: '全部', workflow: '工作流', workgroup: '工作组', agent: 'Agent' },
      outcomeLabel: '最近结果',
      outcomes: { all: '全部', never: '从未运行', launched: '已启动', failed: '失败' },
      applyFilters: '应用筛选',
      noMatchesDescription: '当前业务视图和筛选条件下没有匹配的定时任务。',
      columns: { schedule: '日程', state: '状态与最近运行', next: '下次运行' },
    },
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
    runNowBlocked: {
      'migration-needed': '暂时无法立即运行：请先修复旧版定时配置。',
      'payload-missing': '暂时无法立即运行：请先恢复任务启动配置。',
      'spec-missing': '暂时无法立即运行：请先恢复定时规则。',
    },
    runNowUnknownTitle: '立即运行结果暂时未知',
    runNowUnknownBody:
      '服务端可能已经启动了一个任务。请勿再次发送请求；先检查任务列表中是否出现了新的运行记录，再决定下一步。',
    runNowUnknownInspect: '检查任务列表',
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
      'code-round': '代码检视',
    },
    // RFC-243 PR-5 — 子任务嵌套 / 调用节点直链。
    scopeFilter: {
      top: '仅顶层',
      all: '含子任务',
    },
    scopeFilterAria: '子任务显示范围',
    expandChildren: '展开子任务',
    collapseChildren: '收起子任务',
    expandChildrenCount: '展开 {{count}} 个匹配子任务',
    noChildTasks: '无子任务',
    childBadge: '子任务',
    parentTaskChip: '父任务',
    parentTaskUnavailable: '父任务不可见',
    runDetailButton: '运行详情',
    childTaskLink: '子任务',
    childTaskUnavailable: '子任务不可见或已删除',
    operations: {
      subtitle: '跟踪执行、处理阻塞，并回看历史结果',
      updated: '任务列表已有更新',
      refresh: '刷新列表',
      viewAria: '任务业务视图',
      views: {
        all: '全部',
        active: '进行中',
        attention: '需处理',
        finished: '已结束',
      },
      searchPlaceholder: '搜索任务、主体或仓库…',
      searchLabel: '搜索任务',
      filters: '筛选',
      activeFilters: '已启用 {{count}} 项高级筛选',
      filterTitle: '筛选任务',
      statuses: '精确状态',
      statusPlaceholder: '选择状态',
      scopeLabel: '任务用户范围',
      scope: { mine: '我的任务', shared: '与我共享', all: '所有任务' },
      originLabel: '启动来源',
      origin: {
        all: '全部来源',
        manual: '手动启动',
        scheduled: '定时启动',
        event: '事件中心触发',
        webhook: 'Webhook 触发',
        api: 'API 启动',
      },
      categoryLabel: '任务分类',
      category: {
        all: '全部任务',
        orchestration: '编排任务',
        'digital-employee': '数字员工任务',
      },
      digitalEmployeeSection: '数字员工任务',
      digitalEmployeeSectionHint: '需求、自动开发、MR 看护与合入生命周期',
      digitalEmployeeTask: '数字员工任务',
      digitalEmployeeOwner: '数字员工',
      applyFilters: '应用筛选',
      resultCount: '共显示 {{count}} 个任务分支',
      addedCount: '已追加 {{count}} 个任务分支',
      addedChildrenCount: '已追加 {{count}} 个子任务分支',
      columns: { task: '任务', execution: '执行', time: '时间' },
      loadMore: '加载更多任务',
      loadingMore: '正在加载更多任务…',
      loadMoreChildren: '加载更多子任务',
      loadingMoreChildren: '正在加载更多子任务…',
      childCount: '{{count}} 个子任务',
      openAlertDetail: '{{count}} 个未解决告警，请优先处理',
      contextMatches: '包含 {{count}} 个匹配子任务',
      awaitingReview: '等待复核决定',
      awaitingHuman: '等待人工回答',
      pendingDetail: '等待调度执行',
      runningDetail: '任务正在执行',
      finishedDetail: '执行已结束',
      duration: {
        queued: '排队 {{dur}}',
        running: '已运行 {{dur}}',
        accumulated: '累计运行 {{dur}}',
      },
    },
    detailTitleIdLabel: '任务 ID',
    webhookSource: {
      comment: '查看原始评论',
      mergeRequest: '查看原始 MR/PR',
      issue: '查看原始 issue',
      pipeline: '查看原始流水线',
      commit: '查看原始提交',
      project: '查看源项目',
    },
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
    commitOutcomeSkippedExcluded: '只有被排除的改动',
    commitOutcomeExcludedHistory: '待推送历史含排除路径，已阻止推送',
    subrepoPushed: '已推送',
    subrepoNotPushed: '未推送',
    commitOutcomeSkippedEmpty: '无改动',
    commitExclusions: '平台规则已排除 {{count}} 个路径',
    commitExclusionsHistory: '待推送本地历史命中 {{count}} 个排除路径',
    commitFiles: '{{files}} 个文件，+{{ins}}/-{{del}}',
    metaStarted: '开始',
    metaFinished: '完成',
    metaError: '错误',
    // RFC-066: multi-repo summary on the task detail page.
    multiRepoSummary: '{{count}} 个仓库',
    repoGroupChip: '组：{{name}}',
    repoReadonlyChip: '只读',
    repoReadonlyDirty: '{{count}} 处改动被丢弃（只读成员不提交推送）',
    repoReadonlyDirtyBanner:
      '只读成员 {{mounts}} 在本次任务中被改动过——这些改动没有被提交或推送。只读成员按设计不参与自动提交推送（D11）。',
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
    resumeRepoPrepFailed:
      '任务卡在「准备仓库」这一步（克隆 / 拉取失败），工作树还没建出来。修好网络或权限后，点右侧「重试准备仓库」即可，不必重新启动任务。',
    repoPrepStepName: '准备仓库',
    retryRepoPrep: '重试准备仓库',
    retryRepoPrepPending: '重试中…',
    resumeUnavailableWorkgroup:
      '组任务失败后不支持原地继续（组的编排由引擎驱动，恢复靠重启而非续跑）。请重新启动该工作组。',
    resumeLaunchLink: '启动新任务 →',
    failure: {
      generic: '任务执行失败。',
      'script-output-truncated':
        '脚本的 stdout 超出保留窗口，单端口模式无法保证端口值完整，已判失败。',
      'code-host-not-configured': '该代码平台还没有配置 base URL 与 token（设置页 → 代码平台）。',
      'code-host-project-foreign':
        '任务仓库既不属于所配置的代码平台主地址，也未命中允许的仓库 URL 前缀；已拒绝调用而不是去改一个同名项目。',
      'code-host-project-unresolved': '无法从任务推导出目标项目，请在节点上显式填写。',
      'code-host-param-missing': '必填参数为空。',
      'code-host-param-invalid': '参数取值不合法。',
      'trigger-context-missing': '工作流引用了 webhook 触发数据，但该任务没有 webhook 触发上下文。',
      'trigger-context-invalid': '任务冻结的 webhook 触发上下文已损坏，无法安全使用。',
      'trigger-field-unavailable': '工作流引用的 webhook 字段不适用于当前事件类型。',
      'code-host-trigger-context-missing':
        '节点引用了 webhook 触发上下文，但该任务不是由 webhook 启动的。',
      'code-host-body-invalid': '渲染后的请求体不是合法 JSON。',
      'code-host-path-invalid': '请求路径越出了所配置的 API 根。',
      'code-host-http-error': '代码平台返回了错误状态码。',
      'code-host-redirect-refused': '对方返回了重定向，平台不跟随跨主机跳转。',
      'code-host-network-error': '连接代码平台失败（DNS / 网络 / 超时）。',
      'code-host-response-unreadable': '响应不是文本，无法作为端口值。',
      'script-nonzero-exit': '脚本以非零退出码结束。',
      'script-timeout': '脚本超时被终止。',
      'script-envelope-missing': '脚本没有输出带本次运行 nonce 的 <workflow-output> 信封。',
      'script-envelope-malformed': '脚本输出的信封结构破损。',
      'script-port-missing': '脚本的信封里缺少已声明的输出端口。',
      'script-branch-port-not-declared': '脚本把一个未声明为分支端口的端口标成了不执行。',
      'script-branch-port-not-declared__hint':
        '在脚本节点的输出端口上勾选「分支端口」，或去掉 active="false" 标记。',
      'script-interpreter-missing': '宿主上找不到该脚本语言的解释器。',
      'script-deps-install-failed': '脚本依赖安装失败。',
      'script-spawn-failed': '脚本进程无法启动。',
      'runtime-result-error':
        '运行时报告了终止错误（鉴权被拒 / 用量额度 / 网关错误），不是提示词或输出协议的问题。详情见错误信息；重试同样的输入不会改变结果。',
      'runtime-stream-interrupted': '运行时输出流在结果安全持久化之前中断。',
      'runtime-stream-interrupted__hint':
        '自动重试次数耗尽后，可点「继续任务」启动新的运行时进程。',
      'runtime-session-identity-invalid':
        '运行时报告的原生会话身份发生矛盾；旧续跑 ID 已作废，避免并发写入或恢复过期会话。',
      'runtime-session-identity-invalid__hint':
        '系统会用全新的运行时进程自动重试；次数耗尽后可点「继续任务」。',
      'envelope-missing': '代理没有按约定格式输出结果（缺少输出信封）。',
      'envelope-missing__hint': '通常是模型没有遵循输出协议——可点「继续任务」重试该节点。',
      'clarify-and-output-both': '代理同时提交了反问与结果，格式冲突。',
      'clarify-questions-malformed': '代理提出的反问格式无法解析。',
      'clarify-required': '该节点要求先反问再输出，但代理直接给出了结果。',
      'call-owner-inactive': '任务 owner 账户已失活，拒绝新启 call 子任务。',
      'call-owner-inactive__hint': '恢复 owner 账户或转移任务归属后 Resume。',
      'clarify-forbidden': '已停止反问，但代理仍在提出反问。',
      'envelope-port-malformed': '代理输出的端口标签不完整（可能被截断）。',
      'branch-port-not-declared': '代理在一个未声明为分支端口的端口上关闭了分支。',
      'branch-port-not-declared__hint': '在该代理的端口设置里勾选「分支端口」，再点「继续任务」。',
      'branch-marker-malformed': '端口上的 active="…" 取值既不是 true 也不是 false。',
      'branch-marker-malformed__hint': '框架已自动重问一次；点「继续任务」重试。',
      'port-validation-failed': '代理输出的端口内容未通过校验。',
      'port-validation-failed__hint': '查看节点详情里的端口校验信息，点「继续任务」重试。',
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
    workspacePruning: '任务工作区正在清理；任务记录、日志和已持久化结果会保留。',
    workspacePruned:
      '任务工作区已清理；任务记录、日志和已持久化结果仍保留，但文件、diff、节点重试和工作流同步已不可用。',
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
    tabChanges: '结构变更',
    changesEmptyScratch:
      '该任务运行于临时空间,未产生 git 可识别的文件变更;产物请查看「输出」页签。',
    changesEmptyNoChanges: '本次任务未修改任何文件。',
    changesStructuralUnavailable: '结构分析不可用,以下仅按文本 diff 呈现。',
    changesGroupCode: '代码',
    changesGroupMiscCode: '其他代码',
    changesGroupDeps: '依赖',
    changesGroupDocs: '文档',
    changesGroupConfig: '配置',
    changesGroupMoves: '搬移',
    changesGroupOther: '其他',
    changesGroupCount: '{{viewed}}/{{files}}',
    changesSummaryLine: '{{files}} 文件 · {{methods}} 方法变更',
    changesDrillGraph: '关系图',
    changesDrillImpact: '影响面',
    changesDrillCallChain: '调用链',
    changesDrillDeps: '依赖变更',
    changesDrillFocusAll: '全部',
    changesDrillFocusFile: '当前文件',
    changesDrillFocusGroup: '当前组',
    changesDrillFocusLabel: '图聚焦',
    changesNarrativeGenerate: '生成 AI 导读',
    changesNarrativeGenerating: 'AI 导读生成中…',
    changesNarrativeFailed: 'AI 导读生成失败。',
    changesNarrativeRetry: '重试',
    changesNarrativeRegenerate: '重新生成',
    changesNarrativeStale: '导读基于旧版变更。',
    changesRenamedFrom: '原 {{from}}',
    changesJumpToHunk: '跳转到对应改动',
    changesImportsAggregated: '导入变更({{n}})',
    changesContainerCollapsed: '{{n}} 个成员',
    changesTopLevelGroup: '顶层符号',
    changesOutlineTitle: '结构大纲',
    changesOutlineExpand: '展开结构大纲',
    changesOutlineCollapse: '收起结构大纲',
    changesDrillBackToGraph: '返回关系图',
    changesNarrativeTitle: 'AI 导读',
    codeViewerOversized: '文件过大,无法渲染源码视图',
    codeViewerBinary: '二进制文件没有源码视图',
    codeViewerGone: '工作区已回收',
    codeViewerMissing: '该侧不存在此文件',
    codeViewerOutsideDiff: '任务外文件',
    codeViewerFoldedLines: '{{n}} 行未变更',
    codeIntelMenuLabel: '符号跳转',
    codeIntelLoading: '解析中…',
    codeIntelEngineDeep: '精确',
    codeIntelEngineBaseline: '基线',
    codeIntelDegraded: '已降级',
    codeIntelNoResult: '未在本任务符号范围内',
    codeIntelDefinitions: '定义({{n}})',
    codeIntelReferences: '引用({{n}})',
    codeIntelRefsGuessed: '推测——可能漏报或误报',
    codeIntelInferred: '推测',
    codeIntelTruncated: '引用列表已截断',
    codeIntelError: '查询失败,请重试',
    codeNavBack: '返回',
    changesCodeViewHunk: '改动',
    changesCodeViewFull: '全文',
    changesCodeViewLabel: '代码视图',
    fileSymbolsIncomplete: '符号表不完整',
    structOpenSource: '查看源码',
    drillSourceClose: '关闭源码栏',
    drillSourceSymbolMissing: '符号未在当前文件符号表中',
    changesPureMove: '文件自 {{from}} 移动,内容未修改。',
    changesTextUnavailable: '文本 diff 不可用(工作区已回收或超出截断上限),以下为结构信息。',
    changesDocRendered: '渲染',
    changesDocText: '文本',
    changesDocViewLabel: '文档视图',
    changesDocLoading: '加载文档内容…',
    changesDocFallback: '渲染视图不可用,已退回文本 diff。',
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
    codeRoundBadge: '代码能力',
    codeRoundSubject: '代码能力轮次',
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
    copying: '复制中…',
    copyActionHint: '先完整保存当前草稿，再创建一个归你所有的私有副本。',
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
      categoryCalls: '调用',
      categoryIntegrations: '集成',
      categoryScripts: '脚本',
      categoryIo: '输入输出',
      categoryHuman: '人工节点',
      noMatches: '没有匹配的步骤。',
      resultsCount: '有 {{n}} 个工作流步骤可用。',
      resultsCountInCategory: '{{category}}分类有 {{n}} 个步骤可用。',
      dragHint: '拖到画布上',
      requiresPermission: '需要 {{permission}} 权限',
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
    paletteReviewDesc: '连接代理的 Markdown 输出；运行到这里会暂停，等待人工通过、退回或迭代。',
    paletteClarifyLabel: '反问',
    paletteClarifyDesc: '让 agent 在无法决断时主动反问；从节点左侧 input 端往 agent 上拖即可挂接。',
    paletteScripts: '脚本',
    paletteCodeHostLabel: '代码平台调用',
    paletteCodeHostDesc: '以管理员配置的凭据调用 GitLab / GitHub API',
    paletteIntegrations: '集成',
    paletteScriptLabel: '脚本',
    paletteScriptDesc:
      '在任务工作区里跑一段内联的 python / bash / node，不起模型、不计 token。上游端口以 AW_PORT_* 环境变量注入。',
    paletteCalls: '调用',
    paletteCallWorkflowLabel: '调用工作流',
    paletteCallWorkflowDesc: '把另一个工作流作为独立子任务执行；端口与被引工作流的输入/输出一致。',
    paletteCallWorkgroupLabel: '调用工作组',
    paletteCallWorkgroupDesc:
      '把当前阶段交给一个工作组作为独立子任务执行；输入端口由入边派生，输出固定为 result。',
    menuPaste: '粘贴',
    menuSelectAll: '全选',
    menuDuplicate: '复制为新节点',
    menuCopy: '复制',
    menuWrapGit: '用 git wrapper 包装',
    menuWrapLoop: '用 loop wrapper 包装',
    menuDecompose: '解组 wrapper',
    boxSelectHint: '按住 Shift 框选',
    layoutToolbar: '画布布局',
    canvasToolbar: '画布工具',
    canvasAdd: '添加步骤',
    cameraViewFullGraph: '查看全图',
    cameraReturnReadable: '返回可读视图',
    cameraFocusSelection: '定位所选',
    layoutAll: '整理全图',
    layoutSelection: '整理所选',
    menuSelectedCount: '已选 {{n}} 个',
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
      authorForbiddenTitle: '此改动需要额外权限',
      authorForbiddenBody:
        '改动脚本 / 代码平台调用节点需要 {{permission}} 权限。本地草稿仍然保留——撤销该步即可继续保存，或找管理员开通权限。',
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
    kindDigitalEmployee: '数字员工',
    kindHintWorkflow: '按工作流定义的输入启动一次编排任务。',
    kindHintAgent: '把任务描述直接交给一个 Agent 执行，支持反问。',
    kindHintWorkgroup: '把使命交给一个工作组协同完成。',
    kindHintDigitalEmployee: '交给有状态的数字员工，并持续跟踪后续事件直到工作结束。',
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
    spaceGroupChip: '仓库组',
    spaceReplayChip: '复用任务布局',
    spaceReplaySummary: '复用任务 {{taskId}} 的仓库布局',
    spaceReplayHint: '按那个任务启动时冻结的布局重放（不读当前的组定义——组可能已被改动或删除）。',
    spaceGroupChange: '更换',
    spaceGroupSummary: '仓库组：{{name}}',
    spaceGroupRepoCount: '展平后共 {{count}} 个仓库',
    spaceGroupLayoutTitle: '目录布局',
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
    draftStorageUnavailable: '当前浏览器无法访问同标签页草稿存储。',
    draftTooLarge: '草稿过大，无法安全写入恢复存储；当前内容仍在内存中受保护。',
    draftExpired: '已清理一份过期的任务草稿。',
    draftInvalid: '已清理一份不兼容或损坏的任务草稿。',
    draftCollaboratorsChanged: '部分恢复的协作者已不可用，提交前请重新检查权限。',
    draftSourceChanged: '草稿保存后来源已变化；提交前请重新检查对象版本、执行空间和协作者。',
    draftWriteFailed: '无法写入恢复草稿。请保持本标签页打开，或明确放弃内存中的更改。',
    draftReadFailed: '无法确认已有恢复状态。为避免重复请求，任务设置将保持锁定。',
    draftReadRetry: '重新检查恢复状态',
    draftReentryTitle: '部分内容需要重新输入',
    draftReentryBody:
      '为保护凭据与本地文件，这些内容不会恢复（仓库：{{repo}}，输入：{{inputs}}，上传：{{uploads}}）。',
    draftRecoveryTitle: '恢复任务设置？',
    draftRecoveryBody: '这个精确任务流程存在一份更新的同标签页草稿。',
    draftRecoveryUnknownBody:
      '上一次请求没有可信的结果。请恢复冻结草稿，先检查服务端列表，再执行其他操作。',
    draftRestore: '恢复草稿',
    draftDiscard: '放弃草稿',
    outcomeUnknownTitle: '任务请求结果不确定',
    outcomeUnknownBody:
      '「{{name}}」的请求于 {{time}} 发出，但响应无法证明是否已提交。已冻结本次提交草稿；请检查列表并处理可能的重复项，再结束核对。',
    outcomeUnknownInspect: '检查列表',
    outcomeUnknownFinish: '我已检查，结束核对',
    unnamedTask: '未命名任务',
    unsavedTitle: '离开任务设置？',
    unsavedBody: '离开前将丢弃这份同标签页恢复草稿。',
    unsavedUnknownBody: '上一次请求可能已提交。离开会丢弃核对标记；请先检查服务端列表。',
    unsavedBusyBody: '任务请求仍在进行中，请等待结果后再离开。',
    unsavedStay: '留在任务设置',
    unsavedDiscard: '放弃设置并离开',
    unsavedForceLeave: '停止等待并离开',
    unsavedForceLeaveWarning: '停止浏览器等待无法取消服务端提交；核对标记会保留到下次进入。',
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
      overwriteHint: '与该目录下的同名文件冲突时：直接覆盖已有文件。',
      duplicateName: '「{{name}}」与本次已选的另一个文件落点重名——请改名后重新选择。',
    },
    repoSource: {
      bar: '仓库来源',
      path: '本地路径',
      url: '远端 URL',
      urlField: 'Git URL',
      urlHint: '支持 SSH（git@host:org/repo.git）与 HTTP/HTTPS（公开仓 / URL 中可携带 token）。',
      spaceField: '代码仓库或仓库组',
      spaceHint: '选择已缓存仓库或仓库组；需要时可选择“输入新的 Git URL…”。',
      urlPlaceholder: 'git@github.com:org/repo.git',
      urlInvalid: 'URL 格式无法识别（应为 SSH 或 HTTP/HTTPS）',
      refField: '分支 / tag / commit（可选）',
      refHint: '留空则使用克隆后的默认分支。',
      refPlaceholder: 'main / v1.2.0 / a3f9c…',
      recentUrlsPlaceholder: '— 从已缓存仓里挑一个 —',
      spacePlaceholder: '— 选择代码仓库或仓库组 —',
      manualUrlOption: '输入新的 Git URL…',
      groupOption: '{{name}}（组 · {{count}} 仓）',
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
    enum: {
      choices: '选项列表',
      choicesHint: '输入选项后按回车或逗号添加；点击选项后的 × 可删除。',
      choicesPlaceholder: '例如：开发、预发布、生产',
      multiSelect: '允许多选',
      allowOther: '允许填写其他值',
    },
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
      onConflict: '同名文件冲突时',
      onConflictHint:
        '落点目录里已有同名文件时怎么办。「改名保留」写成 report (1).pdf 并保留原文件；「覆盖」用上传的文件替换它，下游拿到的仍是原路径。',
      onConflictRename: '改名保留',
      onConflictOverwrite: '覆盖',
    },
    fieldJoinMode: '只有部分输入激活时',
    fieldJoinModeHint:
      '分支语义：「任一即可」= 只要有一个输入带来了值就执行本节点（来自被关闭分支的输入渲染为空）；「必须全部」= 只要有一个输入来自被关闭的分支，本节点也不执行。',
    joinModeAny: '任一即可',
    joinModeAll: '必须全部',
    fieldNodeTitle: '显示名',
    fieldNodeTitleHint: '画布卡片上的标题；为空时回退到 agent 名 / input key / 节点 id。',
    fieldReviewDescription: '评审说明',
    fieldReviewDescriptionHint: '可选；展示给评审者，不影响待评内容的来源。',
    fieldReviewInputSourceNode: '内容来源',
    fieldReviewInputSourceNodeHint:
      '选择带有可评审 Markdown 输出的代理；若它只有一个有效端口，会自动补全端口。',
    fieldReviewInputSourcePort: 'Markdown 输出端口',
    fieldReviewInputSourcePortHint:
      '支持 markdown、markdown_file / path<md>、list<markdown>、list<path<md>>；也可直接从画布端口连线。',
    fieldReviewGuideReadyTitle: '待评内容已就绪',
    fieldReviewGuideReadyBody:
      '{{source}}.{{port}} · {{kind}}。运行到此节点会暂停任务并进入{{mode}}。',
    fieldReviewGuideEmptyTitle: '只需补 1 项必填输入',
    fieldReviewGuideEmptyBody:
      '评审正文不用手填：从画布把上游代理的 Markdown 输出连到本节点，或在下方选择“内容来源 + 输出端口”。标题、说明和重跑策略均为可选。',
    fieldReviewGuideUnavailableTitle: '当前没有可评审的输出',
    fieldReviewGuideUnavailableBody:
      '先给上游代理声明一个 Markdown 输出端口。普通 string 不能作为评审正文；支持 markdown、path<md> 及其单层列表。',
    fieldReviewGuideInvalidTitle: '当前来源不能用于评审',
    fieldReviewGuideInvalidBody:
      '请选择代理节点中声明为 Markdown 类型的输出；下拉列表会保留不可用项并说明原因。',
    fieldReviewConfigureAgentOutputs: '配置代理输出',
    fieldReviewSourceNonAgent: '不可用：评审内容只能来自代理节点的输出。',
    fieldReviewSourceAgentMissing: '不可用：找不到该节点引用的代理，无法确认输出类型。',
    fieldReviewSourceNoMarkdown: '不可用：该代理没有声明 Markdown 类型的输出端口。',
    fieldReviewSourceAvailable: '可用端口：{{ports}}',
    fieldReviewSourceCount: '{{count}} 个可用',
    fieldReviewPortSingle: '单文档：运行时读取这份 Markdown 正文或 Markdown 文件。',
    fieldReviewPortMulti: '多文档：列表中的每项会成为一份可独立查看和取舍的文档。',
    fieldReviewPortUnsupported: '不可用：{{kind}} 不是可评审的 Markdown 内容类型。',
    fieldReviewModeSingle: '单文档评审',
    fieldReviewModeMulti: '多文档评审',
    fieldReviewRerunReject: '退回时额外重跑',
    fieldReviewRerunRejectHint:
      '可选；留空仍会重跑直接内容来源。这里只添加需要一并重跑的可达上游节点。',
    fieldReviewRerunIterate: '迭代时额外重跑',
    fieldReviewRerunIterateHint:
      '可选；留空仍会重跑直接内容来源。这里只添加需要结合评审意见重新生成的可达上游节点。',
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
    fieldContinueOnMaxIterations: '达到迭代上限后继续流程',
    fieldContinueOnMaxIterationsHint:
      '最后一轮仍未满足退出条件时，采用该轮输出并继续下游；内部执行或合并失败仍会停止流程。',
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
    openReferencedResource: '查看详情',
    openReferencedResourceAria: '在新标签页查看{{resource}}“{{name}}”的详情',
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
    sectionReviewInput: '待评内容',
    sectionAdvanced: '高级',
    sectionTechnical: '技术信息',
    missingRefsLabel: '模板引用但未连入：',
    missingRefsHint: '这些端口名出现在 prompt 模板里但还没有上游边；启动 task 时会被静态校验拦下。',
    invalidRefsLabel: '无效模板引用：',
    invalidRefsHint: '请改用合法本地端口或 trigger.webhook.<field>；无效引用会阻止保存或启动。',
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
    fieldCallWorkflow: '被调用工作流',
    fieldCallWorkflowHint:
      '以独立子任务运行所选工作流；输入/输出端口与其定义一致。不能调用当前正在编辑的工作流（自引用即调用环）。',
    pickCallWorkflow: '— 选择工作流 —',
    callWorkflowNoRef: '尚未选择工作流。',
    callWorkflowRefUnavailable: '引用不可见或不存在',
    callWorkflowPortsPreview: '子工作流端口预览',
    callWorkflowPortsPreviewHint:
      '来自被引工作流当前定义：输入 = 其工作流输入，输出 = 其输出节点端口并集。',
    callWorkflowChildInputs: '输入端口',
    callWorkflowChildOutputs: '输出端口',
    fieldCallMaxDurationMs: '子任务时长上限（毫秒）',
    fieldCallMaxDurationMsHint: '可选；留空时沿用全局限额。',
    fieldCallMaxTotalTokens: '子任务 token 总量上限',
    fieldCallMaxTotalTokensHint: '可选；留空时沿用全局限额。',
    fieldCallWorkgroup: '被调用工作组',
    fieldCallWorkgroupHint: '以独立子任务运行所选工作组；目标由下方模板渲染后传入。',
    pickCallWorkgroup: '— 选择工作组 —',
    fieldCallGoalTemplate: '目标模板',
    fieldCallGoalTemplateHint:
      '渲染后作为工作组子任务的目标。使用 {{port_name}} 引用入边端口；内置变量如 {{__repo_path__}}。',
    callWorkgroupResultInfo: '输出端口固定为 result（text）：工作组子任务的最终结果。',
  },
  promptPreview: {
    mockTitle: '模拟端口值',
    noPorts: '没有入边端口。增加一条入边后此处会列出。',
    assembledTitle: '拼好的 prompt',
    webhookSample: '使用示例 Webhook 上下文',
    webhookSampleHint: '示例值是确定性的占位内容；关闭后可预览缺少 trigger context 的阻断结果。',
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
    resourceValidationBadge: '资源引用有 {{count}} 项错误',
    resourceValidationTitle: '资源引用无效，修复前不能启动',
    resourceLaunchBlocked: '资源引用无效，修复前不能启动',
    resourceStatusLoadFailed: '资源状态加载失败；服务端仍会在启动前执行最终校验。',
    resourceKind: {
      skill: 'Skill',
      mcp: 'MCP',
      plugin: '插件',
      agent: '代理',
    },
    resourceMissingLabel: '已删除的 {{kind}}',
    resourceHiddenLabel: '无权限查看的 {{kind}}',
    resourceUnavailableLabel: '{{name}}（已停用或不可用）',
    resourceLoadingLabel: '{{kind}}（正在解析）',
    resourceDirectIssue: '{{resource}} 无法使用，请移除、替换或恢复该资源。',
    resourceClosureIssue: '协作代理 {{agent}} 引用了不可用资源：{{resource}}。',
    resourceHiddenAgent: '无权限查看的代理',
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
        branch: '分支端口',
        managed: '契约托管',
        managedHint: '由平台执行契约维护；请通过上方契约选择器变更。',
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
      fieldBranch: '分支端口',
      fieldBranchToggle: '该端口用于控制工作流分支',
      fieldBranchHint:
        '运行时 agent 可以输出 <port name="…" active="false">理由</port> 关闭这条分支——由该端口出发的下游整条不执行（记为「未执行」，不是失败）。非分支端口的下游永远执行。',
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
    fieldExecutionContracts: '平台执行契约',
    fieldExecutionContractsHint:
      '选择这个 Agent 能消费的确定性输入。平台会在本页自动增删并锁定 agent-result 输出端口；切换或取消契约时端口同步变化。',
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
    runtimeLoading: '正在加载运行时…',
    runtimeLoadFailed: '无法加载运行时列表。',
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
    outputBranchClosed: '分支未执行',
    outputBranchClosedNoReason: '代理关闭了这条分支，未产出内容。',
    outputBranchClosedReason: '代理关闭了这条分支：{{reason}}',
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
      loadFailed: '清单加载失败。',
      faceUnobservable: '该运行时不报告这一类，无法确认注入是否生效。',
      fieldUnobservable: '该运行时不报告此字段。',
      chip: { agents: '智', skills: '技', mcps: 'M', plugins: '插', tools: '工' },
      subtitle: {
        agents: '智能体',
        skills: '技能',
        mcps: 'MCP 服务',
        plugins: '插件',
        tools: '工具',
      },
      provenance: {
        injected: '本平台注入',
        ambient: '运行时自带',
        declaredMissing: '已声明未加载',
      },
      col: {
        name: '名称',
        provenance: '来源',
        mode: '模式',
        model: '模型',
        source: '配置来源',
        path: '路径',
        description: '描述',
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
        // RFC-297：这些是跨运行时统一后新增的归因。前几条属「本来就不会有」，
        // 不是故障——尤其不能再对 Claude Code 甩「插件可能加载失败」那口锅。
        'runtime-has-no-inventory': '该运行时不提供启动清单。',
        'no-observation-recorded': '本轮未记录启动清单。',
        'no-init-event': '运行时未报告启动事件，无法获取清单。',
        'inventory-not-read': '本轮未读取到清单。',
        'session-reused': '本轮复用了已有会话，未产生新的清单。',
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
    startupVerification: {
      title: '启动验证',
      mcpUnusable: 'MCP 未连接：{{items}}（节点在缺少其工具的情况下运行）',
      skillsMissing: '技能未被运行时加载：{{items}}',
      subagentsMissing: '子代理未被运行时加载：{{items}}',
      toolsMissing: '工具未被运行时加载：{{items}}',
      skippedDisabled: '引用了已禁用的 MCP（未注入）：{{items}}',
      droppedParams: '该运行时不支持的参数已被忽略：{{items}}',
      outputTailTruncated:
        '运行结束后有尾部输出未能收齐（子进程退出后管道未按时排空）——退出码可信，但日志/信封可能不完整',
      unsupported: '该运行时没有对应能力面：{{items}}',
      unobservable: '无法验证的注入面：{{items}}',
      unavailable: '启动观测源缺失（{{reason}}），无法验证注入是否生效',
      malformed: '启动观测源损坏（{{reason}}），无法验证注入是否生效',
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
    skipped: '未执行',
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
    taskCommitExcludePatterns: '任务自动提交排除规则',
    taskCommitExcludePatternsHint:
      '每行一条 Gitignore 规则。作用于平台发起的普通任务和代码能力提交，已跟踪文件及待推送本地历史同样受限；不会删除文件。/.agent-workflow/ 永久排除且不能反选。',
    taskCommitExcludePatternsError:
      '最多 256 条单行仓库相对规则；每条不超过 1024 UTF-8 字节、合计不超过 64 KiB，不能包含主机绝对路径、NUL 或 ../。',
    mergeAgentRuntime: '合并冲突运行时',
    mergeAgentRuntimeHint:
      '内置合并冲突解决 agent 运行的运行时 profile，其 model 来自该 profile；留空则继承全局默认运行时。',
    maxConcurrentNodes: '最大并发 agent 节点数（全局）',
    maxConcurrentNodesHint:
      '整个 daemon 同时运行的 agent 类节点进程上限，所有任务共享：agent 节点、工作组主持节点、以及分片扇出的每个分片与聚合各占 1 个名额（子工作流 / 子工作组节点不占，由子任务自己的节点去占）。脚本节点走下面的独立池，不占用本额度。保存后立即生效，含正在运行的任务与正在排队等名额的节点。默认 4。',
    maxConcurrentScriptNodes: '最大并发脚本节点数（全局）',
    maxConcurrentScriptNodesHint:
      '整个 daemon 同时运行的脚本节点进程上限，与上面的 agent 池完全独立：秒级脚本不会排在多分钟的 agent 后面，反之亦然。因此 daemon 峰值子进程数 = 本值 + agent 池上限。名额在「建隔离副本 → 装依赖 → 全部重试 → 合并回写」全程持有。保存后立即生效，含正在运行的任务。默认 4。',
    multiProcessConc: '分片扇出子进程并发（单任务）',
    multiProcessConcHint:
      '单个任务内分片扇出同时运行的分片数上限，套在 agent 池之内再收一道 —— 实际并行度 = min(agent 池剩余名额, 本值)。脚本节点不能进分片扇出，不受本项影响。保存后立即生效，含正在运行的任务。默认 4。',
    maxConcurrentCodeHostCalls: '最大并发代码平台调用（全局）',
    maxConcurrentCodeHostCallsHint:
      '整个 daemon 同时在途的代码平台 API 调用上限（建 PR / 发评论等）。它是第三个独立池：一次调用只是一个外发 HTTP 请求、不起子进程，所以额度比前两项大，也不计入「峰值子进程 = agent 池 + 脚本池」那个和。保存后立即生效，含正在运行的任务。默认 8。',
    maxActiveChildTasks: '同时活跃子任务数（全局）',
    maxActiveChildTasksHint:
      '整个 daemon 同时运行的子任务（由子工作流 / 子工作组节点派生）数量上限。排队等额度期间任务停在 pending，且此时取消会立刻生效——它不是信号量名额，而是一份可取消的配额占用。等待人工的任务不占额度。保存后立即生效。默认 8。',
    maxInvocationDepth: '子任务嵌套深度上限（全局）',
    maxInvocationDepthHint:
      '调用链最大深度：父任务派生子任务算 1 层，子任务再派生算 2 层，依此类推。超限的那一次派生直接判失败（invocation-depth-exceeded），已在跑的调用链不受影响。用于兜住工作流互相调用形成的环。保存后立即生效。默认 3。',
    logLevel: '日志级别',
    logLevelHint: '保存后立即调整当前 daemon 的日志级别。',
    perTaskDuration: '单 task 最大时长 (ms)',
    perTaskTokens: '单 task 最大 token 数',
    perNodeTimeout: '单节点超时 (ms)',
    nodeRetries: '默认节点重试次数',
    nodeRetriesHint:
      '单个 runtime 会话内可恢复失败的重试预算。默认 3。注意它不再单独决定总次数——' +
      '与下面的「会话重启预算」相乘才是单节点最坏尝试次数；只把本项设为 0、而重启预算仍为 1 时，' +
      '失败节点仍会跑 2 次。要真正「只跑一次」需两项都设为 0。',
    sessionRestartBudget: '会话重启预算',
    sessionRestartBudgetHint:
      '同一会话内的追问用尽后，允许整体换一个干净会话重来几次（0 = 关闭，行为回到只在同一会话里追问）。单节点最坏尝试次数 =（1 + 重试次数）×（1 + 本项），并硬性封顶 99 次。默认 1。',
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
    periodicOrphanReconcileHint: '0 表示关闭；保存后立即停止或按新周期重新计时。',
    zeroDisabled: '0 表示禁用',
    largeOutputThreshold: '大输出阈值 (bytes)',
    zeroUnlimited: '0 = 无限制。',
    autoGcLabel: '自动 GC 已合并的 worktree',
    webhookTaskWorkspaceAutoCleanup: 'Webhook 任务完成或取消后清理工作区',
    webhookTaskWorkspaceAutoCleanupHint:
      '默认关闭。开启后，只对开启后进入 done/canceled 的直接 Webhook 根任务生效：事件仓 linked worktree 与 scratch 临时 Git 仓库都会删除；failed/interrupted、继承子任务与历史终态任务保留。任务记录、日志和已持久化结果仍在，但删除后不能再查看 live 文件/diff、重试节点或同步工作流。',
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
    submoduleRefreshIntervalHint: '保存后立即按新周期重新计时；正在执行的一轮不会被中断。',
    submoduleOnlyRecentDays: '只刷最近多少天用过的仓',
    submoduleOnlyRecentDaysHint: '下一轮扫描开始使用新窗口。',
    autoGcHint: '后台周期性任务；v1 默认关闭也无碍。',
    olderThanDays: 'GC 时间窗（天）',
    onlyMerged: '仅 GC 已合并分支',
    archivePerNodeRun: '事件归档 — 单 node_run 行数',
    archivePerNodeRunHint: '当某个 node_run 累计到此行数，归档为 JSONL。',
    archiveGlobal: '事件归档 — 全局行数',
    archiveGlobalHint: 'DB 全表事件行数上限；超过会触发归档。',
    archivePerNodeRunBytes: '事件归档 — 单 node_run 字节水位',
    archivePerNodeRunBytesHint:
      '按采样平均行宽折算成行数阈值，与行数阈值取更严者。0 = 关闭字节水位。默认 8 MiB。',
    archiveGlobalBytes: '事件归档 — 全局字节水位',
    archiveGlobalBytesHint: '全表事件字节上限（同上折算）。0 = 关闭。默认 256 MiB。',
    backupProtectedKeepCount: '备份保留 — 每族保留个数',
    backupProtectedKeepCountHint:
      '手动备份与各 pre-* 家族各自保留最新 N 个(升级前的 pre-migration 包曾在生产攒到 59 个 / 2GB)。0 = 不自动清理。',
    eventStreamRetentionDays: '事件流水保留(天)',
    eventStreamRetentionDaysHint:
      '蒸馏 / 意图对话 / MCP 运行时测试三张事件表:宿主终态后超过该天数的行会被删除。0 = 不清理。',
    webhookTriggerFiresRetentionDays: 'Webhook 触发记录保留(天)',
    webhookTriggerFiresRetentionDaysHint:
      '超期的触发记录会被删除;其启动的任务仍未终态时该行始终保留(supersede 依赖它)。0 = 不清理。',
    taskArchiveEnabled: '启用终态任务自动归档',
    taskArchiveRetentionDays: '归档保留期(天)',
    taskArchiveRetentionDaysHint:
      '整棵任务树全部终态、且最近完成时间早于该天数时,导出到 ~/.agent-workflow/archive/tasks/ 并从数据库删除——归档后任务在列表 / 详情 / 搜索里一律不可见(与不存在同形),不提供在线回看。0 = 不归档。',
    webhookBodyRetention: 'Webhook 投递 body 保留（天）',
    webhookBodyRetentionHint:
      '超期投递的原始 payload 置空（重放不可用），行仍保留。高流量部署可调小以控制磁盘占用。',
    webhookRowRetention: 'Webhook 投递记录保留（天）',
    webhookRowRetentionHint: '超期投递整行删除（审计不可见）。不得小于 body 保留天数。',
    bindHost: '监听 host',
    bindHostHint: '需要重启。默认 127.0.0.1 使 daemon 仅本机可达。',
    bindPort: '监听 port',
    bindPortHint:
      '需要重启。留空 / 0 表示启动时自动挑选空闲端口；当前实际端口只作提示，不会自动保存。',
    bindPortCurrent: '本次运行实际使用 {{port}}。',
    bindPortUseCurrent: '固定为当前端口',
    mcpSurfaceLabel: '对外接口（API 令牌与 MCP）',
    mcpSurfaceHint:
      '关闭后立即停止签发新令牌并关闭 /api/mcp。已存在的令牌在 REST 通道继续有效——这是止血开关，不是吊销开关；要停掉某一枚请让属主吊销，要停掉某个人的全部请停用其账号。',
    mcpSurfaceDocsLink: '查看 API 与 MCP 接入文档',
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
    privilegedMembershipBlocked:
      '已移动，但分组未改变：改变脚本 / 代码平台调用节点的归属需要对应的创作权限。',
    privilegedScriptChangeBlocked:
      '该改动需要 scripts:author 权限 —— 没有它就不能新增、删除或重接脚本节点。',
    privilegedCodeHostChangeBlocked:
      '该改动需要 code-host-calls:author 权限 —— 没有它就不能新增、删除或重接代码平台调用节点。',
    layoutCrossScope: '所选步骤分属不同包装器范围。请分别整理每个范围，或使用“整理全图”。',
    layoutCycles: '布局时保留了 {{n}} 条循环依赖边，但未用它们约束层级。',
    layoutLockedOverflow: '有 {{n}} 个锁定尺寸的包装器放不下整理后的步骤；其锁定矩形已保留。',
  },
  reviewNode: {
    label: '评审',
    sourceUnset: '连接待评 Markdown 输出',
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
  callWorkflowNode: {
    label: '调用工作流',
    unsetWorkflow: '（未选择工作流）',
  },
  codeHostSettings: {
    baseUrl: 'API 根地址',
    baseUrlHint_gitlab: '形如 https://gitlab.example.com/api/v4（子路径部署也以 /api/v4 结尾）',
    baseUrlHint_github: '公有 GitHub 填 https://api.github.com；GHES 填 https://host/api/v3',
    repositoryUrlPrefixes: '允许的仓库 URL 前缀',
    repositoryUrlPrefixesHint:
      '仅 GitLab。配置与当前 API 连接属于同一实例的其他克隆地址域名或路径前缀；每项输入后按 Enter 或逗号确认，任务仓库命中任一项即可执行。',
    repositoryUrlPrefixesPlaceholder: 'https://gitlab-mirror.example.com/team',
    repositoryUrlPrefixInvalid: '请输入不含凭据、查询参数或片段的 HTTP(S) 地址。',
    token: '访问令牌',
    tokenHint: '建议用专用机器人账号的最小权限令牌',
    tokenStored: '已保存（尾号 {{hint}}）。留空保存则保留原令牌',
    rejectUnauthorized: '验证 HTTPS 证书',
    rejectUnauthorizedHint:
      '建议保持开启。仅在内网 GitLab 证书链暂时不完整时关闭；关闭会设置 rejectUnauthorized: false，并降低中间人攻击防护。',
    test: '测试连接',
    testOk: '连接成功，当前身份：{{login}}',
    testFailed: '连接失败：{{reason}}',
    testCode_unauthorized: '令牌无效或权限不足',
    'testCode_not-found': '地址不是有效的 API 根',
    testCode_unreachable: '网络不通或超时',
    'testCode_bad-response': '响应不是预期的身份信息（可能被反代拦到了登录页）',
    loading: '正在读取代码平台配置…',
    intro:
      '工作流里的「代码平台调用」节点用这里配置的凭据调用 GitLab / GitHub。令牌加密存储，读取时只显示尾号。',
  },
  codeRoundNode: {
    label: '代码能力轮次',
    notEditable:
      '该节点由平台自动生成，不可编辑。它执行的阶段序列是写死且版本化的；要改用哪个 agent、提示词或阈值，请到对应的能力配置里改。',
    capabilityHint: '本轮执行的能力：{{capability}}',
  },
  codeCapability: {
    mr_review: 'MR 代码检视',
    mr_comment_fix: '评论驱动改码',
    requirement: '需求实现',
    ci_fix: 'CI 修复',
    mr_monitor: 'MR 监视器',
  },
  codeHostNode: {
    label: '代码平台调用',
    destructive: 'DELETE 请求',
    unsupported: '当前平台不支持',
  },
  codeHostProvider: {
    gitlab: 'GitLab',
    github: 'GitHub',
  },
  codeHostActionGroup: {
    comment: '评审与评论',
    mr: 'MR / PR 与提交',
    pipeline: 'CI/CD',
    read: '读取数据',
    custom: '自定义',
  },
  codeHostAction: {
    'comment_reply-thread': '回复已有评审讨论',
    comment_create: '发布普通 MR/PR 评论',
    'comment_create-inline': '新建行内评审讨论',
    comment_update: '更新评论内容',
    'comment_create-issue': '在 issue 上发评论',
    'comment_list-issue': '列出 issue 的评论',
    'comment_update-issue': '更新 issue 评论',
    thread_resolve: '解决评审讨论',
    'commit-status_set': '设置提交状态',
    label_add: '添加标签',
    assignee_set: '指派处理人',
    mr_approve: '批准 MR/PR',
    mr_merge: '合并 MR/PR',
    mr_create: '创建 MR/PR',
    pipeline_trigger: '启动流水线 / 工作流',
    pipeline_retry: '重跑未通过的作业',
    pipeline_cancel: '取消流水线 / 工作流',
    job_list: '列出流水线 / 工作流作业',
    job_log: '读取作业日志',
    'review_draft-create': '暂存一条草稿评审意见',
    'review_draft-publish': '一次性发布全部草稿意见',
    'review_draft-discard': '丢弃一条草稿意见',
    review_submit: '一次请求提交整份评审',
    comment_list: '列出 MR/PR 上已有的评论',
    mr_get: '读取 MR/PR 元信息',
    mr_diff: '读取变更文件与差异',
    mr_list: '列出 MR/PR',
    file_read: '读取仓库文件',
    custom: '自定义请求',
  },
  codeHostActionDescription: {
    'comment_reply-thread':
      '向已有代码评审讨论追加回复。GitLab 填 discussion ID；GitHub 仅支持 PR 行内评审评论，且必须填顶层评论 ID。',
    comment_create: '在 MR/PR 会话区发布普通评论；不会绑定到具体代码行。',
    'comment_create-inline': '在 MR/PR 的代码差异上新建行内评审讨论，需要提供平台格式的位置 JSON。',
    comment_update:
      '更新已有评论正文。GitLab 仅适用于普通 MR 评论；GitHub 还需选择普通评论或行内评审评论。',
    'comment_create-issue':
      '在 issue 上发评论。与 MR/PR 那条分开，因为 issue 是另一类对象——GitHub 恰好共用同一个端点，GitLab 不共用。',
    'comment_list-issue': '列出某个 issue 的评论，含更新评论所需的评论 ID。',
    'comment_update-issue': '按评论 ID 更新某条 issue 评论的正文。',
    thread_resolve: '将 GitLab MR 的已有评审讨论标记为已解决；GitHub REST 没有对等接口。',
    'commit-status_set': '为指定提交写入进行中、通过或不通过状态，可附状态名称与详情链接。',
    label_add: '向指定 MR/PR 追加一个或多个标签，不移除已有标签。',
    assignee_set:
      '指派 MR/PR 处理人。GitLab 使用数字用户 ID 并替换当前列表；GitHub 使用登录名并追加到已有列表。',
    mr_approve: '以当前凭据身份批准 MR/PR；GitHub 会创建 APPROVE review，可附说明。',
    mr_merge: '合并指定 MR/PR，可设置平台支持的合并方式或合并提交信息。',
    mr_create: '从源分支向目标分支创建 MR/PR，可填写标题和描述。',
    pipeline_trigger:
      'GitLab 在指定 ref 上创建流水线；GitHub 手动触发已配置 workflow_dispatch 的工作流。',
    pipeline_retry: 'GitLab 重试该流水线中失败或已取消的作业；GitHub 重跑失败作业及其依赖作业。',
    pipeline_cancel: 'GitLab 取消流水线内所有作业；GitHub 取消一次工作流运行。',
    job_list: '列出指定 GitLab 流水线或 GitHub Actions 工作流运行中的作业。',
    job_log: '读取单个作业的纯文本运行日志；GitHub 会跟随短时有效的下载链接。',
    'review_draft-create':
      '仅 GitLab：把一条行级意见先存成草稿。攒齐草稿再一次性发布，MR 上就不会出现「发了一半」的状态；GitHub 的 review 是单请求提交，没有可单独创建的草稿资源。',
    'review_draft-publish': '仅 GitLab：一次调用发布全部草稿，整份评审同时出现在 MR 上。',
    'review_draft-discard':
      '仅 GitLab：删除一条草稿。用于回滚只攒了一半的批次——没有它，中途失败会在 MR 上留下一批永不发布的孤儿草稿，用户可见且像 bot 跑了一半。',
    review_submit:
      '仅 GitHub：一次请求提交整份评审（正文 + 全部行级意见），并钉在指定 commit 上。要么全部落地，要么什么都没有。',
    comment_list:
      '回读 MR/PR 上已有的评审评论。用于把上一轮已经发出去的评论认回来——发布与记账之间崩溃时，不至于把整批重发。',
    mr_get:
      '读取 MR/PR 自身字段。GitLab 的行级评论需要它返回的 diff_refs（base/start/head sha），diff 接口并不带这些。',
    mr_diff: '读取 MR/PR 的变更文件及逐文件差异；结果不是单个原始补丁文件。',
    mr_list: '列出项目中的 MR/PR，可按状态和每页数量过滤。',
    file_read: '读取指定分支、标签或提交上的仓库文件原始内容。',
    custom:
      '调用所配代码平台 base URL 下的自定义相对路径；需自行选择方法和 JSON 请求体，DELETE 还需显式允许。',
  },
  codeHostField: {
    project: '项目',
    mr: 'MR / PR 编号',
    issue: 'Issue 编号',
    thread: '评审讨论 / 顶层评论 ID',
    comment: '评论 ID',
    comment_scope: '评论类型',
    body: '正文',
    position: '行内位置 JSON',
    sha: '提交 SHA',
    state: '状态',
    context: '状态名称',
    description: '描述',
    target_url: '详情链接',
    labels: '标签',
    assignees: '指派对象',
    ref: '分支 / 标签',
    workflow: 'GitHub 工作流文件 / ID',
    pipeline: '流水线 / 工作流运行 ID',
    job: '作业 ID',
    job_scope: '作业状态过滤',
    job_filter: '作业范围',
    path: '文件路径',
    file_ref: '引用（分支 / 标签 / SHA）',
    mr_state: 'MR 状态过滤',
    per_page: '每页条数',
    source_branch: '源分支',
    target_branch: '目标分支',
    title: '标题',
    merge_method: '合并方式',
    squash: '压缩提交',
  },
  codeHostFieldHint: {
    project:
      '留空则使用当前任务的仓库。GitLab 可填 namespace/path 或数字 ID；GitHub 填 owner/repo。',
    thread: 'GitLab 填 discussion ID；GitHub 填 PR 行内评审讨论的顶层评论 ID，不能填子回复 ID。',
    comment: 'GitLab 填普通 MR note ID；GitHub 填 comment ID，并下方选择普通或行内评论。',
    position: '使用 trigger.webhook.comment_position_json 即可原样回传。',
    labels: '逗号分隔。',
    assignees: '逗号分隔。GitLab 需要用户数字 ID，GitHub 需要登录名。',
    workflow: 'GitHub 的 workflow_dispatch 工作流文件名（如 ci.yml）或数字 ID。',
    pipeline: 'GitLab 填 pipeline ID；GitHub 填 Actions workflow run ID。',
    path: '填原始路径，平台负责编码。',
  },
  codeHostOption: {
    pending: '进行中',
    success: '通过',
    failed: '不通过',
    pulls: '行内评论',
    issues: '普通评论',
    open: '打开',
    closed: '已关闭',
    all: '全部',
    latest: '最后一次尝试',
    canceled: '已取消',
    running: '运行中',
    merge: '合并提交',
    squash: '压缩合并',
    rebase: '变基',
    true: '是',
    false: '否',
  },
  codeHostUnsupported: {
    graphqlOnly: 'GitHub 的 REST 面没有这个端点（只有 GraphQL），且线程 ID 在 REST 里拿不到',
    // 具体到「该改用哪个动作」。只说「不支持」会让人以为是平台没做，于是去
    // 翻文档找开关；真相是两家的检视模型不同，换一个动作就能做成同一件事。
    singleRequestReview:
      'GitHub 是一次请求提交整份检视，没有可暂存的草稿——改用「一次提交整份检视」',
    useDraftNotes:
      'GitLab 走草稿评论再批量发布，没有「一次提交整份检视」——改用「暂存草稿」+「批量发布」',
  },
  codeHostInspector: {
    provider: '代码平台',
    providerHint: '凭据在设置页的「代码平台」分区配置',
    manageConnections: '配置',
    manageConnectionsAria: '在新标签页配置代码平台凭据',
    action: '操作',
    actionHint: '按类别分组；某家不支持的操作会置灰并说明原因',
    sectionInputs: '输入绑定',
    inputGuideEmptyTitle: '尚未连接上游输入',
    inputGuideEmpty:
      '从上游节点的输出端口拖线到本节点；连线后，它会出现在每个字段参数选择器的“当前节点输入”分类。',
    inputGuideUnboundTitle: '还有 {{count}} 个输入未绑定',
    inputGuideUnbound:
      '连线只把上游值带到本节点，不会替你猜它属于哪个 API 参数。请在目标字段旁点“插入参数”。',
    inputGuideBoundTitle: '输入已绑定',
    inputGuideBound:
      '运行时会用上游真实值替换已保存 token。下面列出现有引用；新增引用请使用具体字段旁的参数选择器。',
    boundTargets: '已用于',
    removeBindingAria: '取消输入 {{port}} 与参数 {{field}} 的绑定',
    inputBindingAdvancedHint:
      '这里仅展示已有 token 引用。要新增引用，请在具体目标字段旁点“插入参数”，再选择“当前节点输入”。',
    inactiveValuesTitle: '有 {{count}} 个存量值不用于当前操作',
    inactiveValuesBody:
      '这些值会保留供切回原操作时恢复，但当前不会编辑、校验或执行。可切换操作/代码平台后编辑，也可在这里明确清理。',
    clearInactive: '清理',
    confirmClearInactive: '确认清理',
    clearInactiveAria: '清理当前不执行的存量值 {{path}}',
    confirmClearInactiveAria: '确认清理当前不执行的存量值 {{path}}',
    clearInactiveHistory: '清理存量值 {{path}}',
    sectionParams: '参数',
    sectionCustom: '自定义请求',
    method: '方法',
    path: '相对路径',
    pathHint: '拼在所配 base URL 之后，必须以 / 开头，不能是绝对 URL',
    query: '查询参数',
    queryHint: '参数名是固定文本；参数值可使用上游端口或 webhook trigger 变量。',
    queryKey: '查询参数名',
    queryValue: '查询参数 {{key}} 的值',
    addQuery: '添加查询参数',
    removeQuery: '删除查询参数 {{key}}',
    body: '请求体（JSON）',
    bodyHint: '变量只能写在 JSON 字符串里，这样上游内容改不了请求结构',
    allowDestructive: '允许 DELETE 请求',
    allowDestructiveHint: '打开后才能选 DELETE；关闭时会自动改回 GET',
    noViewPermission: {
      title: '无权查看节点详情',
      body: '查看代码平台调用节点需要 code-host-calls:author 权限。如确有需要，请找管理员开通。',
    },
    actionUnsupported: '所选代码平台不支持这个操作',
    unsupportedGeneric: '该代码平台不支持这个操作',
  },
  scriptNode: {
    label: '脚本',
    // 中文无单复数变化，两档同文——与仓内 wgRow_one/_other 先例一致。
    dependencyCount_one: '{{count}} 个依赖',
    dependencyCount_other: '{{count}} 个依赖',
    readonly: '只读',
  },
  scriptInspector: {
    language: '语言',
    languageHint: '决定用哪个解释器执行。切换语言时，未改动过的初始模板会一并替换。',
    sectionCode: '脚本',
    body: '脚本正文',
    bodyHint: '在任务工作区里执行。平台不会往这段文本里替换任何内容。',
    fullscreenEdit: '全屏编辑',
    retryWarning:
      '失败会自动重试。文件改动随隔离工作区一起回滚，但外部副作用（HTTP 调用、通知）不会——非幂等的脚本要自己做幂等保护。',
    sectionInputs: '输入',
    noInputs: '还没有入边。连一个上游端口即可把值传进来。',
    inputSample: '读取样例',
    inputSampleHint:
      '超过 32 KiB 的上游值不走环境变量、改写成文件，所以要先看 AW_PORT_FILE_*；只读环境变量的脚本会在大 diff 上读到空串。',
    sectionOutputs: '输出',
    outputSingle: '整个 stdout 作为「{{port}}」端口的值。',
    outputEnvelope:
      '声明了端口后，脚本要在 stdout 打印 <workflow-output> 信封。nonce 每次运行都不同，必须从 AW_ENVELOPE_NONCE 环境变量读出来再拼进标签——平台不会替换脚本正文里的任何文本。',
    envelopeSample: '信封样例',
    envelopeSampleHint: '按当前语言与已声明端口生成，可直接复制进脚本，再把 TODO 换成真实内容。',
    copySample: '复制样例',
    outputPorts: '声明输出端口',
    outputPortsHint: '留空则把 stdout 作为单一端口输出。',
    sectionRuntime: '运行时',
    dependencies: '依赖',
    dependenciesHint:
      '必须精确钉版本（requests==2.32.3 / lodash@4.17.21）。只安装一次，落进只读缓存环境。',
    env: '环境变量',
    envHint: '值在所有展示位置都会脱敏。平台变量不可覆盖。',
    envKey: '变量名',
    envValue: '值',
    envAdd: '新增变量',
    envRemove: '删除变量',
    readonly: '只读工作区',
    readonlyHint: '不建隔离工作区、不合并回写。脚本无法修改仓库文件。',
    noViewPermission: {
      title: '无权查看脚本',
      body: '查看脚本节点需要 scripts:author 权限。如确有需要，请找管理员开通。',
    },
  },
  callWorkgroupNode: {
    label: '调用工作组',
    unsetWorkgroup: '（未选择工作组）',
  },
  callNode: {
    navChild: '点击进入子任务',
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
      'mcp-not-found': '节点使用的代理引用了不存在的 MCP。',
      'plugin-not-found': '节点使用的代理引用了不存在的插件。',
      'plugin-disabled': '节点使用的代理引用了已停用的插件。',
      'binding-node-missing': '输出端口绑定到了不存在的节点。',
      'binding-port-missing': '输出端口绑定到了不存在的端口。',
      'boundary-input-port-not-declared': '包装器入界边引用了未声明的输入端口。',
      'boundary-input-source-not-wrapper': '包装器入界边的源头不是扇出包装器。',
      'boundary-input-target-aggregator':
        '包装器入界边不能指向扇出聚合代理；分片输出只能通过普通内部边汇入聚合代理。',
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
      'prompt-template-invalid-ref': '模板包含格式错误、未知或旧版引用。',
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
      'upload-input-on-conflict-invalid': '上传输入的同名冲突策略只能是 rename 或 overwrite。',
      'wrapper-children-outside-bounds': '包装器内有节点超出了包装器边界。',
      'wrapper-child-duplicate': '包装器重复列出了同一个直接子节点。',
      'script-node-invalid':
        '脚本节点的字段不合法（正文过长、端口或依赖数量超上限、字段形状不对）。',
      'code-host-node-invalid': '代码平台调用节点的字段不合法。',
      'code-host-provider-invalid': '代码平台必须是 GitLab 或 GitHub。',
      'code-host-action-invalid': '未知的代码平台操作。',
      'code-host-action-unsupported': '所选代码平台不支持这个操作。',
      'code-host-param-missing': '代码平台调用节点缺少必填参数。',
      'code-host-param-invalid': '代码平台调用节点的参数取值不合法。',
      'code-host-request-invalid': '自定义请求需要合法的方法与相对路径。',
      'code-host-method-forbidden': '该方法有破坏性，需要在节点上显式允许。',
      'code-host-path-invalid': '请求路径必须是所配 API 根之下的相对路径。',
      'code-host-body-invalid': '请求体不是合法 JSON，或变量放在了 JSON 字符串之外。',
      'code-host-var-unknown': '引用了不存在的端口或触发上下文变量。',
      'code-round-not-authorable':
        '「代码能力轮次」节点由平台自动生成，不能出现在手工编辑或导入的工作流里。',
      'script-body-empty': '脚本节点的正文为空。',
      'script-language-invalid': '脚本节点的语言必须是 python、bash 或 node。',
      'script-in-fanout-unsupported':
        '脚本节点不能放在扇出包装器内部——请把清单计算放在扇出的上游。',
      'script-output-name-duplicate': '脚本节点的输出端口重名。',
      'script-output-name-unquotable':
        '输出端口名同时含单引号和双引号，信封的 <port name=...> 标签无法表达，请改名。',
      'script-output-kind-path-unsupported':
        '脚本节点暂不支持 path 类端口（归档链未接通，内容会在工作区回收后失效）。',
      'script-port-env-collision': '两个输入端口会映射到同一个环境变量名，请重命名其一。',
      'script-dependencies-unsupported': 'bash 脚本不能声明依赖。',
      'script-dependency-malformed': '依赖条目不是合法的包名。',
      'script-dependency-version-unpinned':
        '依赖必须精确钉版本（如 requests==2.32.3 / lodash@4.17.21）。',
      'script-env-key-invalid': '环境变量名不合法。',
      'script-env-key-reserved': '该环境变量名由平台保留，不能覆盖。',
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
      'exit-condition-port-not-branch':
        '退出条件用的是「端口未激活」，但该端口不是分支端口——这个条件永远不会成立。',
      'wrapper-loop-inner-data-cycle': '循环包装器内部存在数据环。',
      'wrapper-loop-max-iterations': '循环包装器缺少最大迭代次数。',
      'wrapper-loop-continue-on-max-iterations': '循环包装器的迭代上限处理开关必须为开启或关闭。',
      'wrapper-loop-nested': '循环包装器不能嵌套在另一个循环包装器里。',
      'wrapper-loop-output-binding-out-of-scope': '循环输出绑定必须引用循环体的直接成员。',
      'wrapper-output-boundary-missing': '离开包装器的数据必须通过包装器输出边界显式暴露。',
      // RFC-243 — call-workflow 节点（design §9 错误码闭集）。
      'workflow-call-cycle': '工作流调用形成了环（含调用自身）。',
      'call-workflow-ref-missing': '调用节点引用的工作流不存在或未选择。',
      'call-workflow-upload-input-unsupported':
        '被调用工作流含文件上传输入，暂不支持跨工作流调用。',
      'call-workflow-output-port-collision': '被调用工作流的多个输出节点存在重名端口。',
      'call-workflow-input-unwired': '被调用工作流的输入端口缺少同名入边。',
      'call-workflow-in-fanout-unsupported': '调用节点不能放在扇出包装器内部。',
      // RFC-243 PR-4 — call-workgroup 节点。
      'call-workgroup-ref-missing': '调用节点引用的工作组不存在或未选择。',
      'call-workgroup-in-fanout-unsupported': '调用节点不能放在扇出包装器内部。',
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
    namesSeparator: '、',
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
    'workflow-name-invalid':
      '工作流名称不能以 _ 开头，不能含换行 / 制表符等控制字符，长度 ≤ 128 字。',
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
    'upload-duplicate-filename': '本次上传里有两个文件会落到同一路径，请改名后重传。',
    'upload-target-is-dir': '要覆盖的路径上已经是一个目录，无法用文件覆盖。',
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
    'resource-operation-stale': '资源在操作期间被他人修改，请刷新后重试。',
    'review-comment-not-author':
      '只有评论作者、任务 owner，或持有 resource-acl:bypass 的用户可以修改这条评论。',
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
    'agent-resources-invalid': '该代理存在缺失或不可用的资源引用，无法执行。',
    'agent-resources-invalid__hint': '打开代理的资源页，恢复、启用、替换或移除异常引用。',
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
    'skill-unavailable': '该技能不可用或未通过完整性校验。',
    'skill-invalid': '技能内容不合法。',
    'skill-name-in-use': '同名技能已存在。',
    'skill-in-use': '仍有代理引用该技能，无法删除。',
    'skill-in-use__hint': '先在引用它的代理里解绑。',
    'skill-changed': '技能内容已被他人修改，请刷新后重试。',

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
    'admin-required': '该操作需要对应的高权限能力。',
    'permission-required': '当前账号缺少所需权限。',
    'not-task-member': '只有任务成员或具备全局任务权限的操作者可以执行该操作。',
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
    'self-access-change-forbidden': '不能修改自己的权限预设或附加权限。',
    'last-access-administrator-protection': '必须至少保留一个具备 users:write 的活跃账号。',
    'user-directory-forbidden': '查看用户目录需要 users:read 权限。',
    'user-management-forbidden': '用户管理需要 users:write 权限。',
    'user-access-management-forbidden': '修改访问权限需要具备 users:write 的活跃浏览器会话。',
    'user-access-ambiguous': '旧 role 字段与 access 快照不能同时提交。',
    'user-access-stale': '该用户的权限已被更新，请加载最新版本后重新确认。',
    'user-permission-invalid': '权限清单中含有未知权限。',
    'user-permission-not-grantable': '该权限属于账号内在能力，不能单独授予。',
    'user-permission-redundant': '所选权限预设已经包含该权限。',
    'user-permission-duplicate': '权限清单中含有重复项。',
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
      draftLocalOnly: '已保存在本机，尚未同步到服务端。',
      draftSaveFailed: '最新草稿未保存；请重试后再离开。',
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
      repo_group: '仓库组',
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
      permissionRequired: '需要“管理记忆提炼任务”权限',
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
    unknownOwner: '未知归属',
    visibility: '可见性',
    visibilityValue: { public: '全员可用', private: '私有' },
    members: '授权用户',
    noMembers: '暂无授权用户',
    privateHint: '私有资源仅所有者、授权用户或持有 resource-acl:bypass 的账户可见可用。',
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
    resourceType: { agent: '代理', skill: '技能', mcp: 'MCP', plugin: '插件', workflow: '工作流' },
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
    answerPanePartialFailed: '{{count}} 轮提交失败；成功的轮次已保存。',
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

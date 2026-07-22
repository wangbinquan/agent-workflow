// /settings — config editor split into URL-backed concern sections (Runtime / System agents /
// Limits / Recovery / GC / Network / Appearance / Rendering / Authentication).
//
// RFC-156: the "System agents" tab collects the internal framework agents'
// runtime + run-config (commit-push, memory distiller, merge-conflict resolver
// off config.json; skill-fusion off the aw-skill-merger builtin agent row). It
// absorbed the commit-push block from Limits and the whole (now-removed) Memory
// tab (distiller runtime + output language).
//
// Each section owns a draft slice of the config, posts ConfigPatch via PUT,
// shows a "saved" toast, and labels fields that need a daemon restart.
//
// Sign-out + the daemon URL / token readout used to live here in a "Connection"
// tab; that was removed. Sign-out is the UserMenu's job (it also invalidates the
// server session via /api/auth/logout, which this tab never did), and active
// sessions / tokens are managed on /account.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Config, ConfigPatch } from '@agent-workflow/shared'
import { api, apiPostMultipart, ApiError } from '@/api/client'
import { Card } from '@/components/Card'
import {
  SettingsDraftProvider,
  useSettingsConfigDraft,
  useSettingsDraftRegistry,
  type SettingsConfigDraftController,
  type SettingsConfigDraftMutateOptions,
} from '@/components/settings/SettingsDraftProvider'
import {
  useFusionAgentDraft,
  type FusionAgentDraftController,
} from '@/components/settings/useFusionAgentDraft'
import { ConfirmButton } from '@/components/ConfirmButton'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, NumberInput, Switch, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { PageSectionLink, PageSectionNav, type PageSectionGroup } from '@/components/PageSectionNav'
import { RuntimeSelect } from '@/components/RuntimeSelect'
import { SandboxCard } from '@/components/settings/SandboxCard'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { RuntimeList } from '@/components/RuntimeList'
import { describeApiError, setLanguage, type SupportedLanguage } from '@/i18n'
import { isSupportedLanguage } from '@/hooks/useLanguage'
import { queryConfig, useConfigQueryKey } from '@/lib/config-resource'
import {
  SETTINGS_CONFIG_SCOPE_IDS,
  settingsConfigScopeKeys,
  type SettingsConfigScopeId,
} from '@/lib/settings-drafts'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/settings',
  component: SettingsPage,
  validateSearch: validateSettingsSearch,
})

export type SettingsTab =
  | 'runtime'
  // RFC-156: the internal framework agents' runtime + run-config live here now,
  // pulled out of Limits (commit-push) and the removed Memory tab (distiller).
  | 'systemAgents'
  | 'limits'
  | 'recovery'
  | 'gc'
  | 'git'
  | 'network'
  | 'appearance'
  | 'rendering'
  | 'authentication'

export const SETTINGS_TABS = [
  'runtime',
  'systemAgents',
  'limits',
  'recovery',
  'gc',
  'git',
  'network',
  'appearance',
  'rendering',
  'authentication',
] as const satisfies readonly SettingsTab[]

interface SettingsSearch extends Record<string, unknown> {
  tab?: SettingsTab
}

function configScopeForSettingsTab(tab: SettingsTab): SettingsConfigScopeId | undefined {
  switch (tab) {
    case 'systemAgents':
      return SETTINGS_CONFIG_SCOPE_IDS.systemAgents
    case 'limits':
      return SETTINGS_CONFIG_SCOPE_IDS.limits
    case 'recovery':
      return SETTINGS_CONFIG_SCOPE_IDS.recovery
    case 'gc':
      return SETTINGS_CONFIG_SCOPE_IDS.gc
    case 'git':
      return SETTINGS_CONFIG_SCOPE_IDS.git
    case 'network':
      return SETTINGS_CONFIG_SCOPE_IDS.network
    case 'appearance':
      return SETTINGS_CONFIG_SCOPE_IDS.appearance
    case 'rendering':
      return SETTINGS_CONFIG_SCOPE_IDS.rendering
    case 'runtime':
    case 'authentication':
      return undefined
  }
}

function SettingsSectionNav({
  groups,
  active,
  fusionDirty,
  fusionStale,
  fusionOutcomeUnknown,
  onSelectCompact,
}: {
  groups: readonly PageSectionGroup<SettingsTab>[]
  active: SettingsTab
  fusionDirty: boolean
  fusionStale: boolean
  fusionOutcomeUnknown: boolean
  onSelectCompact: (tab: SettingsTab) => void
}) {
  const { t } = useTranslation()
  const registry = useSettingsDraftRegistry()
  const groupsWithStatus = groups.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      const scope = configScopeForSettingsTab(item.key)
      const state = scope === undefined ? undefined : registry?.scopes[scope]
      const isFusionLeaf = item.key === 'systemAgents'
      const outcomeUnknown =
        state?.ambiguousSubmit !== undefined || (isFusionLeaf && fusionOutcomeUnknown)
      const stale = state?.staleRemote !== undefined || (isFusionLeaf && fusionStale)
      const dirty = state?.dirty === true || (isFusionLeaf && fusionDirty)
      if (!outcomeUnknown && !stale && !dirty) return item
      return {
        ...item,
        badge: outcomeUnknown || stale ? '!' : '•',
        badgeTone: outcomeUnknown
          ? ('danger' as const)
          : stale
            ? ('attention' as const)
            : undefined,
        badgeAriaLabel: outcomeUnknown
          ? t('settings.outcomeUnknown')
          : stale
            ? t('settings.staleTitle')
            : t('editor.statusUnsaved'),
      }
    }),
  }))

  return (
    <PageSectionNav<SettingsTab>
      groups={groupsWithStatus}
      active={active}
      presentation="rail"
      ariaLabel={t('settings.sectionNavLabel')}
      idPrefix="settings"
      renderDestination={(key, destination) => (
        <PageSectionLink
          to="/settings"
          search={(previous) => withSettingsTab(previous, key)}
          className={destination.className}
          pageSectionCurrent={destination.ariaCurrent}
        >
          {destination.children}
        </PageSectionLink>
      )}
      onSelectCompact={onSelectCompact}
    />
  )
}

function isSettingsTab(tab: unknown): tab is SettingsTab {
  return typeof tab === 'string' && (SETTINGS_TABS as readonly string[]).includes(tab)
}

export function validateSettingsSearch(raw: Record<string, unknown>): SettingsSearch {
  const { tab, ...adjacent } = raw
  return isSettingsTab(tab) ? { ...adjacent, tab } : adjacent
}

export function withSettingsTab<T extends Record<string, unknown>>(
  previous: T,
  tab: SettingsTab,
): T & { tab: SettingsTab } {
  return { ...previous, tab }
}

function SettingsPage() {
  const [runtimeFlashKey, setRuntimeFlashKey] = useState(0)
  const claimedRuntimeFlashRef = useRef(0)
  const sectionHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const { t } = useTranslation()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  // validateSearch is the first line of defence, while this runtime guard also
  // keeps URL and panel aligned in embedded/test routers that can hand a route
  // raw search state during initial hydration.
  const tab = isSettingsTab(search.tab) ? search.tab : 'runtime'
  const claimRuntimeFlash = useCallback((key: number) => {
    if (claimedRuntimeFlashRef.current === key) return false
    claimedRuntimeFlashRef.current = key
    return true
  }, [])
  const configQueryKey = useConfigQueryKey()
  const config = useQuery<Config>({
    queryKey: configQueryKey,
    queryFn: ({ signal }) => queryConfig(signal),
  })
  // This independent resource is owned by the route shell, not the active
  // System-agents leaf, so switching Settings tabs cannot discard its draft.
  const fusionDraft = useFusionAgentDraft({
    enabled: config.data !== undefined && tab === 'systemAgents',
  })

  // RFC-198: URL search is the single tab authority. Missing/unknown values
  // canonicalize to runtime with replace so Back never loops through a bad URL.
  // RFC-032's legacy /settings#runtime entry point is consumed once in the same
  // navigation and still bumps the RuntimeTab flash key.
  const hash = useRouterState({ select: (s) => s.location.hash })
  useEffect(() => {
    if (isSettingsTab(search.tab)) return
    if (hash === 'runtime') setRuntimeFlashKey((k) => k + 1)
    void navigate({
      search: (previous) => withSettingsTab(previous, 'runtime'),
      hash: hash === 'runtime' ? '' : hash,
      replace: true,
    })
  }, [hash, navigate, search.tab])

  const sectionGroups: readonly PageSectionGroup<SettingsTab>[] = [
    {
      key: 'execution',
      label: t('settings.sectionGroups.execution'),
      items: [
        {
          key: 'runtime',
          label: t('settings.tabRuntime'),
          description: t('settings.sectionDescriptions.runtime'),
        },
        {
          key: 'systemAgents',
          label: t('settings.tabSystemAgents'),
          description: t('settings.sectionDescriptions.systemAgents'),
        },
        {
          key: 'limits',
          label: t('settings.tabLimits'),
          description: t('settings.sectionDescriptions.limits'),
        },
      ],
    },
    {
      key: 'reliability',
      label: t('settings.sectionGroups.reliability'),
      items: [
        {
          key: 'recovery',
          label: t('settings.tabRecovery'),
          description: t('settings.sectionDescriptions.recovery'),
        },
        {
          key: 'git',
          label: t('settings.tabGit'),
          description: t('settings.sectionDescriptions.git'),
        },
        {
          key: 'gc',
          label: t('settings.tabGc'),
          description: t('settings.sectionDescriptions.gc'),
        },
      ],
    },
    {
      key: 'access',
      label: t('settings.sectionGroups.access'),
      items: [
        {
          key: 'network',
          label: t('settings.tabNetwork'),
          description: t('settings.sectionDescriptions.network'),
        },
        {
          key: 'authentication',
          label: t('settings.tabAuthentication'),
          description: t('settings.sectionDescriptions.authentication'),
        },
      ],
    },
    {
      key: 'interface',
      label: t('settings.sectionGroups.interface'),
      items: [
        {
          key: 'appearance',
          label: t('settings.tabAppearance'),
          description: t('settings.sectionDescriptions.appearance'),
        },
        {
          key: 'rendering',
          label: t('settings.tabRendering'),
          description: t('settings.sectionDescriptions.rendering'),
        },
      ],
    },
  ]
  const activeSection = sectionGroups
    .flatMap((group) => group.items)
    .find((section) => section.key === tab)
  let panelContent: React.ReactNode = null
  if (config.data === undefined) {
    if (config.isLoading) panelContent = <LoadingState label={t('settings.loading')} />
    else if (config.error !== null) {
      panelContent = <ErrorBanner error={config.error} onRetry={() => void config.refetch()} />
    }
  } else {
    panelContent = (
      <>
        {config.error !== null && (
          <ErrorBanner error={config.error} onRetry={() => void config.refetch()} />
        )}
        {tab === 'runtime' && (
          <RuntimeTab
            flashKey={runtimeFlashKey}
            claimFlash={claimRuntimeFlash}
            focusFallbackRef={sectionHeadingRef}
          />
        )}
        {tab === 'systemAgents' && (
          <SystemAgentsTab config={config.data} fusionDraft={fusionDraft} />
        )}
        {tab === 'limits' && <LimitsTab config={config.data} />}
        {tab === 'recovery' && <RecoveryTab config={config.data} />}
        {tab === 'git' && <GitTab config={config.data} />}
        {tab === 'gc' && <GcTab config={config.data} />}
        {tab === 'network' && <NetworkTab config={config.data} />}
        {tab === 'appearance' && <AppearanceTab config={config.data} />}
        {tab === 'rendering' && <RenderingTab config={config.data} />}
        {tab === 'authentication' && <AuthenticationTab />}
      </>
    )
  }

  const sectionShell = (
    <div className="page-section-layout settings-section-layout">
      <SettingsSectionNav
        groups={sectionGroups}
        active={tab}
        fusionDirty={fusionDraft.dirty}
        fusionStale={fusionDraft.stale}
        fusionOutcomeUnknown={fusionDraft.outcomeUnknown}
        onSelectCompact={(next) => {
          if (next === tab) return
          void navigate({ search: (previous) => withSettingsTab(previous, next) })
        }}
      />

      <section
        className={`settings-section-panel settings-section-panel--${tab}`}
        aria-labelledby={`settings-section-title-${tab}`}
      >
        <header className="settings-section-panel__header">
          <h2 ref={sectionHeadingRef} id={`settings-section-title-${tab}`} tabIndex={-1}>
            {activeSection?.label}
          </h2>
          <p>{activeSection?.description}</p>
        </header>
        {panelContent}
      </section>
    </div>
  )

  return (
    <div className="page">
      <PageHeader title={t('settings.title')} />
      {config.data === undefined ? (
        sectionShell
      ) : (
        <SettingsDraftProvider
          config={config.data}
          externalDirty={fusionDraft.dirty}
          externalBusy={fusionDraft.busy}
          externalOutcomeUnknown={fusionDraft.outcomeUnknown}
          externalDiscard={() => {
            void fusionDraft.discard()
          }}
        >
          {sectionShell}
        </SettingsDraftProvider>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface TabProps {
  config: Config
}

export function RuntimeTab({
  flashKey = 0,
  claimFlash,
  focusFallbackRef,
}: {
  flashKey?: number
  claimFlash?: (key: number) => boolean
  focusFallbackRef?: React.RefObject<HTMLElement | null>
}) {
  const runtimeRef = useRef<HTMLDivElement | null>(null)
  const [flashing, setFlashing] = useState(false)

  // RFC-032: scroll + flash the runtime block when the sidebar runtime row
  // navigates here (location.hash === '#runtime' bumps flashKey).
  useEffect(() => {
    if (flashKey === 0 || claimFlash?.(flashKey) === false) return
    setFlashing(true)
    runtimeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const id = window.setTimeout(() => setFlashing(false), 2000)
    return () => window.clearTimeout(id)
  }, [claimFlash, flashKey])

  // RFC-113: the Runtime tab is JUST the runtimes table. Every runtime/model
  // setting (binary, model, variant, temperature, steps + the in-table default
  // marker) lives on the rows now; the global execution knobs (concurrency / log
  // level / auto commit&push) moved to the Limits tab.
  // RFC-205 T5: plus the sandbox status chip + sandboxMode control on top.
  return (
    <div
      ref={runtimeRef}
      className={`runtime-status-anchor${flashing ? ' runtime-status-anchor--flash' : ''}`}
      data-flash={flashing ? '1' : '0'}
    >
      <SandboxCard />
      <div className="stack-top--md">
        <RuntimeList showHeading={false} restoreFocusFallbackRef={focusFallbackRef} />
      </div>
    </div>
  )
}

function LimitsTab({ config }: TabProps) {
  const { t } = useTranslation()
  const draft = useTabState(SETTINGS_CONFIG_SCOPE_IDS.limits, config)
  const { state, setState, save } = draft
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
      editState={draft}
    >
      <Field
        label={t('settingsForm.perTaskDuration')}
        required
        hint={t('settingsForm.zeroUnlimited')}
      >
        <NumberInput
          value={state.defaultPerTaskMaxDurationMs}
          onChange={(v) => setState({ ...state, defaultPerTaskMaxDurationMs: v ?? 0 })}
          min={0}
          step={60_000}
        />
      </Field>
      <Field
        label={t('settingsForm.perTaskTokens')}
        required
        hint={t('settingsForm.zeroUnlimited')}
      >
        <NumberInput
          value={state.defaultPerTaskMaxTotalTokens}
          onChange={(v) => setState({ ...state, defaultPerTaskMaxTotalTokens: v ?? 0 })}
          min={0}
        />
      </Field>
      <Field label={t('settingsForm.perNodeTimeout')} required>
        <NumberInput
          value={state.defaultPerNodeTimeoutMs}
          onChange={(v) => setState({ ...state, defaultPerNodeTimeoutMs: v ?? 60_000 })}
          min={1000}
          step={60_000}
        />
      </Field>
      <Field
        label={t('settingsForm.nodeRetries')}
        required
        hint={t('settingsForm.nodeRetriesHint')}
      >
        <NumberInput
          value={state.defaultNodeRetries}
          onChange={(v) => setState({ ...state, defaultNodeRetries: v ?? 0 })}
          min={0}
        />
      </Field>
      <Field label={t('settingsForm.largeOutputThreshold')} required>
        <NumberInput
          value={state.largeOutputThresholdBytes}
          onChange={(v) => setState({ ...state, largeOutputThresholdBytes: v ?? 1_048_576 })}
          min={1024}
          step={1024}
        />
      </Field>
      {/* RFC-113: global execution knobs relocated from the Runtime tab. */}
      <div className="form-grid form-grid--cols-2">
        <Field label={t('settingsForm.maxConcurrentNodes')} required>
          <NumberInput
            value={state.maxConcurrentNodes}
            onChange={(v) => setState({ ...state, maxConcurrentNodes: v ?? 1 })}
            min={1}
          />
        </Field>
        <Field label={t('settingsForm.multiProcessConc')} required>
          <NumberInput
            value={state.multiProcessSubprocessConcurrency}
            onChange={(v) => setState({ ...state, multiProcessSubprocessConcurrency: v ?? 1 })}
            min={1}
          />
        </Field>
      </div>
      <Field label={t('settingsForm.logLevel')}>
        <Select<NonNullable<Config['logLevel']>>
          value={state.logLevel ?? config.logLevel}
          ariaLabel={t('settingsForm.logLevel')}
          onChange={(v) => setState({ ...state, logLevel: v })}
          options={[
            { value: 'debug', label: 'debug' },
            { value: 'info', label: 'info' },
            { value: 'warn', label: 'warn' },
            { value: 'error', label: 'error' },
          ]}
        />
      </Field>
    </SectionForm>
  )
}

// RFC-108 T24 (AR-config) — auto-recovery knobs. Every auto-execution toggle
// defaults OFF (decision D1); this tab is where an operator opts in + tunes the
// circuit-breaker. Reuses the shared Switch / Field / NumberInput primitives.
function RecoveryTab({ config }: TabProps) {
  const { t } = useTranslation()
  const draft = useTabState(SETTINGS_CONFIG_SCOPE_IDS.recovery, config)
  const { state, setState, save } = draft
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
      editState={draft}
    >
      <Switch
        checked={state.autoResumeOnBoot ?? false}
        onChange={(v) => setState({ ...state, autoResumeOnBoot: v })}
        label={t('settingsForm.autoResumeOnBoot')}
        hint={t('settingsForm.autoResumeOnBootHint')}
      />
      <Switch
        checked={(state.autoRepair ?? {}).S4 === true}
        onChange={(v) => setState({ ...state, autoRepair: { ...(state.autoRepair ?? {}), S4: v } })}
        label={t('settingsForm.autoRepairS4')}
        hint={t('settingsForm.autoRepairS4Hint')}
      />
      <Switch
        checked={state.autoKillStalledChild ?? false}
        onChange={(v) => setState({ ...state, autoKillStalledChild: v })}
        label={t('settingsForm.autoKillStalledChild')}
        hint={t('settingsForm.autoKillStalledChildHint')}
      />
      <Field label={t('settingsForm.heartbeatStallMs')} required>
        <NumberInput
          value={state.heartbeatStallMs}
          onChange={(v) => setState({ ...state, heartbeatStallMs: v ?? 1_800_000 })}
          min={1000}
          step={60_000}
        />
      </Field>
      <Field label={t('settingsForm.maxAutoRecoveriesPerWindow')} required>
        <NumberInput
          value={state.maxAutoRecoveriesPerWindow}
          onChange={(v) => setState({ ...state, maxAutoRecoveriesPerWindow: v ?? 3 })}
          min={1}
        />
      </Field>
      <Field label={t('settingsForm.autoRecoveryWindowMs')} required>
        <NumberInput
          value={state.autoRecoveryWindowMs}
          onChange={(v) => setState({ ...state, autoRecoveryWindowMs: v ?? 3_600_000 })}
          min={1000}
          step={60_000}
        />
      </Field>
      <Field
        label={t('settingsForm.periodicOrphanReconcileMs')}
        hint={t('settingsForm.zeroDisabled')}
      >
        <NumberInput
          value={state.periodicOrphanReconcileMs}
          onChange={(v) => setState({ ...state, periodicOrphanReconcileMs: v ?? 0 })}
          min={0}
          step={60_000}
        />
      </Field>
    </SectionForm>
  )
}

/**
 * RFC-210 — submodule handling: recursion mode, parallelism, upstream tracking,
 * and the background refresh cadence.
 *
 * Lives next to GC under "reliability" because both are about what the platform
 * does to a repo outside a task run.
 */
function GitTab({ config }: TabProps) {
  const { t } = useTranslation()
  const draft = useTabState(SETTINGS_CONFIG_SCOPE_IDS.git, config)
  const { state, setState, save } = draft
  const refresh = state.submoduleAutoRefresh
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
      editState={draft}
    >
      <Field
        label={t('settingsForm.gitRecurseSubmodules')}
        hint={t('settingsForm.gitRecurseSubmodulesHint')}
      >
        <Select
          value={state.gitRecurseSubmodules ?? 'auto'}
          onChange={(v) => setState({ ...state, gitRecurseSubmodules: v })}
          options={[
            { value: 'auto' as const, label: t('settingsForm.gitRecurseAuto') },
            { value: 'always' as const, label: t('settingsForm.gitRecurseAlways') },
            { value: 'never' as const, label: t('settingsForm.gitRecurseNever') },
          ]}
          ariaLabel={t('settingsForm.gitRecurseSubmodules')}
        />
      </Field>
      <div className="form-grid form-grid--cols-2">
        <Field
          label={t('settingsForm.gitSubmoduleJobs')}
          hint={t('settingsForm.gitSubmoduleJobsHint')}
        >
          <NumberInput
            value={state.gitSubmoduleJobs ?? 4}
            onChange={(v) => setState({ ...state, gitSubmoduleJobs: v ?? 4 })}
            min={1}
            max={32}
          />
        </Field>
      </div>
      <Switch
        checked={state.gitSubmoduleRemote === true}
        onChange={(v) => setState({ ...state, gitSubmoduleRemote: v })}
        label={t('settingsForm.gitSubmoduleRemote')}
        hint={t('settingsForm.gitSubmoduleRemoteHint')}
      />
      <Switch
        checked={refresh?.enabled !== false}
        onChange={(v) =>
          setState({ ...state, submoduleAutoRefresh: { ...(refresh ?? {}), enabled: v } })
        }
        label={t('settingsForm.submoduleAutoRefresh')}
        hint={t('settingsForm.submoduleAutoRefreshHint')}
      />
      <div className="form-grid form-grid--cols-2">
        <Field label={t('settingsForm.submoduleRefreshIntervalMs')}>
          <NumberInput
            value={refresh?.intervalMs ?? 6 * 60 * 60 * 1000}
            onChange={(v) =>
              setState({
                ...state,
                submoduleAutoRefresh: {
                  ...(refresh ?? { enabled: true }),
                  ...(v !== undefined ? { intervalMs: v } : {}),
                },
              })
            }
            min={60_000}
            step={60 * 60 * 1000}
          />
        </Field>
        <Field label={t('settingsForm.submoduleOnlyRecentDays')}>
          <NumberInput
            value={refresh?.onlyRecentDays ?? 30}
            onChange={(v) =>
              setState({
                ...state,
                submoduleAutoRefresh: {
                  ...(refresh ?? { enabled: true }),
                  ...(v !== undefined ? { onlyRecentDays: v } : {}),
                },
              })
            }
            min={1}
          />
        </Field>
      </div>
    </SectionForm>
  )
}

function GcTab({ config }: TabProps) {
  const { t } = useTranslation()
  const draft = useTabState(SETTINGS_CONFIG_SCOPE_IDS.gc, config)
  const { state, setState, save } = draft
  const gc = state.worktreeAutoGc
  const thresholds = state.eventsArchiveThresholds
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
      editState={draft}
    >
      <Switch
        checked={gc?.enabled === true}
        onChange={(v) => setState({ ...state, worktreeAutoGc: { ...(gc ?? {}), enabled: v } })}
        label={t('settingsForm.autoGcLabel')}
        hint={t('settingsForm.autoGcHint')}
      />
      <div className="form-grid form-grid--cols-2">
        <Field label={t('settingsForm.olderThanDays')}>
          <NumberInput
            value={gc?.olderThanDays}
            onChange={(v) =>
              setState({
                ...state,
                worktreeAutoGc: { ...(gc ?? { enabled: false }), olderThanDays: v },
              })
            }
            min={1}
          />
        </Field>
        <Switch
          checked={gc?.onlyMerged === true}
          onChange={(v) =>
            setState({
              ...state,
              worktreeAutoGc: { ...(gc ?? { enabled: false }), onlyMerged: v },
            })
          }
          label={t('settingsForm.onlyMerged')}
        />
      </div>
      <Field
        label={t('settingsForm.archivePerNodeRun')}
        required
        hint={t('settingsForm.archivePerNodeRunHint')}
      >
        <NumberInput
          value={thresholds?.perNodeRunRows}
          onChange={(v) =>
            setState({
              ...state,
              eventsArchiveThresholds: { ...thresholds!, perNodeRunRows: v ?? 50_000 },
            })
          }
          min={1000}
        />
      </Field>
      <Field
        label={t('settingsForm.archiveGlobal')}
        required
        hint={t('settingsForm.archiveGlobalHint')}
      >
        <NumberInput
          value={thresholds?.globalRows}
          onChange={(v) =>
            setState({
              ...state,
              eventsArchiveThresholds: { ...thresholds!, globalRows: v ?? 1_000_000 },
            })
          }
          min={10_000}
        />
      </Field>
      <BackupCard />
    </SectionForm>
  )
}

// GET /api/restore/pending payload (RFC-213 impl-gate P1-5) — the armed
// staged-restore marker plus any failed-restore quarantine dirs.
interface RestorePendingInfo {
  requestedAt: number
  stagedBytes: number | null
  noMigrate: boolean
  skipIntegrityCheck: boolean
}

interface RestoreFailedInfo {
  dir: string
  failedAt: number | null
  error: string | null
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function BackupCard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ path: string; sizeBytes: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restoreStaged, setRestoreStaged] = useState(false)
  // RFC-213 impl-gate P1-5: the picked file is held here until the destructive
  // confirmation dialog is answered — NOTHING is uploaded before "Confirm".
  // A mis-picked file used to silently arm a whole-platform rollback.
  const [restoreCandidate, setRestoreCandidate] = useState<File | null>(null)
  const restoreInputRef = useRef<HTMLInputElement>(null)
  const restoreButtonRef = useRef<HTMLButtonElement>(null)
  // Armed staged-restore visibility. The endpoint is admin-only; for
  // non-admins the query 403s and the banners below simply stay hidden.
  const restorePending = useQuery<{
    pending: RestorePendingInfo | null
    failed: RestoreFailedInfo[]
  }>({
    queryKey: ['restore-pending'],
    queryFn: ({ signal }) => api.get('/api/restore/pending', undefined, signal),
    retry: false,
  })
  const cancelStaged = useMutation({
    mutationFn: () => api.delete<{ cleared: boolean }>('/api/restore/pending'),
    onSuccess: () => {
      setRestoreStaged(false)
      void qc.invalidateQueries({ queryKey: ['restore-pending'] })
    },
  })
  const runBackup = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await api.post<{ path: string; sizeBytes: number }>('/api/backup', {})
      setResult({ path: r.path, sizeBytes: r.sizeBytes })
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setBusy(false)
    }
  }
  const onRestoreFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (file === undefined) return
    setRestoreStaged(false)
    setRestoreCandidate(file)
  }
  // Runs inside ConfirmDialog: a rejection keeps the dialog open with the
  // ErrorBanner (bad tarballs 400 with the validation error); only a
  // fulfilled upload closes it.
  const confirmRestore = async () => {
    if (restoreCandidate === null) return
    const form = new FormData()
    form.append('file', restoreCandidate)
    await apiPostMultipart<{ status: string }>('/api/restore', form)
    setRestoreStaged(true)
    void qc.invalidateQueries({ queryKey: ['restore-pending'] })
  }
  const pending = restorePending.data?.pending ?? null
  const lastFailed = restorePending.data?.failed[0]
  return (
    <Card
      as="section"
      className="stack-top--md"
      header={<strong>{t('settings.backupTitle')}</strong>}
    >
      <p className="settings-hint">{t('settings.backupHint')}</p>
      <button type="button" className="btn" onClick={runBackup} disabled={busy}>
        {busy ? t('settings.backupRunning') : t('settings.backupCreate')}
      </button>
      {result !== null && (
        <p className="muted settings-hint settings-hint--tight stack-top--sm">
          {t('settings.backupSavedAs')}
          <code>{result.path}</code> ({formatMb(result.sizeBytes)})
        </p>
      )}
      {error !== null && <ErrorBanner error={error} />}

      <p className="settings-hint stack-top--md">{t('settings.restoreHint')}</p>
      <input
        ref={restoreInputRef}
        type="file"
        accept=".gz,.tgz,.tar.gz,application/gzip"
        hidden
        onChange={onRestoreFile}
        data-testid="restore-file-input"
      />
      <button
        ref={restoreButtonRef}
        type="button"
        className="btn btn--danger"
        onClick={() => restoreInputRef.current?.click()}
      >
        {t('settings.restoreButton')}
      </button>
      {restoreStaged && (
        <p className="muted settings-hint settings-hint--tight stack-top--sm">
          {t('settings.restoreStaged')}
        </p>
      )}
      {pending !== null && (
        <NoticeBanner
          tone="warning"
          className="stack-top--md"
          title={t('settings.restorePendingTitle')}
          testid="restore-pending-banner"
          action={
            <ConfirmButton
              label={t('settings.restorePendingCancel')}
              variant="danger"
              size="sm"
              disabled={cancelStaged.isPending}
              onConfirm={() => cancelStaged.mutateAsync()}
            />
          }
        >
          {t('settings.restorePendingBody', {
            when: new Date(pending.requestedAt).toLocaleString(),
            size:
              pending.stagedBytes === null
                ? t('settings.restorePendingSizeUnknown')
                : formatMb(pending.stagedBytes),
          })}
        </NoticeBanner>
      )}
      {cancelStaged.error !== null && <ErrorBanner error={cancelStaged.error} />}
      {lastFailed !== undefined && (
        <NoticeBanner
          tone="error"
          size="compact"
          className="stack-top--md"
          title={t('settings.restoreFailedTitle')}
          testid="restore-failed-banner"
        >
          <div>
            {t('settings.restoreFailedBody', {
              when:
                lastFailed.failedAt === null
                  ? t('common.emDash')
                  : new Date(lastFailed.failedAt).toLocaleString(),
              error: lastFailed.error ?? t('settings.restoreFailedNoError'),
            })}
          </div>
          <div>
            {t('settings.restoreFailedDirHint')} <code>{lastFailed.dir}</code>
          </div>
        </NoticeBanner>
      )}
      <ConfirmDialog
        open={restoreCandidate !== null}
        title={t('settings.restoreConfirmTitle')}
        description={t('settings.restoreConfirmBody', {
          name: restoreCandidate?.name ?? '',
          size: formatMb(restoreCandidate?.size ?? 0),
        })}
        confirmLabel={t('settings.restoreConfirmAction')}
        tone="danger"
        onConfirm={confirmRestore}
        onClose={() => setRestoreCandidate(null)}
        triggerRef={restoreButtonRef}
      />
    </Card>
  )
}

// GET /api/daemon payload — the daemon's *effective* runtime binding, read from
// the run-info file. Distinct from the persisted bindHost/bindPort in config.
interface DaemonInfo {
  pid: number
  host: string
  port: number
  url: string
  startedAt: string
}

export function NetworkTab({ config }: TabProps) {
  const { t } = useTranslation()
  const draft = useTabState(SETTINGS_CONFIG_SCOPE_IDS.network, config)
  const { state, setState, save, restartRequired } = draft
  // Read the daemon's EFFECTIVE binding (GET /api/daemon, from the run-info
  // file), but keep it outside the persisted draft. An ephemeral port is useful
  // context, not user intent: merely opening this tab must not make the section
  // dirty or silently pin a once-random port. The explicit action below is the
  // only path that copies the suggestion into the saveable Config projection.
  const daemon = useQuery<DaemonInfo | null>({
    queryKey: ['daemon-info'],
    queryFn: ({ signal }) => api.get('/api/daemon', undefined, signal),
  })
  const effective = daemon.data
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
      restartRequired={restartRequired}
      editState={draft}
    >
      <Field label={t('settingsForm.bindHost')} required hint={t('settingsForm.bindHostHint')}>
        <TextInput
          value={state.bindHost ?? '127.0.0.1'}
          onChange={(v) => setState({ ...state, bindHost: v })}
        />
      </Field>
      <div>
        <Field label={t('settingsForm.bindPort')} hint={t('settingsForm.bindPortHint')}>
          <NumberInput
            value={state.bindPort}
            onChange={(v) => setState({ ...state, bindPort: v ?? 0 })}
            placeholder={
              state.bindPort == null && effective != null ? String(effective.port) : undefined
            }
            data-testid="settings-bind-port"
            min={0}
            max={65535}
          />
        </Field>
        {(state.bindPort == null || state.bindPort === 0) && effective != null && (
          <div className="form-field__hint stack-top--xs">
            <span>{t('settingsForm.bindPortCurrent', { port: effective.port })}</span>{' '}
            <button
              type="button"
              className="btn btn--sm"
              data-testid="settings-use-effective-port"
              onClick={() => setState({ ...state, bindPort: effective.port })}
            >
              {t('settingsForm.bindPortUseCurrent')}
            </button>
          </div>
        )}
      </div>
    </SectionForm>
  )
}

export function AppearanceTab({ config }: TabProps) {
  const { t } = useTranslation()
  const draft = useTabState(SETTINGS_CONFIG_SCOPE_IDS.appearance, config, {
    onSaved: (next) => {
      if (isSupportedLanguage(next.language)) setLanguage(next.language as SupportedLanguage)
    },
  })
  const { state, setState, save } = draft
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
      editState={draft}
    >
      <Field label={t('settings.themeLabel')} hint={t('settings.themeHint')}>
        <Select<NonNullable<Config['theme']>>
          value={state.theme ?? 'system'}
          ariaLabel={t('settings.themeLabel')}
          onChange={(v) => setState({ ...state, theme: v })}
          options={[
            { value: 'system', label: t('settings.themeSystem') },
            { value: 'light', label: t('settings.themeLight') },
            { value: 'dark', label: t('settings.themeDark') },
          ]}
        />
      </Field>
      <Field label={t('settings.languageLabel')} hint={t('settings.languageHint')}>
        <Select<SupportedLanguage>
          value={state.language ?? 'zh-CN'}
          ariaLabel={t('settings.languageLabel')}
          data-testid="settings-language-select"
          onChange={(v) => setState({ ...state, language: v })}
          options={[
            { value: 'zh-CN', label: t('settings.languageZhCN') },
            { value: 'en-US', label: t('settings.languageEnUS') },
          ]}
        />
      </Field>
    </SectionForm>
  )
}

// RFC-156 — the config.json keys the three config-driven internal agents own. One
// source for the useTabState slice AND the "did any config field change?" check
// (so a fusion-only save can skip the config PUT — Codex impl-gate P2c).
// RFC-156 — each internal agent renders as a bordered <Card> (shared RFC-124
// primitive) so the blocks read as four DISTINCT panels instead of blending into
// one scroll. Header = title + one-line role hint; `children` = that agent's
// fields (kept in a `.form-section__body` for the 16px field rhythm).
function AgentCard({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <Card className="system-agent-card">
      <div>
        <div className="form-section__title">{title}</div>
        <p className="settings-hint settings-hint--tight">{hint}</p>
      </div>
      <div className="form-section__body">{children}</div>
    </Card>
  )
}

// RFC-156 — "System agents" tab. One card per internal framework agent, each a
// "runtime selector + that agent's run-config":
//   • commit-push / memory distiller / merge-conflict resolver persist to
//     config.json (a single ConfigPatch PUT);
//   • skill-fusion persists to the aw-skill-merger agent ROW (a runtime-only PUT).
// The ONE Save button at the bottom flushes BOTH — so it saves all four internal
// agents, not just the config ones. The fusion agent-row PATCH only fires when
// its runtime actually changed (untouched → no redundant write). Absorbed the
// commit-push block from Limits + the whole former Memory tab (distiller runtime
// + output language).
//
// D6 — a runtime selector's onChange sets the runtime AND nulls the paired
// deprecated `*Model`. resolveInternalAgentRuntime resolves runtimeName →
// deprecatedModel → defaultRuntime, so clearing only the runtime on "inherit"
// would fall THROUGH to a stale legacy model instead of the global default.
// RFC-117 D2 already made the model come from the profile, so a lingering
// `*Model` is pure vestige — every interaction sweeps it.
interface SystemAgentsTabProps extends TabProps {
  /** Route-owned in production; omitted only by isolated leaf tests/stories. */
  fusionDraft?: FusionAgentDraftController
}

export function SystemAgentsTab({ config, fusionDraft: routeFusionDraft }: SystemAgentsTabProps) {
  const { t } = useTranslation()
  const draft = useTabState(SETTINGS_CONFIG_SCOPE_IDS.systemAgents, config)
  const { state, setState, save } = draft
  // Hooks cannot be conditional. The fallback keeps this exported leaf usable in
  // focused tests; the actual route passes its persistent, above-tab owner and
  // disables this dormant instance.
  const fallbackFusionDraft = useFusionAgentDraft({ enabled: routeFusionDraft === undefined })
  const fusion = routeFusionDraft ?? fallbackFusionDraft
  const fusionSave = fusion.save
  const fusionDirty = fusion.dirty
  // Config is dirty only if the user touched a config field — a fusion-only save
  // must NOT re-PUT the (possibly now-stale) config slice and clobber a concurrent
  // edit to commit/memory/merge (Codex impl-gate P2c).
  const configDirty = draft.dirty

  const combinedEditState: SectionFormProps['editState'] = {
    dirty: configDirty || fusionDirty,
    validity: draft.validity,
    firstInvalidTarget: draft.firstInvalidTarget,
    stale: draft.stale || fusion.stale,
    outcomeUnknown: draft.outcomeUnknown || fusion.outcomeUnknown,
    // Neither resource has a safe in-session unblock after a response-loss
    // write. A GET is observational only while the original handler may still
    // finish later.
    writeBlocked: draft.writeBlocked || fusion.outcomeUnknown,
    reconcile: () => {
      if (draft.outcomeUnknown && !draft.writeBlocked) draft.reconcile()
      if (fusion.outcomeUnknown) void fusion.reconcile()
    },
    discard: () => {
      if (draft.stale && !draft.outcomeUnknown) draft.discard()
      if (fusion.stale && !fusion.outcomeUnknown) void fusion.discard()
    },
  }

  // One Save, two endpoints. When config changed, PUT it first and PATCH the fusion
  // row only in its onSuccess — SEQUENCED so a rejected config PUT (e.g. an
  // out-of-range field) leaves the fusion row untouched rather than half-applied
  // under a "failed" banner (Codex impl-gate P2b). When only fusion changed, PATCH
  // it directly and skip the config PUT entirely (P2c).
  const onSave = () => {
    // Reserve the fusion request/revision/runtime before Config starts. Edits
    // made while Config is pending remain a newer dirty revision and are never
    // substituted into this already-clicked Save operation.
    const preparedFusion = fusionDirty ? fusionSave.prepare() : null
    if (configDirty) {
      save.mutate(undefined, {
        onSuccess: () => {
          preparedFusion?.commit()
        },
        onError: () => preparedFusion?.cancel(),
      })
    } else {
      preparedFusion?.commit()
    }
  }

  return (
    <div>
      <SectionForm
        onSave={onSave}
        busy={save.isPending || fusion.busy}
        error={save.error ?? fusionSave.error}
        // "saved" once whichever mutation ran has settled OK and neither errored —
        // a fusion-only save never runs `save`, so keying only off save.isSuccess
        // would hide the confirmation there.
        success={
          !save.isPending &&
          !fusion.busy &&
          !draft.dirty &&
          !fusion.dirty &&
          (save.isSuccess || fusionSave.isSuccess) &&
          save.error === null &&
          fusionSave.error === null
            ? 'saved'
            : null
        }
        editState={combinedEditState}
        canSave={
          (configDirty || fusionDirty) &&
          (!configDirty || (draft.validity === 'valid' && !draft.outcomeUnknown && !draft.stale)) &&
          !fusion.stale &&
          !fusion.outcomeUnknown
        }
        disabledReason={
          draft.outcomeUnknown || fusion.outcomeUnknown
            ? t('settings.outcomeUnknown')
            : draft.stale || fusion.stale
              ? t('settings.staleTitle')
              : configDirty && draft.validity === 'invalid'
                ? t('settings.invalidChanges')
                : !configDirty && !fusionDirty
                  ? t('settings.noChanges')
                  : undefined
        }
      >
        <AgentCard
          title={t('settings.systemAgents.commitPushTitle')}
          hint={t('settings.systemAgents.commitPushHint')}
        >
          <Field
            label={t('settingsForm.commitPushRuntime')}
            hint={t('settingsForm.commitPushRuntimeHint')}
          >
            <RuntimeSelect
              value={state.commitPushRuntime}
              ariaLabel={t('settingsForm.commitPushRuntime')}
              onChange={(v) => setState({ ...state, commitPushRuntime: v, commitPushModel: null })}
            />
          </Field>
          <div className="form-grid form-grid--cols-2">
            <Field
              label={t('settingsForm.commitPushMaxRepairRetries')}
              hint={t('settingsForm.commitPushMaxRepairRetriesHint')}
            >
              <NumberInput
                value={state.commitPushMaxRepairRetries}
                onChange={(v) => setState({ ...state, commitPushMaxRepairRetries: v })}
                min={0}
                max={10}
              />
            </Field>
            <Field
              label={t('settingsForm.commitPushDiffMaxBytes')}
              hint={t('settingsForm.commitPushDiffMaxBytesHint')}
            >
              <NumberInput
                value={state.commitPushDiffMaxBytes}
                onChange={(v) => setState({ ...state, commitPushDiffMaxBytes: v })}
                min={0}
                max={262144}
              />
            </Field>
          </div>
          <Field label={t('settings.commitPushLangLabel')} hint={t('settings.commitPushLangHint')}>
            <Select<'' | NonNullable<Config['commitPushLang']>>
              data-testid="settings-commit-push-lang-select"
              ariaLabel={t('settings.commitPushLangLabel')}
              value={state.commitPushLang ?? ''}
              // Default sends null (not undefined) → mergePatch deletes the key
              // → runtime falls back to en-US. undefined would be dropped by
              // JSON.stringify and read as "no change", so a saved zh-CN could
              // never revert to Default (RFC-157; same fix on memoryDistillLang).
              onChange={(v) => setState({ ...state, commitPushLang: v === '' ? null : v })}
              options={[
                { value: '', label: t('settings.commitPushLangDefault') },
                { value: 'en-US', label: t('settings.commitPushLangEnUS') },
                { value: 'zh-CN', label: t('settings.commitPushLangZhCN') },
              ]}
            />
          </Field>
        </AgentCard>

        <AgentCard
          title={t('settings.systemAgents.memoryTitle')}
          hint={t('settings.systemAgents.memoryHint')}
        >
          <Field
            label={t('settings.memoryDistillRuntimeLabel')}
            hint={t('settings.memoryDistillRuntimeHint')}
          >
            <RuntimeSelect
              value={state.memoryDistillRuntime}
              ariaLabel={t('settings.memoryDistillRuntimeLabel')}
              onChange={(v) =>
                setState({ ...state, memoryDistillRuntime: v, memoryDistillModel: null })
              }
            />
          </Field>
          <Field
            label={t('settings.memoryDistillLangLabel')}
            hint={t('settings.memoryDistillLangHint')}
          >
            <Select<'' | NonNullable<Config['memoryDistillLang']>>
              data-testid="settings-memory-distill-lang-select"
              ariaLabel={t('settings.memoryDistillLangLabel')}
              value={state.memoryDistillLang ?? ''}
              // RFC-157: Default sends null (not undefined) so mergePatch actually
              // clears a saved language — undefined is dropped by JSON.stringify
              // and treated as "no change". Kept identical to commitPushLang.
              onChange={(v) => setState({ ...state, memoryDistillLang: v === '' ? null : v })}
              options={[
                { value: '', label: t('settings.memoryDistillLangDefault') },
                { value: 'en-US', label: t('settings.memoryDistillLangEnUS') },
                { value: 'zh-CN', label: t('settings.memoryDistillLangZhCN') },
              ]}
            />
          </Field>
        </AgentCard>

        <AgentCard
          title={t('settings.systemAgents.mergeTitle')}
          hint={t('settings.systemAgents.mergeHint')}
        >
          <Field
            label={t('settingsForm.mergeAgentRuntime')}
            hint={t('settingsForm.mergeAgentRuntimeHint')}
          >
            <RuntimeSelect
              value={state.mergeAgentRuntime}
              ariaLabel={t('settingsForm.mergeAgentRuntime')}
              onChange={(v) => setState({ ...state, mergeAgentRuntime: v, mergeAgentModel: null })}
            />
          </Field>
        </AgentCard>

        <AgentCard
          title={t('settings.systemAgents.fusionTitle')}
          hint={t('settings.systemAgents.fusionHint')}
        >
          <Field
            label={t('settings.systemAgents.fusionRuntime')}
            hint={t('settings.systemAgents.fusionRuntimeHint')}
            error={fusion.query.isError ? describeApiError(fusion.query.error) : undefined}
          >
            <RuntimeSelect
              value={fusion.value}
              ariaLabel={t('settings.systemAgents.fusionRuntime')}
              // Disabled until the merger row's real runtime has loaded, so a
              // not-yet-resolved / failed GET can't be edited or read as "Inherit".
              disabled={!fusion.loaded}
              onChange={fusion.setValue}
            />
          </Field>
        </AgentCard>
      </SectionForm>
    </div>
  )
}

function RenderingTab({ config }: TabProps) {
  const { t } = useTranslation()
  const draft = useTabState(SETTINGS_CONFIG_SCOPE_IDS.rendering, config)
  const { state, setState, save } = draft
  const [testState, setTestState] = useState<{
    kind: 'idle' | 'running' | 'success' | 'failure'
    msg?: string
  }>({ kind: 'idle' })

  async function runConnectivityTest() {
    const endpoint = (state.plantumlEndpoint ?? '').trim()
    if (endpoint.length === 0) {
      setTestState({ kind: 'failure', msg: t('settings.renderingTestEmptyEndpoint') })
      return
    }
    setTestState({ kind: 'running' })
    const { PlantUmlBlock } = await import('@/components/review/PlantUmlBlock')
    const mount = document.createElement('div')
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', endpoint, state.plantumlAuthHeader)
    // The PlantUmlBlock helper hands off to fetch + DOM mutation. Watch the
    // mount node for a state change for up to 10s.
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      if (mount.querySelector('.review-diagram__svg') !== null) {
        setTestState({ kind: 'success', msg: t('settings.renderingTestSuccess') })
        return
      }
      if (mount.querySelector('.review-diagram__error') !== null) {
        const errText =
          mount.querySelector('.review-diagram__error')?.textContent ??
          t('settings.renderingTestUnknownError')
        setTestState({ kind: 'failure', msg: t('settings.renderingTestFailure') + errText })
        return
      }
    }
    setTestState({
      kind: 'failure',
      msg: t('settings.renderingTestFailure') + t('settings.renderingTestTimeout'),
    })
  }

  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
      editState={draft}
    >
      <Field
        label={t('settings.renderingPlantumlEndpointLabel')}
        hint={t('settings.renderingPlantumlEndpointHint')}
      >
        <TextInput
          value={state.plantumlEndpoint ?? ''}
          onChange={(v) => setState({ ...state, plantumlEndpoint: v })}
          placeholder={t('settings.renderingPlantumlEndpointPlaceholder')}
        />
      </Field>
      <Field
        label={t('settings.renderingPlantumlAuthLabel')}
        hint={t('settings.renderingPlantumlAuthHint')}
      >
        <TextInput
          value={state.plantumlAuthHeader ?? ''}
          onChange={(v) => setState({ ...state, plantumlAuthHeader: v })}
          placeholder={t('settings.renderingPlantumlAuthPlaceholder')}
        />
      </Field>
      <div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            void runConnectivityTest()
          }}
          disabled={testState.kind === 'running'}
        >
          {testState.kind === 'running'
            ? t('settings.renderingTestRunning')
            : t('settings.renderingTestButton')}
        </button>
        {testState.kind === 'success' && (
          <NoticeBanner tone="success" size="compact">
            {testState.msg}
          </NoticeBanner>
        )}
        {testState.kind === 'failure' && <ErrorBanner error={testState.msg} />}
      </div>
    </SectionForm>
  )
}

// RFC-036 — OIDC providers admin tab. CRUD + connection test for the
// /api/oidc/providers endpoint. clientSecret is never readable from the
// API (only re-writable); empty clientSecret on PATCH leaves the stored
// value unchanged.
function AuthenticationTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<OidcProviderRow | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    name: string
    index: number
  } | null>(null)
  const addProviderRef = useRef<HTMLButtonElement | null>(null)
  const deleteTriggerRef = useRef<HTMLElement | null>(null)
  const deleteFallbackRef = useRef<HTMLElement | null>(null)
  const rowEditRefs = useRef(new Map<string, HTMLButtonElement>())

  const list = useQuery<OidcProviderRow[]>({
    queryKey: ['oidc-providers'],
    queryFn: () => api.get('/api/oidc/providers'),
  })

  const remove = useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) =>
      api.delete(`/api/oidc/providers/${id}${force ? '?force=true' : ''}`),
    onSuccess: async (_result, variables) => {
      // Remove synchronously so ConfirmDialog sees the trigger as disconnected
      // and hands focus to the latest adjacent-row/Add fallback. Await the
      // server refresh before the dialog closes: a neighbour may already have
      // been deleted by another administrator while this confirmation was
      // open, even though it still exists in our cache.
      qc.setQueryData<OidcProviderRow[]>(['oidc-providers'], (rows) =>
        rows?.filter((row) => row.id !== variables.id),
      )
      try {
        await qc.invalidateQueries({ queryKey: ['oidc-providers'], exact: true })
      } catch {
        // The delete itself succeeded. If the refresh failed, prefer the
        // stable Add action over an adjacent row whose server state is now
        // unknown; the list query continues to expose its normal retry path.
        deleteFallbackRef.current = addProviderRef.current
      }
    },
  })

  const openDelete = (
    provider: OidcProviderRow,
    index: number,
    trigger: HTMLButtonElement,
  ): void => {
    const rows = list.data ?? []
    deleteTriggerRef.current = trigger
    refreshDeleteFallback({ id: provider.id, index }, rows)
    setDeleteTarget({ id: provider.id, name: provider.displayName, index })
  }

  // Resolve the fallback from the CURRENT rows immediately before a close.
  // A provider beside the target can disappear while the confirmation is open
  // (another administrator, a refetch, or a concurrent cache update). Keeping
  // only the open-time element would then hand Dialog a disconnected node.
  function refreshDeleteFallback(
    target: { id: string; index: number },
    rows: OidcProviderRow[],
  ): void {
    const remaining = rows.filter((row) => row.id !== target.id)
    const adjacent = remaining[Math.min(target.index, remaining.length - 1)]
    deleteFallbackRef.current =
      (adjacent === undefined ? undefined : rowEditRefs.current.get(adjacent.id)) ??
      addProviderRef.current
  }

  const closeDelete = (): void => {
    if (deleteTarget !== null) {
      refreshDeleteFallback(
        deleteTarget,
        qc.getQueryData<OidcProviderRow[]>(['oidc-providers']) ?? [],
      )
    }
    setDeleteTarget(null)
  }
  return (
    <div className="auth-tab">
      <header className="auth-tab__header">
        <div>
          <h2 className="auth-tab__title">
            {t('settings.auth.providersTitle', { defaultValue: 'OIDC providers' })}
          </h2>
          <p className="auth-tab__hint">
            {t('settings.auth.providersHint', {
              defaultValue:
                'Configure identity providers users can sign in with. Each provider stores its OAuth 2.0 / OIDC client_id + client_secret + scopes. The client_secret is AES-256-GCM-sealed at rest.',
            })}
          </p>
        </div>
        <button
          ref={addProviderRef}
          className="btn btn--primary"
          onClick={() => setShowCreate(true)}
          data-testid="oidc-add-provider"
        >
          {t('settings.auth.add', { defaultValue: 'Add provider' })}
        </button>
      </header>

      {list.isLoading && list.data === undefined && <LoadingState label={t('settings.loading')} />}
      {list.error !== null && (
        <ErrorBanner error={list.error} onRetry={() => void list.refetch()} />
      )}

      {list.data && list.data.length === 0 && (
        <EmptyState
          title={t('settings.auth.empty', {
            defaultValue: 'No providers yet. Add one to enable single sign-on.',
          })}
          size="compact"
        />
      )}

      {list.data && list.data.length > 0 && (
        <TableViewport
          label={t('settings.auth.providersTitle', { defaultValue: 'OIDC providers' })}
          minWidth="lg"
        >
          <table className="account-table">
            <thead>
              <tr>
                <th>{t('settings.auth.colSlug', { defaultValue: 'Slug' })}</th>
                <th>{t('settings.auth.colName', { defaultValue: 'Name' })}</th>
                <th>{t('settings.auth.colIssuer', { defaultValue: 'Issuer' })}</th>
                <th>{t('settings.auth.colProvisioning', { defaultValue: 'Provisioning' })}</th>
                <th>{t('settings.auth.colEnabled', { defaultValue: 'Enabled' })}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((p, index) => (
                <tr key={p.id}>
                  <td>
                    <code>{p.slug}</code>
                  </td>
                  <td>{p.displayName}</td>
                  <td className="account-table__ua">{p.issuerUrl}</td>
                  <td>{p.provisioning}</td>
                  <td>
                    <StatusChip kind={p.enabled ? 'success' : 'neutral'} withDot size="sm">
                      {p.enabled
                        ? t('settings.auth.enabled', { defaultValue: 'enabled' })
                        : t('settings.auth.disabled', { defaultValue: 'disabled' })}
                    </StatusChip>
                  </td>
                  <td>
                    <button
                      ref={(element) => {
                        if (element === null) rowEditRefs.current.delete(p.id)
                        else rowEditRefs.current.set(p.id, element)
                      }}
                      className="btn btn--ghost btn--xs"
                      onClick={() => setEditing(p)}
                      data-testid={`oidc-edit-${p.id}`}
                    >
                      {t('settings.auth.edit', { defaultValue: 'Edit' })}
                    </button>
                    <button
                      className="btn btn--ghost btn--xs btn--danger"
                      onClick={(event) => openDelete(p, index, event.currentTarget)}
                      data-testid={`oidc-delete-${p.id}`}
                    >
                      {t('settings.auth.delete', { defaultValue: 'Delete' })}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      )}

      {showCreate && (
        <OidcProviderDialog
          mode="create"
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false)
            qc.invalidateQueries({ queryKey: ['oidc-providers'] })
          }}
        />
      )}
      {editing && (
        <OidcProviderDialog
          mode="edit"
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            qc.invalidateQueries({ queryKey: ['oidc-providers'] })
          }}
        />
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('common.confirmDelete')}
        description={t('settings.auth.deleteConfirm', {
          defaultValue: `Delete provider "${deleteTarget?.name ?? ''}"?`,
          name: deleteTarget?.name ?? '',
        })}
        confirmLabel={t('settings.auth.delete', { defaultValue: 'Delete' })}
        tone="danger"
        onConfirm={async () => {
          if (deleteTarget === null) return
          const target = deleteTarget
          await remove.mutateAsync({ id: target.id, force: false })
          refreshDeleteFallback(
            target,
            qc.getQueryData<OidcProviderRow[]>(['oidc-providers']) ?? [],
          )
        }}
        onClose={closeDelete}
        triggerRef={deleteTriggerRef}
        restoreFocusFallbackRef={deleteFallbackRef}
      />
    </div>
  )
}

interface OidcProviderRow {
  id: string
  slug: string
  displayName: string
  issuerUrl: string
  clientId: string
  scopes: string
  provisioning: 'auto' | 'allowlist' | 'invite'
  allowedEmailDomains: string[]
  iconUrl: string | null
  enabled: boolean
  // RFC-220 — manual endpoint fallbacks + pure-OAuth2 identity knobs.
  authorizationEndpoint: string | null
  tokenEndpoint: string | null
  userinfoEndpoint: string | null
  jwksUri: string | null
  trustEmailVerified: boolean
  usernameClaim: string | null
  subjectClaim: string | null
  createdAt: number
  updatedAt: number
}

// RFC-220 — ProbeResult mirror (backend services/oidcProviders.ts): the /test
// endpoint always answers 200 with this shape; `ok` is the login-readiness
// verdict, per-endpoint rows carry the effective value + its source.
const OIDC_ENDPOINT_KEYS = [
  'authorizationEndpoint',
  'tokenEndpoint',
  'userinfoEndpoint',
  'jwksUri',
] as const
type OidcEndpointKey = (typeof OIDC_ENDPOINT_KEYS)[number]
interface OidcTestResult {
  ok: boolean
  discovery: { ok: boolean; error?: string }
  issuer: string
  endpoints: Record<OidcEndpointKey, { url: string; source: 'discovery' | 'manual' } | null>
  jwksReachable?: boolean
  scopesSupported: string[]
}
type OidcTestView = { kind: 'probe'; result: OidcTestResult } | { kind: 'error'; message: string }

function OidcProviderDialog(props: {
  mode: 'create' | 'edit'
  initial?: OidcProviderRow
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const initial = props.initial
  const [slug, setSlug] = useState(initial?.slug ?? '')
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '')
  const [issuerUrl, setIssuerUrl] = useState(initial?.issuerUrl ?? '')
  const [clientId, setClientId] = useState(initial?.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [scopes, setScopes] = useState(initial?.scopes ?? 'openid profile email')
  const [provisioning, setProvisioning] = useState<'auto' | 'allowlist' | 'invite'>(
    initial?.provisioning ?? 'invite',
  )
  const [allowedDomains, setAllowedDomains] = useState(
    (initial?.allowedEmailDomains ?? []).join(', '),
  )
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  // RFC-220 — manual endpoints + identity knobs ('' in the form ⇔ null on the wire).
  const [authorizationEndpoint, setAuthorizationEndpoint] = useState(
    initial?.authorizationEndpoint ?? '',
  )
  const [tokenEndpoint, setTokenEndpoint] = useState(initial?.tokenEndpoint ?? '')
  const [userinfoEndpoint, setUserinfoEndpoint] = useState(initial?.userinfoEndpoint ?? '')
  const [jwksUri, setJwksUri] = useState(initial?.jwksUri ?? '')
  const [trustEmailVerified, setTrustEmailVerified] = useState(initial?.trustEmailVerified ?? false)
  const [usernameClaim, setUsernameClaim] = useState(initial?.usernameClaim ?? '')
  const [subjectClaim, setSubjectClaim] = useState(initial?.subjectClaim ?? '')
  const [testResult, setTestResult] = useState<null | OidcTestView>(null)
  const [error, setError] = useState<string | null>(null)

  // RFC-151 PR-4 — the seven scattered per-mode branches collapsed into one
  // local strategy lookup (this ternary is the only mode check left) so
  // create/edit differences can't drift independently.
  // `testConnection: null` is the SINGLE source that disables
  // the test affordance in create mode (no saved row id to probe yet):
  // previously the footer's render gate and a throw inside the mutation
  // encoded that rule twice.
  const strategy =
    props.mode === 'create'
      ? {
          title: t('settings.auth.addTitle', { defaultValue: 'Add OIDC provider' }),
          submit: (body: Record<string, unknown>) => api.post('/api/oidc/providers', body),
          // A new row always needs a secret field on the wire ('' when blank).
          clientSecretBody: (secret: string): Record<string, unknown> => ({
            clientSecret: secret,
          }),
          clientSecretRequired: true,
          clientSecretPlaceholder: '',
          testConnection: null,
        }
      : {
          title: t('settings.auth.editTitle', { defaultValue: 'Edit OIDC provider' }),
          submit: (body: Record<string, unknown>) =>
            api.patch(`/api/oidc/providers/${initial!.id}`, body),
          // Blank means "keep the sealed secret" → omit the field entirely.
          clientSecretBody: (secret: string): Record<string, unknown> =>
            secret ? { clientSecret: secret } : {},
          clientSecretRequired: false,
          clientSecretPlaceholder: t('settings.auth.clientSecretEditHint', {
            defaultValue: 'leave blank to keep current',
          }),
          testConnection: () => api.post<OidcTestResult>(`/api/oidc/providers/${initial!.id}/test`),
        }

  const save = useMutation({
    mutationFn: () => {
      // RFC-220 — an empty input means "not configured": the wire value is
      // null (z.string().url() rejects empty strings by design).
      const blankToNull = (v: string): string | null => (v.trim() === '' ? null : v.trim())
      const body = {
        slug,
        displayName,
        issuerUrl,
        clientId,
        ...strategy.clientSecretBody(clientSecret),
        scopes,
        provisioning,
        allowedEmailDomains: allowedDomains
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        iconUrl: null,
        enabled,
        authorizationEndpoint: blankToNull(authorizationEndpoint),
        tokenEndpoint: blankToNull(tokenEndpoint),
        userinfoEndpoint: blankToNull(userinfoEndpoint),
        jwksUri: blankToNull(jwksUri),
        trustEmailVerified,
        usernameClaim: blankToNull(usernameClaim),
        subjectClaim: blankToNull(subjectClaim),
      }
      return strategy.submit(body)
    },
    onSuccess: () => props.onSaved(),
    onError: (e: unknown) => setError(e instanceof ApiError ? e.message : (e as Error).message),
  })

  const testConnection = useMutation({
    mutationFn: async () => {
      // Type-narrowing invariant only — the footer button that fires this
      // mutation renders from the same strategy field, so a null here is
      // unreachable through the UI.
      if (strategy.testConnection === null) {
        throw new Error('test connection is not available before the provider is saved')
      }
      return strategy.testConnection()
    },
    // RFC-220 — /test always answers 200 + ProbeResult (`ok` carries the
    // verdict); the error path is transport-level only.
    onSuccess: (r) => setTestResult({ kind: 'probe', result: r }),
    onError: (e: unknown) =>
      setTestResult({ kind: 'error', message: e instanceof Error ? e.message : String(e) }),
  })

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={strategy.title}
      size="lg"
      footer={
        <>
          {strategy.testConnection !== null && (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={testConnection.isPending}
              onClick={() => testConnection.mutate()}
            >
              {testConnection.isPending
                ? '…'
                : t('settings.auth.testConnection', { defaultValue: 'Test connection' })}
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={props.onClose}>
            {t('settings.auth.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="submit"
            form="oidc-provider-form"
            className="btn btn--primary"
            disabled={save.isPending}
          >
            {save.isPending ? '…' : t('settings.auth.save', { defaultValue: 'Save' })}
          </button>
        </>
      }
    >
      <form
        id="oidc-provider-form"
        className="form-grid oidc-provider-form"
        onSubmit={(e) => {
          e.preventDefault()
          setError(null)
          save.mutate()
        }}
      >
        <fieldset className="oidc-form__group">
          <legend className="oidc-form__group-title">
            {t('settings.auth.groupProvider', { defaultValue: 'Provider' })}
          </legend>
          <p className="oidc-form__group-hint">
            {t('settings.auth.groupProviderHint', {
              defaultValue:
                'Identifies this IdP in the URL and on the login page button. The issuer URL is what the daemon points OIDC discovery at.',
            })}
          </p>
          <div className="oidc-form__row oidc-form__row--cols-2">
            <Field
              label={t('settings.auth.slug', { defaultValue: 'Slug' })}
              required
              hint={t('settings.auth.slugHint', {
                defaultValue: 'Used in /api/auth/oidc/<slug>/callback',
              })}
            >
              <TextInput
                value={slug}
                onChange={setSlug}
                pattern="[a-z0-9][a-z0-9-]{0,63}"
                required
                placeholder="github-enterprise"
              />
            </Field>
            <Field
              label={t('settings.auth.displayName', { defaultValue: 'Display name' })}
              required
              hint={t('settings.auth.displayNameHint', {
                defaultValue: 'Shown on the login page button.',
              })}
            >
              <TextInput
                value={displayName}
                onChange={setDisplayName}
                required
                placeholder="GitHub Enterprise"
              />
            </Field>
          </div>
          <Field
            label={t('settings.auth.issuerUrl', { defaultValue: 'Issuer URL' })}
            required
            hint={t('settings.auth.issuerUrlHint', {
              defaultValue: 'Daemon fetches <issuer>/.well-known/openid-configuration.',
            })}
          >
            <TextInput
              type="url"
              value={issuerUrl}
              onChange={setIssuerUrl}
              required
              placeholder="https://github.corp.com"
            />
          </Field>
        </fieldset>

        <fieldset className="oidc-form__group">
          <legend className="oidc-form__group-title">
            {t('settings.auth.groupManualEndpoints', {
              defaultValue: 'Manual endpoints (optional)',
            })}
          </legend>
          <p className="oidc-form__group-hint">
            {t('settings.auth.groupManualEndpointsHint', {
              defaultValue:
                'Used per field when discovery fails or omits it. A pure OAuth 2.0 IdP needs at least authorize + token + userinfo.',
            })}
          </p>
          <div className="oidc-form__row oidc-form__row--cols-2">
            <Field
              label={t('settings.auth.authorizationEndpoint', {
                defaultValue: 'Authorization endpoint',
              })}
            >
              <TextInput
                type="url"
                value={authorizationEndpoint}
                onChange={setAuthorizationEndpoint}
                placeholder="https://idp.corp.com/oauth/authorize"
              />
            </Field>
            <Field label={t('settings.auth.tokenEndpoint', { defaultValue: 'Token endpoint' })}>
              <TextInput
                type="url"
                value={tokenEndpoint}
                onChange={setTokenEndpoint}
                placeholder="https://idp.corp.com/oauth/token"
              />
            </Field>
          </div>
          <div className="oidc-form__row oidc-form__row--cols-2">
            <Field
              label={t('settings.auth.userinfoEndpoint', { defaultValue: 'Userinfo endpoint' })}
            >
              <TextInput
                type="url"
                value={userinfoEndpoint}
                onChange={setUserinfoEndpoint}
                placeholder="https://idp.corp.com/api/user"
              />
            </Field>
            <Field label={t('settings.auth.jwksUri', { defaultValue: 'JWKS URI' })}>
              <TextInput
                type="url"
                value={jwksUri}
                onChange={setJwksUri}
                placeholder="https://idp.corp.com/jwks.json"
              />
            </Field>
          </div>
        </fieldset>

        <fieldset className="oidc-form__group">
          <legend className="oidc-form__group-title">
            {t('settings.auth.groupCreds', { defaultValue: 'Credentials' })}
          </legend>
          <p className="oidc-form__group-hint">
            {t('settings.auth.groupCredsHint', {
              defaultValue:
                'OAuth 2.0 client your daemon impersonates against the IdP. Secret is AES-256-GCM-sealed at rest.',
            })}
          </p>
          <div className="oidc-form__row oidc-form__row--cols-2">
            <Field label={t('settings.auth.clientId', { defaultValue: 'Client ID' })} required>
              <TextInput value={clientId} onChange={setClientId} required />
            </Field>
            <Field
              label={t('settings.auth.clientSecret', { defaultValue: 'Client secret' })}
              required={strategy.clientSecretRequired}
            >
              <TextInput
                type="password"
                value={clientSecret}
                onChange={setClientSecret}
                required={strategy.clientSecretRequired}
                placeholder={strategy.clientSecretPlaceholder}
              />
            </Field>
          </div>
          <Field
            label={t('settings.auth.scopes', { defaultValue: 'Scopes' })}
            required
            hint={t('settings.auth.scopesHint', {
              defaultValue: 'Space-separated. openid is required; profile + email recommended.',
            })}
          >
            <TextInput value={scopes} onChange={setScopes} required />
          </Field>
        </fieldset>

        <fieldset className="oidc-form__group">
          <legend className="oidc-form__group-title">
            {t('settings.auth.groupBehavior', { defaultValue: 'Behavior' })}
          </legend>
          <Field label={t('settings.auth.provisioning', { defaultValue: 'Provisioning policy' })}>
            <Select<'auto' | 'allowlist' | 'invite'>
              value={provisioning}
              onChange={setProvisioning}
              ariaLabel={t('settings.auth.provisioning', { defaultValue: 'Provisioning' })}
              options={[
                {
                  value: 'invite',
                  label: t('settings.auth.optInvite', { defaultValue: 'invite (recommended)' }),
                  description: t('settings.auth.inviteDesc', {
                    defaultValue:
                      'Only pre-created users with matching verified email may sign in.',
                  }),
                },
                {
                  value: 'allowlist',
                  label: t('settings.auth.optAllowlist', { defaultValue: 'allowlist' }),
                  description: t('settings.auth.allowlistDesc', {
                    defaultValue:
                      'Auto-provision users whose verified email matches an allowed domain.',
                  }),
                },
                {
                  value: 'auto',
                  label: t('settings.auth.optAuto', { defaultValue: 'auto' }),
                  description: t('settings.auth.autoDesc', {
                    defaultValue:
                      'Auto-provision any successful IdP login. Use only with a trusted IdP.',
                  }),
                },
              ]}
              renderOption={(opt) => (
                <span className="select__option-stack">
                  <span className="select__option-title">{opt.label}</span>
                  {opt.description && <span className="select__option-sub">{opt.description}</span>}
                </span>
              )}
            />
          </Field>
          {provisioning === 'allowlist' && (
            <Field
              label={t('settings.auth.allowedDomains', {
                defaultValue: 'Allowed email domains',
              })}
              hint={t('settings.auth.allowedDomainsHint', {
                defaultValue:
                  'Comma-separated, each prefixed with @. email_verified=true is also required.',
              })}
            >
              <TextInput
                value={allowedDomains}
                onChange={setAllowedDomains}
                placeholder="@corp.com, @subsidiary.com"
              />
            </Field>
          )}
          <Switch
            checked={trustEmailVerified}
            onChange={setTrustEmailVerified}
            label={t('settings.auth.trustEmailLabel', {
              defaultValue: 'Trust emails as verified',
            })}
            hint={t('settings.auth.trustEmailHint', {
              defaultValue:
                'Treat every email from this IdP as verified (needed for invite/allowlist with pure OAuth 2.0 IdPs). Leave off if users can set unverified emails there.',
            })}
          />
          <div className="oidc-form__row oidc-form__row--cols-2">
            <Field
              label={t('settings.auth.usernameClaim', { defaultValue: 'Username fields' })}
              hint={t('settings.auth.usernameClaimHint', {
                defaultValue:
                  'Claim names read as the presented name; space-separate several to join them in order (e.g. "name signature"). Blank = standard preferred_username. When set, the display name follows the IdP on every sign-in.',
              })}
            >
              <TextInput
                value={usernameClaim}
                onChange={setUsernameClaim}
                placeholder="preferred_username"
              />
            </Field>
            <Field
              label={t('settings.auth.subjectClaim', { defaultValue: 'Subject field' })}
              hint={t('settings.auth.subjectClaimHint', {
                defaultValue:
                  'Userinfo field carrying the stable unique user ID (e.g. id). Blank = standard sub. Pure OAuth 2.0 only — when set, id_token verification is skipped and the field cannot change once identities exist.',
              })}
            >
              <TextInput value={subjectClaim} onChange={setSubjectClaim} placeholder="sub" />
            </Field>
          </div>
          <Switch
            checked={enabled}
            onChange={setEnabled}
            label={t('settings.auth.enabledLabel', { defaultValue: 'Enabled' })}
            hint={t('settings.auth.enabledHint', {
              defaultValue: 'Visible on the login page when on; hidden when off.',
            })}
          />
        </fieldset>

        {testResult && testResult.kind === 'error' && (
          <div className="oidc-form__test-result oidc-form__test-result--err">
            <strong>✗ {t('settings.auth.testFail', { defaultValue: 'Connection failed' })}</strong>
            <span className="oidc-form__test-detail">{testResult.message}</span>
          </div>
        )}
        {testResult && testResult.kind === 'probe' && (
          <div
            className={`oidc-form__test-result oidc-form__test-result--${
              testResult.result.ok ? 'ok' : 'err'
            }`}
          >
            <strong>
              {testResult.result.ok
                ? `✓ ${t('settings.auth.testReady', {
                    defaultValue: 'Configuration can complete a sign-in',
                  })}`
                : `✗ ${t('settings.auth.testNotReady', {
                    defaultValue: 'Configuration cannot complete a sign-in',
                  })}`}
            </strong>
            <span className="oidc-form__test-detail">
              {testResult.result.discovery.ok
                ? t('settings.auth.testDiscoveryOk', { defaultValue: 'discovery: reachable' })
                : testResult.result.ok
                  ? // "manual endpoints in use" is only true when the manual set
                    // actually carries a login — a broken config must show the
                    // real discovery failure instead (impl-gate P2).
                    t('settings.auth.testDiscoveryDown', {
                      defaultValue: 'discovery unavailable — manual endpoints in use',
                    })
                  : t('settings.auth.testDiscoveryError', {
                      defaultValue: 'discovery unavailable: {{error}}',
                      error: testResult.result.discovery.error ?? 'unknown error',
                    })}
              <br />
              {t('settings.auth.testDetailIssuer', { defaultValue: 'issuer:' })}{' '}
              <code>{testResult.result.issuer}</code>
              {OIDC_ENDPOINT_KEYS.map((key) => {
                const entry = testResult.result.endpoints[key]
                return (
                  <span key={key} className="oidc-form__test-endpoint">
                    <br />
                    {t(`settings.auth.${key}`)}{' '}
                    {entry ? (
                      <>
                        <code>{entry.url}</code>{' '}
                        {entry.source === 'manual'
                          ? t('settings.auth.sourceManual', { defaultValue: '(manual)' })
                          : t('settings.auth.sourceDiscovery', { defaultValue: '(discovery)' })}
                      </>
                    ) : (
                      t('settings.auth.testEndpointMissing', { defaultValue: 'not configured' })
                    )}
                  </span>
                )
              })}
              {testResult.result.jwksReachable === false && (
                <>
                  <br />
                  {t('settings.auth.testJwksUnreachable', {
                    defaultValue:
                      'JWKS is configured but unreachable — id_token sign-ins will fail.',
                  })}
                </>
              )}
            </span>
          </div>
        )}
        {error !== null && <ErrorBanner error={error} />}
      </form>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * P-5-09: config keys whose new value only takes effect on the next daemon
 * start. After a successful PUT we compare these against the pre-save snapshot
 * and surface a restart banner in `<SectionForm>` whenever one of them moved.
 */
export const RESTART_REQUIRED_KEYS: ReadonlySet<keyof ConfigPatch> = new Set([
  'bindHost',
  'bindPort',
])

/**
 * Returns true iff at least one of `keys` is a restart-required key AND its
 * value differs between `before` and `after`. Exported for unit tests.
 */
export function hasRestartRequiredChange(
  keys: readonly (keyof ConfigPatch)[],
  before: Partial<Record<keyof ConfigPatch, unknown>>,
  after: Partial<Record<keyof ConfigPatch, unknown>>,
): boolean {
  return keys.some((k) => {
    if (!RESTART_REQUIRED_KEYS.has(k)) return false
    return after[k] !== before[k]
  })
}

interface UseTabStateOptions {
  onSaved?: (next: Config) => void
}

function useTabState(scope: SettingsConfigScopeId, config: Config, options?: UseTabStateOptions) {
  const [restartRequired, setRestartRequired] = useState(false)
  const draft = useSettingsConfigDraft(scope, config, {
    onSaved: (next, _submitted, baseline) => {
      setRestartRequired(hasRestartRequiredChange(settingsConfigScopeKeys(scope), baseline, next))
      options?.onSaved?.(next)
    },
  })
  const mutate = useCallback(
    (variables?: undefined, mutateOptions?: SettingsConfigDraftMutateOptions) => {
      setRestartRequired(false)
      draft.save.mutate(variables, mutateOptions)
    },
    [draft.save],
  )
  return {
    ...draft,
    save: { ...draft.save, mutate },
    restartRequired,
  } satisfies SettingsConfigDraftController & { restartRequired: boolean }
}

interface SectionFormProps {
  onSave: () => void
  busy: boolean
  error: unknown
  success: string | null
  editState: Pick<
    SettingsConfigDraftController,
    | 'dirty'
    | 'validity'
    | 'firstInvalidTarget'
    | 'stale'
    | 'outcomeUnknown'
    | 'writeBlocked'
    | 'reconcile'
    | 'discard'
  >
  /** System Agents also owns the independent fusion Agent-row scope. */
  canSave?: boolean
  disabledReason?: string
  restartRequired?: boolean
  children: React.ReactNode
}

function SectionForm({
  onSave,
  busy,
  error,
  success,
  editState,
  canSave: canSaveOverride,
  disabledReason: disabledReasonOverride,
  restartRequired,
  children,
}: SectionFormProps) {
  const { t } = useTranslation()
  const canSave =
    canSaveOverride ??
    (editState.dirty && editState.validity === 'valid' && !editState.outcomeUnknown)
  const disabledReason =
    disabledReasonOverride ??
    (editState.outcomeUnknown
      ? t('settings.outcomeUnknown')
      : editState.validity === 'invalid'
        ? t('settings.invalidChanges')
        : !editState.dirty
          ? t('settings.noChanges')
          : undefined)
  return (
    <div>
      <div className="form-grid">{children}</div>
      <div className="form-actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => onSave()}
          disabled={busy || !canSave}
          title={busy ? undefined : disabledReason}
        >
          {busy ? t('common.saving') : t('common.save')}
        </button>
        {success !== null && <span className="form-actions__ok">{t('common.saved')}</span>}
        {error !== null && error !== undefined && (
          <span className="form-actions__error">{describeApiError(error)}</span>
        )}
      </div>
      {!busy && !canSave && disabledReason !== undefined && (
        <p className="muted settings-hint settings-hint--tight">{disabledReason}</p>
      )}
      {editState.outcomeUnknown ? (
        <NoticeBanner
          tone="warning"
          size="compact"
          title={t('settings.outcomeUnknown')}
          className="stack-top--sm"
          action={
            editState.writeBlocked ? undefined : (
              <button type="button" className="btn btn--sm" onClick={editState.reconcile}>
                {t('settings.outcomeUnknownReconcile')}
              </button>
            )
          }
        >
          {t(editState.writeBlocked ? 'settings.writeBlockedBody' : 'settings.outcomeUnknownBody')}
        </NoticeBanner>
      ) : editState.stale ? (
        <NoticeBanner
          tone="warning"
          size="compact"
          title={t('settings.staleTitle')}
          className="stack-top--sm"
          action={
            <button type="button" className="btn btn--sm" onClick={editState.discard}>
              {t('settings.staleDiscard')}
            </button>
          }
        >
          {t('settings.staleBody')}
        </NoticeBanner>
      ) : null}
      {restartRequired === true && (
        <NoticeBanner
          tone="warning"
          size="compact"
          title={t('settings.restartRequiredTitle')}
          className="stack-top--sm"
        >
          {t('settings.restartRequiredHint')}
        </NoticeBanner>
      )}
    </div>
  )
}

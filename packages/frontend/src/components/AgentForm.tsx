// Shared frontmatter + body form for /agents/new and /agents/$id.
// Lifts the entire CreateAgent payload to local state; submission is the
// parent's concern.
//
// RFC-169 (T7) — the six stacked FormSections (RFC-155) became five right-rail
// tabs: Basics / Prompt / Ports / Capabilities & collaboration / Advanced. The RFC-155
// "collapse + rising-edge auto-open" affordance is retired; its "there's
// content here" hint is carried by the Ports/Resources tab count badges
// (portBadgeCount / resourceRefCount, pure + unit-tested). Panels are
// keep-mounted (hidden, not unmounted) so a half-typed JsonField in Advanced
// survives tab switches.

import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { CreateAgent } from '@agent-workflow/shared'
import { AGENT_NAME_RE } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { AgentDependsPicker } from './AgentDependsPicker'
import { DependencyAutodetectButton } from './agents/DependencyAutodetectButton'
import { DependencyTreePreview } from './agents/DependencyTreePreview'
import { mergeAgentDeps } from '@/lib/agent-dep-detect'
import { Field, Switch, TextInput } from './Form'
import { ErrorBanner } from './ErrorBanner'
import { ExecutionContractPicker } from './execution-contracts/ExecutionContractPicker'
import { FeedbackStack } from './FeedbackStack'
import { LoadingState } from './LoadingState'
import { NoticeBanner } from './NoticeBanner'
import { JsonField, jsonFieldChangeFromValue, type JsonFieldChange } from './JsonField'
import { MarkdownEditor } from './MarkdownEditor'
import { McpsPicker } from './McpsPicker'
import { PluginsPicker } from './PluginsPicker'
import { InputsEditor } from './InputsEditor'
import { OutputsEditor } from './OutputsEditor'
import { AgentPortValidationSummary } from './agent-ports/AgentPortValidationSummary'
import { Select } from './Select'
import { SkillsPicker } from './SkillsPicker'
import { TabBar, type TabDef } from './TabBar'
import { TabPanels } from './split/TabPanels'
import { validateAgentPortState } from '@/lib/agent-ports'
import { stableStringify } from '@/lib/stable-stringify'
import { StatusChip } from './StatusChip'
import {
  AGENT_ICON,
  CAP_ICON,
  DEP_ICON,
  MCP_ICON,
  PLUGIN_ICON,
  SKILL_ICON,
} from './icons/resourceIcons'
import type { MultiSelectOption } from './MultiSelect'
import {
  agentResourceIssueLabel,
  agentResourceReferenceLabel,
  type AgentResourceRefKind,
  type AgentResourceStatus,
} from '@/lib/agent-resource-status'

export interface AgentFormProps {
  value: CreateAgent
  onChange: (next: CreateAgent) => void
  /** Existing resource identity; absent on the create route. */
  resourceId?: string
  /** Stable DOM id namespace for the owning route's tabs and panels. */
  idPrefix?: string
  /** When true the name input is read-only (editing an existing agent). */
  nameLocked?: boolean
  /** Optional controlled tab, used by route-level repair links. */
  activeTab?: AgentTab
  onTabChange?: (tab: AgentTab) => void
  /** The owning route renders the compact port summary as its sole live alert. */
  hasExternalPortAlert?: boolean
  /** Existing-agent details reveal dependency mechanics without a discovery click. */
  defaultTechnicalDetailsOpen?: boolean
  /** RFC-201: route-owned raw/parsed/error state for the two Advanced JSON fields. */
  jsonDraft?: AgentJsonDraft
  onJsonDraftChange?: (next: AgentJsonDraft) => void
  /** Route-level validation summary asks the form to reveal and focus this field. */
  focusJsonField?: AgentJsonFieldKey
  onJsonFocusHandled?: () => void
  /** RFC-228: server-authoritative labels and closure integrity. */
  resourceStatus?: AgentResourceStatus
  /** Whether this actor may read the runtime registry used by the selector. */
  runtimeRegistryReadable?: boolean
}

const DEFAULT: CreateAgent = {
  name: '',
  description: '',
  outputs: [],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: '',
}

export function emptyAgent(): CreateAgent {
  return structuredClone(DEFAULT)
}

export type AgentJsonFieldKey = 'permission' | 'frontmatterExtra'

export interface AgentJsonDraft {
  permission: JsonFieldChange<Record<string, unknown>>
  frontmatterExtra: JsonFieldChange<Record<string, unknown>>
}

export function createAgentJsonDraft(value: CreateAgent): AgentJsonDraft {
  return {
    permission: jsonFieldChangeFromValue(value.permission ?? {}),
    frontmatterExtra: jsonFieldChangeFromValue(value.frontmatterExtra ?? {}),
  }
}

/**
 * Adopt a changed parent value only while the corresponding JSON field is
 * valid. Invalid raw text is a newer route draft and must survive a late save
 * receipt or background refetch. Explicit import/reset callers replace the
 * whole AgentJsonDraft instead of using this reconciler.
 */
export function reconcileAgentJsonDraft(
  current: AgentJsonDraft | undefined,
  value: CreateAgent,
): AgentJsonDraft {
  if (current === undefined) return createAgentJsonDraft(value)

  const reconcileField = (
    field: JsonFieldChange<Record<string, unknown>>,
    persisted: Record<string, unknown>,
  ) => {
    if (field.error !== undefined) return field
    return stableStringify(field.parsed) === stableStringify(persisted)
      ? field
      : jsonFieldChangeFromValue(persisted)
  }

  const permission = reconcileField(current.permission, value.permission ?? {})
  const frontmatterExtra = reconcileField(current.frontmatterExtra, value.frontmatterExtra ?? {})
  if (permission === current.permission && frontmatterExtra === current.frontmatterExtra) {
    return current
  }
  return { permission, frontmatterExtra }
}

export function agentJsonInvalidFields(draft: AgentJsonDraft): AgentJsonFieldKey[] {
  const invalid: AgentJsonFieldKey[] = []
  if (draft.permission.error !== undefined || draft.permission.parsed === undefined) {
    invalid.push('permission')
  }
  if (draft.frontmatterExtra.error !== undefined || draft.frontmatterExtra.parsed === undefined) {
    invalid.push('frontmatterExtra')
  }
  return invalid
}

export function agentJsonFieldDomId(idPrefix: string, key: AgentJsonFieldKey): string {
  return `${idPrefix}-json-${key === 'permission' ? 'permission' : 'frontmatter-extra'}`
}

/** RFC-169 — Ports tab badge: declared input + output ports. Pure. */
export function portBadgeCount(v: CreateAgent): number {
  return (v.inputs?.length ?? 0) + (v.outputs?.length ?? 0)
}

/** RFC-169 — Resources & deps tab badge: skills + mcp + plugins + dependsOn. Pure. */
export function resourceRefCount(v: CreateAgent): number {
  return (
    (v.skills?.length ?? 0) +
    (v.mcp?.length ?? 0) +
    (v.plugins?.length ?? 0) +
    (v.dependsOn?.length ?? 0)
  )
}

export function agentExecutionContractKeys(frontmatter: Record<string, unknown>): string[] {
  const declarations = frontmatter.executionContracts
  if (!Array.isArray(declarations)) return []
  const keys: string[] = []
  for (const declaration of declarations) {
    if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
      continue
    }
    const contractId = (declaration as Record<string, unknown>).contractId
    const version = (declaration as Record<string, unknown>).version
    if (
      typeof contractId === 'string' &&
      contractId !== '' &&
      typeof version === 'number' &&
      Number.isInteger(version) &&
      version > 0
    ) {
      keys.push(`${contractId}@${version}`)
    }
  }
  return [...new Set(keys)]
}

export interface AgentExecutionContractTransport {
  outputPort: string
  outputKind: string | null
}

function agentExecutionContractTransports(
  frontmatter: Record<string, unknown>,
): ReadonlyMap<string, AgentExecutionContractTransport> {
  const declarations = frontmatter.executionContracts
  const transports = new Map<string, AgentExecutionContractTransport>()
  if (!Array.isArray(declarations)) return transports
  for (const declaration of declarations) {
    if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
      continue
    }
    const value = declaration as Record<string, unknown>
    if (
      typeof value.contractId !== 'string' ||
      typeof value.version !== 'number' ||
      !Number.isInteger(value.version) ||
      value.version <= 0
    ) {
      continue
    }
    transports.set(`${value.contractId}@${value.version}`, {
      outputPort:
        typeof value.outputPort === 'string' && value.outputPort !== ''
          ? value.outputPort
          : AGENT_EXECUTION_CONTRACT_RESULT_PORT,
      outputKind:
        typeof value.outputKind === 'string' && value.outputKind !== '' ? value.outputKind : null,
    })
  }
  return transports
}

export function agentExecutionContractManagedPorts(frontmatter: Record<string, unknown>): string[] {
  return [
    ...new Set(
      [...agentExecutionContractTransports(frontmatter).values()].map((value) => value.outputPort),
    ),
  ]
}

export function withAgentExecutionContractKeys(
  frontmatter: Record<string, unknown>,
  keys: readonly string[],
  transportsByKey: Readonly<Record<string, AgentExecutionContractTransport>> = {},
): Record<string, unknown> {
  const next = { ...frontmatter }
  const existingTransports = agentExecutionContractTransports(frontmatter)
  const declarations = keys.flatMap((key) => {
    const at = key.lastIndexOf('@')
    const version = Number(key.slice(at + 1))
    return at <= 0 || !Number.isInteger(version) || version <= 0
      ? []
      : (() => {
          const transport = transportsByKey[key] ?? existingTransports.get(key)
          return [
            {
              contractId: key.slice(0, at),
              version,
              ...(transport === undefined ||
              transport.outputPort === AGENT_EXECUTION_CONTRACT_RESULT_PORT
                ? {}
                : { outputPort: transport.outputPort }),
              ...(transport?.outputKind === null || transport?.outputKind === undefined
                ? {}
                : { outputKind: transport.outputKind }),
            },
          ]
        })()
  })
  if (declarations.length === 0) delete next.executionContracts
  else next.executionContracts = declarations
  return next
}

export const AGENT_EXECUTION_CONTRACT_RESULT_PORT = 'agent-result'

/**
 * Contract declarations and their reserved Agent output are one logical value.
 * The picker is the only authoring control: selecting/switching a contract
 * canonicalizes the port, while removing the final contract removes the port
 * and every editable sidecar that could otherwise outlive it.
 */
export function withAgentExecutionContractsAndPorts(
  value: CreateAgent,
  keys: readonly string[],
  transportsByKey: Readonly<Record<string, AgentExecutionContractTransport>> = {},
): CreateAgent {
  const before = agentExecutionContractTransports(value.frontmatterExtra ?? {})
  const frontmatterExtra = withAgentExecutionContractKeys(
    value.frontmatterExtra ?? {},
    keys,
    transportsByKey,
  )
  const after = agentExecutionContractTransports(frontmatterExtra)
  const managedPorts = new Set(
    [...before.values(), ...after.values()].map((transport) => transport.outputPort),
  )
  const ordinaryOutputs = value.outputs.filter((port) => !managedPorts.has(port))
  const contractOutputs = [...new Set([...after.values()].map((value) => value.outputPort))]
  const hadOutputKinds = value.outputKinds !== undefined
  const outputKinds = { ...(value.outputKinds ?? {}) }
  const outputWrapperPortNames =
    value.outputWrapperPortNames === undefined ? undefined : { ...value.outputWrapperPortNames }
  for (const port of managedPorts) {
    delete outputKinds[port]
    delete outputWrapperPortNames?.[port]
  }
  for (const transport of after.values()) {
    if (transport.outputKind !== null) outputKinds[transport.outputPort] = transport.outputKind
  }
  const normalizedOutputKinds =
    hadOutputKinds || [...after.values()].some((transport) => transport.outputKind !== null)
      ? outputKinds
      : undefined
  return {
    ...value,
    frontmatterExtra,
    outputs: [...ordinaryOutputs, ...contractOutputs],
    outputKinds: normalizedOutputKinds,
    outputWrapperPortNames,
    branchPorts: value.branchPorts?.filter((port) => !managedPorts.has(port)),
  }
}

export type AgentTab = 'basics' | 'prompt' | 'ports' | 'resources' | 'advanced'

export function AgentForm({
  value,
  onChange,
  resourceId,
  idPrefix = 'agent-form',
  nameLocked,
  activeTab,
  onTabChange,
  hasExternalPortAlert,
  defaultTechnicalDetailsOpen = false,
  jsonDraft: controlledJsonDraft,
  onJsonDraftChange,
  focusJsonField,
  onJsonFocusHandled,
  resourceStatus,
  runtimeRegistryReadable = true,
}: AgentFormProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [internalTab, setInternalTab] = useState<AgentTab>('basics')
  const [technicalDetailsOpen, setTechnicalDetailsOpen] = useState(defaultTechnicalDetailsOpen)
  const [uncontrolledJsonDraft, setUncontrolledJsonDraft] = useState(() =>
    createAgentJsonDraft(value),
  )
  const permissionJsonRef = useRef<HTMLTextAreaElement | null>(null)
  const frontmatterExtraJsonRef = useRef<HTMLTextAreaElement | null>(null)
  const jsonDraft = controlledJsonDraft ?? uncontrolledJsonDraft
  const tab = activeTab ?? internalTab
  const selectTab = (next: AgentTab) => {
    if (activeTab === undefined) setInternalTab(next)
    onTabChange?.(next)
  }
  useLayoutEffect(() => {
    if (tab !== 'advanced') return
    const target =
      focusJsonField === 'permission'
        ? permissionJsonRef.current
        : focusJsonField === 'frontmatterExtra'
          ? frontmatterExtraJsonRef.current
          : null
    if (target === null) return
    target.focus()
    onJsonFocusHandled?.()
  }, [focusJsonField, onJsonFocusHandled, tab])
  // RFC-113: the runtime selector is the only per-agent profile control here —
  // model / variant / temperature / steps now live on the runtime profile, so
  // AgentForm no longer renders ModelSelect.
  function patch<K extends keyof CreateAgent>(key: K, next: CreateAgent[K]) {
    onChange({ ...value, [key]: next })
  }

  function patchJson(key: AgentJsonFieldKey, next: JsonFieldChange<Record<string, unknown>>) {
    const nextJsonDraft = { ...jsonDraft, [key]: next }
    if (controlledJsonDraft === undefined) setUncontrolledJsonDraft(nextJsonDraft)
    onJsonDraftChange?.(nextJsonDraft)
    if (next.parsed !== undefined) {
      if (key === 'frontmatterExtra') {
        const nextValue = { ...value, frontmatterExtra: next.parsed }
        onChange(
          withAgentExecutionContractsAndPorts(nextValue, agentExecutionContractKeys(next.parsed)),
        )
      } else {
        patch(key, next.parsed)
      }
    }
  }

  // RFC-112: registered runtimes drive the picker options + each runtime's
  // protocol. RFC-305: the registry requires `runtime:read`; a public-resource
  // viewer without that capability sees only the saved pin/inherit value and
  // must not issue the request or consume another account's cached snapshot.
  // flag-audit §8 决策：claude
  // 可用性由注册表派生（存在 enabled 的 claude-protocol 行）——RFC-111 D17 的
  // `claudeCodeEnabled` 配置门已删除，per-runtime `enabled` 是唯一开关。
  const runtimesQuery = useQuery<{
    runtimes: Array<{
      name: string
      protocol: string
      enabled: boolean
      isDefault: boolean
      model: string | null
    }>
  }>({
    queryKey: ['runtimes'],
    queryFn: ({ signal }) => api.get('/api/runtimes', undefined, signal),
    staleTime: 30_000,
    enabled: runtimeRegistryReadable,
  })
  const registeredRuntimes = runtimeRegistryReadable ? (runtimesQuery.data?.runtimes ?? []) : []
  // RFC-118: drop DISABLED runtimes from the picker — EXCEPT the one this agent
  // already pins (keep it visible so editing other fields doesn't silently switch the
  // runtime; the backend allows KEEPING an already-pinned disabled runtime, D6).
  // A disabled claude-protocol runtime is excluded by its own `enabled` flag —
  // the former blanket claude gate is gone.
  const selectableRuntimes = registeredRuntimes.filter((r) => r.enabled || r.name === value.runtime)
  // RFC-250 P1 follow-up: inherit and an explicit pin are different persisted
  // states even when only one runtime is enabled. Keep the field stable instead
  // of making it disappear based on async inventory cardinality. Until the
  // initial inventory resolves, preserve the visible current value but freeze
  // the selector; an unavailable registry cannot safely validate a new pin.
  const runtimeRegistryUnavailable = !runtimeRegistryReadable || runtimesQuery.data === undefined
  const runtimeRegistryLoading =
    runtimeRegistryReadable && runtimeRegistryUnavailable && runtimesQuery.isFetching
  const runtimeRegistryError =
    runtimeRegistryReadable &&
    runtimeRegistryUnavailable &&
    runtimesQuery.isError &&
    !runtimesQuery.isFetching
  const runtimeOptions = [
    { value: '', label: t('agentForm.runtimeInherit') },
    ...selectableRuntimes.map((runtime) => ({ value: runtime.name, label: runtime.name })),
  ]
  if (
    value.runtime !== undefined &&
    !runtimeOptions.some((option) => option.value === value.runtime)
  ) {
    // Loading/error has no registry row yet. Keeping the pin visible avoids a
    // blank trigger; the whole Select remains disabled until a registry arrives.
    runtimeOptions.push({ value: value.runtime, label: value.runtime })
  }

  const portCount = portBadgeCount(value)
  const refCount = resourceRefCount(value)
  const executionContractKeys = agentExecutionContractKeys(value.frontmatterExtra ?? {})
  const resourceIssueCount = resourceStatus?.issues.length ?? 0
  const selectedResourceOptions = (
    kind: AgentResourceRefKind,
    valueOf: (refId: string) => string = (refId) => refId,
  ): MultiSelectOption[] =>
    (resourceStatus?.references ?? [])
      .filter((reference) => reference.kind === kind)
      .map((reference) => ({
        value: valueOf(reference.refId),
        label: agentResourceReferenceLabel(reference, t),
        ...(reference.state === 'unavailable' ? { disabled: true } : {}),
      }))
  const invalidJsonCount = agentJsonInvalidFields(jsonDraft).length
  const portValidation = validateAgentPortState(value)
  const blockingPortCount = portValidation.issues.filter(
    (issue) => issue.severity === 'error',
  ).length
  const tabs: ReadonlyArray<TabDef<AgentTab>> = [
    { key: 'basics', label: t('agentForm.tabBasics'), testid: 'agent-tab-basics' },
    { key: 'prompt', label: t('agentForm.tabPrompt'), testid: 'agent-tab-prompt' },
    {
      key: 'ports',
      label: t('agentForm.tabPorts'),
      testid: 'agent-tab-ports',
      badge: blockingPortCount > 0 ? blockingPortCount : portCount > 0 ? portCount : undefined,
      ...(blockingPortCount > 0
        ? {
            badgeTone: 'danger' as const,
            badgeAriaLabel: t('agentForm.portValidationBadge', { count: blockingPortCount }),
          }
        : { badgeTone: 'neutral' as const }),
      badgeTestid: 'agent-tab-ports-badge',
    },
    {
      key: 'resources',
      label: t('agentForm.tabResources'),
      testid: 'agent-tab-resources',
      badge: resourceIssueCount > 0 ? resourceIssueCount : refCount > 0 ? refCount : undefined,
      ...(resourceIssueCount > 0
        ? {
            badgeTone: 'danger' as const,
            badgeAriaLabel: t('agentForm.resourceValidationBadge', {
              count: resourceIssueCount,
            }),
          }
        : { badgeTone: 'neutral' as const }),
      badgeTestid: 'agent-tab-resources-badge',
    },
    invalidJsonCount > 0
      ? {
          key: 'advanced',
          label: t('agentForm.tabAdvanced'),
          testid: 'agent-tab-advanced',
          badge: invalidJsonCount,
          badgeTone: 'danger',
          badgeAriaLabel: t('agentForm.jsonValidationBadge', { count: invalidJsonCount }),
        }
      : { key: 'advanced', label: t('agentForm.tabAdvanced'), testid: 'agent-tab-advanced' },
  ]

  const basics = (
    <>
      {/* RFC-211 §12: spotlight-tour anchor spans wrap the field so the
          highlight frames the label + input together. */}
      <div data-tour="agent-name">
        <Field label={t('agentForm.fieldName')} required hint={t('agentForm.fieldNameHint')}>
          <TextInput
            value={value.name}
            onChange={(v) => patch('name', v)}
            disabled={nameLocked === true}
            required
            pattern={AGENT_NAME_RE.source}
            placeholder={t('agentForm.fieldNamePlaceholder')}
          />
        </Field>
      </div>

      <Field label={t('agentForm.fieldDescription')}>
        <TextInput
          value={value.description ?? ''}
          onChange={(v) => patch('description', v)}
          placeholder={t('agentForm.fieldDescriptionPlaceholder')}
        />
      </Field>

      {/* RFC-111: per-agent runtime override. Empty = inherit the global
          default. RFC-250: this field is always present, including a single-
          runtime install and initial registry loading/error. */}
      <Field label={t('agentForm.fieldRuntime')} hint={t('agentForm.fieldRuntimeHint')}>
        {/* RFC-112: options are registered runtimes by name, plus the
            inherit-default sentinel. */}
        <Select<string>
          value={value.runtime ?? ''}
          ariaLabel={t('agentForm.fieldRuntime')}
          disabled={runtimeRegistryUnavailable}
          onChange={(v) => patch('runtime', v === '' ? undefined : v)}
          options={runtimeOptions}
        />
        {runtimeRegistryLoading && (
          <LoadingState
            size="compact"
            label={t('agentForm.runtimeLoading')}
            data-testid="agent-runtime-loading"
          />
        )}
      </Field>
      {runtimeRegistryError && (
        <FeedbackStack>
          <ErrorBanner
            error={runtimesQuery.error}
            message={t('agentForm.runtimeLoadFailed')}
            onRetry={() => {
              void runtimesQuery.refetch()
            }}
            testid="agent-runtime-load-error"
          />
        </FeedbackStack>
      )}
    </>
  )

  const prompt = (
    <MarkdownEditor
      value={value.bodyMd ?? ''}
      onChange={(v) => patch('bodyMd', v)}
      placeholder={t('agentForm.bodyPlaceholder')}
      fill
    />
  )

  const ports = (
    <div className="agent-ports">
      <Field
        group
        label={t('agentForm.fieldExecutionContracts')}
        hint={t('agentForm.fieldExecutionContractsHint')}
      >
        <ExecutionContractPicker
          value={executionContractKeys}
          enabled={tab === 'ports'}
          onChange={(keys, transportsByKey) => {
            const nextValue = withAgentExecutionContractsAndPorts(value, keys, transportsByKey)
            const nextJsonDraft = {
              ...jsonDraft,
              frontmatterExtra: jsonFieldChangeFromValue(nextValue.frontmatterExtra ?? {}),
            }
            if (controlledJsonDraft === undefined) setUncontrolledJsonDraft(nextJsonDraft)
            onJsonDraftChange?.(nextJsonDraft)
            onChange(nextValue)
          }}
        />
      </Field>
      {portValidation.issues.length > 0 && (
        <AgentPortValidationSummary
          issues={portValidation.issues}
          variant="detail"
          onNavigate={selectTab}
        />
      )}
      <InputsEditor
        inputs={value.inputs ?? []}
        hasExternalPortAlert={hasExternalPortAlert}
        onChange={(inputs) => onChange({ ...value, inputs })}
      />
      <div data-tour="agent-outputs">
        <OutputsEditor
          outputs={value.outputs ?? []}
          outputKinds={value.outputKinds}
          outputWrapperPortNames={value.outputWrapperPortNames}
          branchPorts={value.branchPorts}
          managedPortNames={
            executionContractKeys.length > 0
              ? agentExecutionContractManagedPorts(value.frontmatterExtra ?? {})
              : undefined
          }
          aggregator={value.role === 'aggregator'}
          hasExternalPortAlert={hasExternalPortAlert}
          onChange={(outputs, outputKinds, outputWrapperPortNames, branchPorts) => {
            const nextValue = {
              ...value,
              outputs,
              outputKinds,
              outputWrapperPortNames,
              branchPorts,
            }
            onChange(withAgentExecutionContractsAndPorts(nextValue, executionContractKeys))
          }}
        />
      </div>
    </div>
  )

  const resources = (
    <>
      {resourceIssueCount > 0 && (
        <FeedbackStack>
          <NoticeBanner
            tone="error"
            size="compact"
            title={t('agentForm.resourceValidationTitle')}
            testid="agent-resource-integrity-error"
          >
            <ul>
              {resourceStatus?.issues.map((issue, index) => (
                <li key={`${issue.code}:${issue.refId ?? 'hidden'}:${index}`}>
                  {agentResourceIssueLabel(issue, t)}
                </li>
              ))}
            </ul>
          </NoticeBanner>
        </FeedbackStack>
      )}
      <p className="agent-resources__intro">{t('agentForm.resourcesIntro')}</p>
      {/* RFC-173: two labelled groups so the two kinds of relationship read
          clearly — "capabilities" (skills/MCP/plugins injected into the agent's
          process) vs "dependencies" (other agents it can delegate to). Each
          Field passes `group` so it renders a <div>, not a <label> (the pickers
          contain buttons — a <label> would bind to the first one). */}
      <section className="resource-group" aria-labelledby="agent-rg-capabilities">
        <header className="resource-group__header">
          <span className="resource-group__icon" aria-hidden="true">
            {CAP_ICON}
          </span>
          <span id="agent-rg-capabilities" className="resource-group__title">
            {t('agentForm.groupCapabilities')}
          </span>
          <span className="resource-group__hint">{t('agentForm.groupCapabilitiesHint')}</span>
        </header>

        <Field
          group
          icon={SKILL_ICON}
          label={t('agentForm.fieldSkills')}
          hint={t('agentForm.fieldSkillsHint')}
        >
          <SkillsPicker
            value={value.skills ?? []}
            onChange={(v) => patch('skills', v)}
            placeholder={t('agentForm.fieldSkillsPlaceholder')}
            selectedOptions={selectedResourceOptions('skill', (refId) => `managed:${refId}`)}
          />
        </Field>

        <Field
          group
          icon={MCP_ICON}
          label={t('agentForm.fieldMcps')}
          hint={t('agentForm.fieldMcpsHint')}
        >
          <McpsPicker
            value={value.mcp ?? []}
            onChange={(v) => patch('mcp', v)}
            placeholder={t('agentForm.fieldMcpsPlaceholder')}
            selectedOptions={selectedResourceOptions('mcp')}
          />
        </Field>

        <Field
          group
          icon={PLUGIN_ICON}
          label={t('agentForm.fieldPlugins')}
          hint={t('agentForm.fieldPluginsHint')}
        >
          <PluginsPicker
            value={value.plugins ?? []}
            onChange={(v) => patch('plugins', v)}
            placeholder={t('agentForm.fieldPluginsPlaceholder')}
            selectedOptions={selectedResourceOptions('plugin')}
          />
        </Field>
      </section>

      <section className="resource-group" aria-labelledby="agent-rg-dependencies">
        <header className="resource-group__header">
          <span className="resource-group__icon" aria-hidden="true">
            {DEP_ICON}
          </span>
          <span id="agent-rg-dependencies" className="resource-group__title">
            {t('agentForm.groupDependencies')}
          </span>
          <span className="resource-group__hint">{t('agentForm.groupDependenciesHint')}</span>
        </header>

        <Field
          group
          icon={AGENT_ICON}
          label={t('agentForm.fieldDependsOn')}
          hint={t('agentForm.fieldDependsOnHint')}
        >
          <AgentDependsPicker
            value={value.dependsOn ?? []}
            onChange={(v) => patch('dependsOn', v)}
            selfId={resourceId}
            placeholder={t('agentForm.fieldDependsOnPlaceholder')}
            selectedOptions={selectedResourceOptions('agent')}
          />
        </Field>

        <DependencyAutodetectButton
          bodyMd={value.bodyMd ?? ''}
          value={value}
          selfId={resourceId}
          onApply={(selection) => onChange(mergeAgentDeps(value, selection))}
        />

        <details
          className="agent-resources__technical"
          open={technicalDetailsOpen}
          onToggle={(event) => setTechnicalDetailsOpen(event.currentTarget.open)}
        >
          <summary>{t('agentForm.technicalDetailsSummary')}</summary>
          <p>{t('agentForm.technicalDetailsBody')}</p>
          {/* The closure preview is useful for debugging, but it is not needed
              to complete the common capability-selection task. */}
          <DependencyTreePreview
            id={resourceId}
            name={value.name}
            dependsOn={value.dependsOn ?? []}
            onNodeClick={(id) => navigate({ to: '/agents/$id', params: { id } })}
          />
        </details>
      </section>
    </>
  )

  const advanced = (
    <>
      <Switch
        checked={value.syncOutputsOnIterate !== false}
        onChange={(v) => patch('syncOutputsOnIterate', v)}
        label={t('agentForm.fieldSyncOutputsOnIterate')}
        hint={t('agentForm.fieldSyncOutputsOnIterateHint')}
      />

      {/* RFC-194: role remains an advanced setting. Aggregator output-name
          promotion is edited transactionally beside each output card. */}
      <Field label={t('agentForm.fieldRole')} hint={t('agentForm.fieldRoleHint')}>
        <Select<'normal' | 'aggregator'>
          value={value.role ?? 'normal'}
          onChange={(v) => patch('role', v === 'normal' ? undefined : v)}
          options={[
            { value: 'normal', label: t('agentForm.roleNormal') },
            { value: 'aggregator', label: t('agentForm.roleAggregator') },
          ]}
          ariaLabel={t('agentForm.fieldRole')}
        />
      </Field>

      {/* RFC-113: model / variant / temperature / steps / maxSteps moved to the
          RUNTIME (Settings → Runtimes). The agent only SELECTS a runtime in
          Basics; the chosen runtime decides the model + generation params. */}

      <Field label={t('agentForm.fieldPermission')} hint={t('agentForm.fieldPermissionHint')}>
        <JsonField
          state={jsonDraft.permission}
          onChange={(next) => patchJson('permission', next)}
          placeholder={t('agentForm.permissionPlaceholder')}
          rows={5}
          id={agentJsonFieldDomId(idPrefix, 'permission')}
          textareaRef={permissionJsonRef}
          data-testid="agent-json-permission"
        />
      </Field>

      <Field
        label={t('agentForm.fieldFrontmatterExtra')}
        hint={t('agentForm.fieldFrontmatterExtraHint')}
      >
        <JsonField
          state={jsonDraft.frontmatterExtra}
          onChange={(next) => patchJson('frontmatterExtra', next)}
          placeholder={t('common.optionalPlaceholder')}
          rows={4}
          id={agentJsonFieldDomId(idPrefix, 'frontmatterExtra')}
          textareaRef={frontmatterExtraJsonRef}
          data-testid="agent-json-frontmatter-extra"
        />
      </Field>
    </>
  )

  return (
    <div className="agent-form">
      <TabBar
        tabs={tabs}
        active={tab}
        onSelect={selectTab}
        ariaLabel={t('agentForm.tabsAria')}
        idPrefix={idPrefix}
      />
      <TabPanels
        active={tab}
        idPrefix={idPrefix}
        className="split__detail-body agent-form__panel"
        panels={[
          { key: 'basics', testid: 'agent-panel-basics', content: basics },
          {
            key: 'prompt',
            testid: 'agent-panel-prompt',
            className: 'agent-form__panel--prompt',
            content: prompt,
          },
          { key: 'ports', testid: 'agent-panel-ports', content: ports },
          { key: 'resources', testid: 'agent-panel-resources', content: resources },
          { key: 'advanced', testid: 'agent-panel-advanced', content: advanced },
        ]}
      />
    </div>
  )
}

export interface AgentJsonValidationSummaryProps {
  draft: AgentJsonDraft
  onNavigate: (key: AgentJsonFieldKey) => void
}

/** Route-level live summary; inline field errors stay associated but non-live. */
export function AgentJsonValidationSummary({ draft, onNavigate }: AgentJsonValidationSummaryProps) {
  const { t } = useTranslation()
  const headingId = useId()
  const invalid = agentJsonInvalidFields(draft)
  if (invalid.length === 0) return null

  return (
    <section
      className="agent-port-validation agent-port-validation--compact"
      role="alert"
      aria-labelledby={headingId}
      data-testid="agent-json-validation"
    >
      <h3 id={headingId} className="agent-port-validation__title">
        {t('agentForm.jsonValidationTitle', { count: invalid.length })}
      </h3>
      <ul className="agent-port-validation__list">
        {invalid.map((key) => {
          const label = t(
            key === 'permission' ? 'agentForm.fieldPermission' : 'agentForm.fieldFrontmatterExtra',
          )
          const message = draft[key].error ?? t('agentForm.jsonSyntaxError')
          return (
            <li
              key={key}
              className="agent-port-validation__item agent-port-validation__item--error"
            >
              <StatusChip kind="danger" size="sm">
                {t('agentForm.jsonErrorStatus')}
              </StatusChip>
              <span className="agent-port-validation__message">{message}</span>
              <button
                type="button"
                className="btn btn--xs agent-port-validation__navigate"
                onClick={() => onNavigate(key)}
                aria-label={t('agentForm.jsonFixField', { field: label })}
              >
                {t('agentForm.jsonFixField', { field: label })}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

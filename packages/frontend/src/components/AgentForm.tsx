// Shared frontmatter + body form for /agents/new and /agents/$name.
// Lifts the entire CreateAgent payload to local state; submission is the
// parent's concern.
//
// RFC-169 (T7) — the six stacked FormSections (RFC-155) became five right-rail
// tabs: Basics / Prompt / Ports / Resources & deps / Advanced. The RFC-155
// "collapse + rising-edge auto-open" affordance is retired; its "there's
// content here" hint is carried by the Ports/Resources tab count badges
// (portBadgeCount / resourceRefCount, pure + unit-tested). Panels are
// keep-mounted (hidden, not unmounted) so a half-typed JsonField in Advanced
// survives tab switches.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { CreateAgent } from '@agent-workflow/shared'
import { AGENT_NAME_RE } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { hasEnabledClaudeRuntime } from '@/hooks/useRuntimesList'
import { AgentDependsPicker } from './AgentDependsPicker'
import { DependencyAutodetectButton } from './agents/DependencyAutodetectButton'
import { DependencyTreePreview } from './agents/DependencyTreePreview'
import { mergeAgentDeps } from '@/lib/agent-dep-detect'
import { Field, Switch, TextInput } from './Form'
import { JsonField } from './JsonField'
import { MarkdownEditor } from './MarkdownEditor'
import { McpsPicker } from './McpsPicker'
import { PluginsPicker } from './PluginsPicker'
import { InputsEditor } from './InputsEditor'
import { OutputsEditor } from './OutputsEditor'
import { Select } from './Select'
import { SkillsPicker } from './SkillsPicker'
import { TabBar, type TabDef } from './TabBar'
import { TabPanels } from './split/TabPanels'
import {
  AGENT_ICON,
  CAP_ICON,
  DEP_ICON,
  MCP_ICON,
  PLUGIN_ICON,
  SKILL_ICON,
} from './icons/resourceIcons'

export interface AgentFormProps {
  value: CreateAgent
  onChange: (next: CreateAgent) => void
  /** When true the name input is read-only (editing an existing agent). */
  nameLocked?: boolean
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

type AgentTab = 'basics' | 'prompt' | 'ports' | 'resources' | 'advanced'

export function AgentForm({ value, onChange, nameLocked }: AgentFormProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [tab, setTab] = useState<AgentTab>('basics')
  // RFC-113: the runtime selector is the only per-agent profile control here —
  // model / variant / temperature / steps now live on the runtime profile, so
  // AgentForm no longer renders ModelSelect.
  function patch<K extends keyof CreateAgent>(key: K, next: CreateAgent[K]) {
    onChange({ ...value, [key]: next })
  }

  // RFC-112: registered runtimes (GET /api/runtimes — open to all users) drive
  // the picker options + each runtime's protocol. flag-audit §8 决策：claude
  // 可用性由注册表派生（存在 enabled 的 claude-protocol 行）——RFC-111 D17 的
  // `claudeCodeEnabled` 配置门已删除，per-runtime `enabled` 是唯一开关。
  const runtimesQuery = useQuery<{
    runtimes: Array<{ name: string; protocol: string; enabled: boolean }>
  }>({
    queryKey: ['runtimes'],
    queryFn: ({ signal }) => api.get('/api/runtimes', undefined, signal),
    staleTime: 30_000,
  })
  const registeredRuntimes = runtimesQuery.data?.runtimes ?? []
  const claudeEnabled = hasEnabledClaudeRuntime(registeredRuntimes)
  // RFC-118: drop DISABLED runtimes from the picker — EXCEPT the one this agent
  // already pins (keep it visible so editing other fields doesn't silently switch the
  // runtime; the backend allows KEEPING an already-pinned disabled runtime, D6).
  // A disabled claude-protocol runtime is excluded by its own `enabled` flag —
  // the former blanket claude gate is gone.
  const selectableRuntimes = registeredRuntimes.filter((r) => r.enabled || r.name === value.runtime)
  // RFC-113: the runtime selector is the ONLY per-agent profile control, so show it
  // whenever there's a real choice — claude available, the agent already pins a
  // runtime, or custom (non-built-in) opencode profiles exist (e.g. opencode-opus /
  // opencode-haiku on a claude-disabled install). Only a single built-in opencode
  // and claude off ⇒ nothing to choose ⇒ hide.
  const showRuntime = claudeEnabled || value.runtime != null || selectableRuntimes.length > 1

  const portCount = portBadgeCount(value)
  const refCount = resourceRefCount(value)
  const tabs: ReadonlyArray<TabDef<AgentTab>> = [
    { key: 'basics', label: t('agentForm.tabBasics'), testid: 'agent-tab-basics' },
    { key: 'prompt', label: t('agentForm.tabPrompt'), testid: 'agent-tab-prompt' },
    {
      key: 'ports',
      label: t('agentForm.tabPorts'),
      testid: 'agent-tab-ports',
      badge: portCount > 0 ? portCount : undefined,
      badgeTestid: 'agent-tab-ports-badge',
    },
    {
      key: 'resources',
      label: t('agentForm.tabResources'),
      testid: 'agent-tab-resources',
      badge: refCount > 0 ? refCount : undefined,
      badgeTestid: 'agent-tab-resources-badge',
    },
    { key: 'advanced', label: t('agentForm.tabAdvanced'), testid: 'agent-tab-advanced' },
  ]

  const basics = (
    <>
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

      <Field label={t('agentForm.fieldDescription')}>
        <TextInput
          value={value.description ?? ''}
          onChange={(v) => patch('description', v)}
          placeholder={t('agentForm.fieldDescriptionPlaceholder')}
        />
      </Field>

      {/* RFC-111: per-agent runtime override. Empty = inherit the global
          default. Hidden only when claude is explicitly disabled in config
          (and the agent doesn't already pin a runtime). */}
      {showRuntime && (
        <Field label={t('agentForm.fieldRuntime')} hint={t('agentForm.fieldRuntimeHint')}>
          {/* RFC-112: options are the registered runtimes (built-ins + custom
              forks) by name, plus the inherit-default sentinel. */}
          <Select<string>
            value={value.runtime ?? ''}
            ariaLabel={t('agentForm.fieldRuntime')}
            onChange={(v) => patch('runtime', v === '' ? undefined : v)}
            options={[
              { value: '', label: t('agentForm.runtimeInherit') },
              // Loaded registry wins; while it's empty (query in flight) fall back
              // to the built-in name(s) — both when claude is on, opencode-only
              // when it's off (mirrors the claude-protocol filter above).
              ...(selectableRuntimes.length > 0
                ? selectableRuntimes.map((r) => ({ value: r.name, label: r.name }))
                : claudeEnabled
                  ? [
                      { value: 'opencode', label: t('agentForm.runtimeOpencode') },
                      { value: 'claude-code', label: t('agentForm.runtimeClaudeCode') },
                    ]
                  : [{ value: 'opencode', label: t('agentForm.runtimeOpencode') }]),
            ]}
          />
        </Field>
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
    <>
      <Field label={t('agentForm.fieldInputs')} hint={t('agentForm.fieldInputsHint')}>
        <InputsEditor
          inputs={value.inputs ?? []}
          onChange={(inputs) => onChange({ ...value, inputs })}
          placeholder={t('agentForm.fieldInputsPlaceholder')}
        />
      </Field>
      <Field label={t('agentForm.fieldOutputs')} hint={t('agentForm.fieldOutputsHint')}>
        <OutputsEditor
          outputs={value.outputs ?? []}
          outputKinds={value.outputKinds}
          onChange={(outputs, outputKinds) => onChange({ ...value, outputs, outputKinds })}
          placeholder={t('agentForm.fieldOutputsPlaceholder')}
        />
      </Field>
    </>
  )

  const resources = (
    <>
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
            selfName={value.name}
            placeholder={t('agentForm.fieldDependsOnPlaceholder')}
          />
        </Field>

        <DependencyAutodetectButton
          bodyMd={value.bodyMd ?? ''}
          value={value}
          selfName={value.name}
          onApply={(selection) => onChange(mergeAgentDeps(value, selection))}
        />

        {/* RFC-169: the dependency-tree preview joins the resources tab (its own
            RFC-155 section is retired). Clicking a node navigates to that agent —
            the split page's unsaved guard intercepts a dirty draft, as intended. */}
        <DependencyTreePreview
          name={value.name}
          dependsOn={value.dependsOn ?? []}
          onNodeClick={(n) => navigate({ to: '/agents/$name', params: { name: n } })}
        />
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

      {/* RFC-060 PR-B — agent role + outputWrapperPortNames. The map editor
          is JSON-shaped for now; PR-F upgrades OutputsEditor with per-port
          rename inputs. */}
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

      {value.role === 'aggregator' ? (
        <Field
          label={t('agentForm.fieldOutputWrapperPortNames')}
          hint={t('agentForm.fieldOutputWrapperPortNamesHint')}
        >
          <JsonField
            value={value.outputWrapperPortNames ?? {}}
            onChange={(v) => {
              if (typeof v !== 'object' || v === null || Array.isArray(v)) return
              patch('outputWrapperPortNames', v as Record<string, string>)
            }}
            placeholder={'{"report":"final"}'}
            rows={3}
          />
        </Field>
      ) : null}

      {/* RFC-113: model / variant / temperature / steps / maxSteps moved to the
          RUNTIME (Settings → Runtimes). The agent only SELECTS a runtime in
          Basics; the chosen runtime decides the model + generation params. */}

      <Field label={t('agentForm.fieldPermission')} hint={t('agentForm.fieldPermissionHint')}>
        <JsonField
          value={value.permission ?? {}}
          onChange={(v) => patch('permission', v)}
          placeholder={t('agentForm.permissionPlaceholder')}
          rows={5}
        />
      </Field>

      <Field
        label={t('agentForm.fieldFrontmatterExtra')}
        hint={t('agentForm.fieldFrontmatterExtraHint')}
      >
        <JsonField
          value={value.frontmatterExtra ?? {}}
          onChange={(v) => patch('frontmatterExtra', v)}
          placeholder={t('common.optionalPlaceholder')}
          rows={4}
        />
      </Field>
    </>
  )

  return (
    <div className="agent-form">
      <TabBar tabs={tabs} active={tab} onSelect={setTab} ariaLabel={t('agentForm.tabsAria')} />
      <TabPanels
        active={tab}
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

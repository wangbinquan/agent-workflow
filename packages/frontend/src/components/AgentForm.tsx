// Shared frontmatter + body form for /agents/new and /agents/$name.
// Lifts the entire CreateAgent payload to local state; submission is the
// parent's concern.

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
import { Field, Switch, TextArea, TextInput } from './Form'
import { JsonField } from './JsonField'
import { MarkdownEditor } from './MarkdownEditor'
import { McpsPicker } from './McpsPicker'
import { PluginsPicker } from './PluginsPicker'
import { OutputsEditor } from './OutputsEditor'
import { Select } from './Select'
import { SkillsPicker } from './SkillsPicker'

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

export function AgentForm({ value, onChange, nameLocked }: AgentFormProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
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

  return (
    <div className="agent-form">
      <div className="form-grid">
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

        <Field label={t('agentForm.fieldOutputs')} hint={t('agentForm.fieldOutputsHint')}>
          <OutputsEditor
            outputs={value.outputs ?? []}
            outputKinds={value.outputKinds}
            onChange={(outputs, outputKinds) => onChange({ ...value, outputs, outputKinds })}
            placeholder={t('agentForm.fieldOutputsPlaceholder')}
          />
        </Field>

        <Field label={t('agentForm.fieldSkills')} hint={t('agentForm.fieldSkillsHint')}>
          <SkillsPicker
            value={value.skills ?? []}
            onChange={(v) => patch('skills', v)}
            placeholder={t('agentForm.fieldSkillsPlaceholder')}
          />
        </Field>

        <Field label={t('agentForm.fieldMcps')} hint={t('agentForm.fieldMcpsHint')}>
          <McpsPicker
            value={value.mcp ?? []}
            onChange={(v) => patch('mcp', v)}
            placeholder={t('agentForm.fieldMcpsPlaceholder')}
          />
        </Field>

        <Field label={t('agentForm.fieldPlugins')} hint={t('agentForm.fieldPluginsHint')}>
          <PluginsPicker
            value={value.plugins ?? []}
            onChange={(v) => patch('plugins', v)}
            placeholder={t('agentForm.fieldPluginsPlaceholder')}
          />
        </Field>

        <Field label={t('agentForm.fieldDependsOn')} hint={t('agentForm.fieldDependsOnHint')}>
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

        <Field label={t('agentForm.fieldDependencyTree')}>
          <DependencyTreePreview
            name={value.name}
            dependsOn={value.dependsOn ?? []}
            onNodeClick={(n) => navigate({ to: '/agents/$name', params: { name: n } })}
          />
        </Field>

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

        {/* RFC-113: model / variant / temperature / steps / maxSteps moved to the
            RUNTIME (Settings → Runtimes). The agent only SELECTS a runtime above;
            the chosen runtime decides the model + generation params. */}

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

        <Field label={t('agentForm.fieldBody')}>
          <MarkdownEditor
            value={value.bodyMd ?? ''}
            onChange={(v) => patch('bodyMd', v)}
            placeholder={t('agentForm.bodyPlaceholder')}
          />
        </Field>

        {/* Quick raw-body fallback for users who don't want preview. */}
        <details className="form-details">
          <summary>{t('agentForm.rawBodySummary')}</summary>
          <TextArea
            value={value.bodyMd ?? ''}
            onChange={(v) => patch('bodyMd', v)}
            rows={6}
            monospace
          />
        </details>
      </div>
    </div>
  )
}

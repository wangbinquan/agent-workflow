// RFC-307 — the `/code` Flow tab: see a capability's sequence, and change it.
//
// The gap this closes is not that the configuration was missing. RFC-304 built
// all of it: `agentSlot` picks the agent, `promptBySlot` the prompt,
// `scriptSlot` the script, `paramSchema` the thresholds, and a hook may mount
// at every stage boundary. What was missing is that all of it was entered into
// JSON forms with NO CONNECTION TO POSITION. A user reading
// `agentBySlot: {"reviewer": "..."}` had no way to know which of thirteen steps
// `reviewer` is, or what else changes when they change it.
//
// So the flow IS the configuration surface: click the step you mean, and edit
// what that step actually uses. The two-layer split survives intact —
//
//   binding (group layer)     agent, prompt, params  → capability-bindings:update
//   framework (dept layer)    scripts, hooks         → + scripts:author
//
// — because they are different permissions over different blast radii, and
// merging them in the UI would be the first step toward merging them for real.
//
// Structure is NOT editable here (adding, removing or rewiring steps). That is
// RFC-304's D3, and the reason survives contact with this surface: five of the
// stages read and write state that outlives the round (the fingerprint ledger,
// the two-phase publish intent), and their invariants are guarantees the
// platform makes, not properties of how someone drew a line.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CapabilityBindingWire, CapabilityFrameworkWire } from '@agent-workflow/shared'

import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea, TextInput } from '@/components/Form'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { LoadingState } from '@/components/LoadingState'
import { StatusChip } from '@/components/StatusChip'
import { usePermission } from '@/hooks/useActor'
import { CapabilityFlow, type CapabilityGraphNode } from './CapabilityFlow'
import { readGraph, type CapabilityGraphResponse } from './graphResponse'

interface AgentRow {
  id: string
  name: string
}

const SCRIPT_LANGUAGES = ['bash', 'python', 'node'] as const
type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number]

/**
 * `active` exists because RFC-169 keeps inactive tab panels MOUNTED (so their
 * local state survives a tab switch). Without gating, opening `/code` on any
 * tab would fire this panel's four queries — and the flow is the one panel
 * whose data nobody has asked for until they ask for it.
 */
export function CapabilityFlowPanel({ active = true }: { active?: boolean }): React.ReactElement {
  const { t } = useTranslation()
  const [capability, setCapability] = useState('mr-review')
  const [bindingId, setBindingId] = useState<string | null>(null)
  const [openStage, setOpenStage] = useState<string | null>(null)

  const catalog = useQuery({
    queryKey: ['code-capabilities'],
    queryFn: () =>
      api.get<{ items: { capability: string; agentSlots: string[] }[] }>('/api/code/capabilities'),
    enabled: active,
  })
  const graph = useQuery({
    queryKey: ['code-capability-graph', capability],
    queryFn: () =>
      api.get<CapabilityGraphResponse>(
        `/api/code/capabilities/${encodeURIComponent(capability)}/graph`,
      ),
    enabled: active,
    // Compiled into the binary — it cannot change under a running daemon.
    staleTime: Infinity,
  })
  const bindings = useQuery({
    queryKey: ['capability-bindings'],
    queryFn: () => api.get<CapabilityBindingWire[]>('/api/capability-bindings'),
    enabled: active,
  })
  const frameworks = useQuery({
    queryKey: ['capability-frameworks'],
    queryFn: () => api.get<CapabilityFrameworkWire[]>('/api/capability-frameworks'),
    enabled: active,
  })

  // Bindings whose framework serves this capability. A binding for `ci-fix`
  // cannot fill an `mr-review` slot, and offering it would produce a saved
  // configuration that silently never applies.
  const candidates = useMemo(() => {
    const forCapability = new Set(
      (frameworks.data ?? []).filter((f) => f.capability === capability).map((f) => f.id),
    )
    return (bindings.data ?? []).filter((b) => forCapability.has(b.frameworkId))
  }, [bindings.data, frameworks.data, capability])

  // Keyed on the candidate IDS, not the array. `candidates` is rebuilt whenever
  // either query returns — including a background refetch that changed nothing
  // — so depending on its identity re-ran this effect at arbitrary moments. The
  // first version also cleared `openStage` here, which meant the drawer the
  // user had just opened closed itself the instant the second query resolved,
  // and any later refetch would close it mid-edit.
  const candidateKey = candidates.map((b) => b.id).join(',')
  useEffect(() => {
    // `''.split(',')` is `['']`, not `[]` — without this guard an empty
    // candidate list would select the empty string rather than nothing.
    const ids = candidateKey === '' ? [] : candidateKey.split(',')
    setBindingId((current) =>
      current !== null && ids.includes(current) ? current : (ids[0] ?? null),
    )
  }, [candidateKey])

  // Closing the drawer belongs to the CAPABILITY changing, which is the only
  // event that makes the open stage meaningless — its stages are gone.
  useEffect(() => {
    setOpenStage(null)
  }, [capability])

  const binding = candidates.find((b) => b.id === bindingId) ?? null
  const framework = (frameworks.data ?? []).find((f) => f.id === binding?.frameworkId) ?? null

  if (!active) return <></>
  if (catalog.isPending || graph.isPending) return <LoadingState />
  if (graph.isError) return <ErrorBanner error={graph.error} onRetry={() => void graph.refetch()} />

  const answer = readGraph(graph.data)
  const stages = answer.kind === 'graph' ? answer.nodes : []
  const graphEdges = answer.kind === 'graph' ? answer.edges : []
  const stage = stages.find((s) => s.name === openStage) ?? null

  // Every stage filled by the same slot as the open one. Without this a user
  // changes `reviewer` believing they changed one step of thirteen.
  const siblings =
    stage === null
      ? []
      : stages
          .filter(
            (s) =>
              s.name !== stage.name &&
              ((stage.agentSlot !== undefined && s.agentSlot === stage.agentSlot) ||
                (stage.scriptSlot !== undefined && s.scriptSlot === stage.scriptSlot)),
          )
          .map((s) => s.name)

  return (
    <section className="page__section" data-testid="code-flow-panel">
      <Segmented
        ariaLabel={t('code.flow.capability')}
        value={capability}
        onChange={setCapability}
        options={(catalog.data?.items ?? []).map((item) => ({
          value: item.capability,
          label: item.capability,
        }))}
        testidPrefix="code-flow-capability"
      />

      {answer.kind !== 'graph' ? (
        // A real answer, not an error: `mr-monitor` is the standing monitor
        // loop. Drawing an empty canvas would say "nothing happens here".
        <EmptyState
          title={t('capabilityFlow.noContract')}
          description={t('capabilityFlow.noContractHint')}
        />
      ) : (
        <>
          <div className="page__header--row">
            <Field label={t('code.flow.binding')} hint={t('code.flow.bindingHint')}>
              <Select
                value={bindingId ?? ''}
                onChange={(next) => {
                  setBindingId(next === '' ? null : next)
                }}
                ariaLabel={t('code.flow.binding')}
                data-testid="code-flow-binding"
                options={[
                  { value: '', label: t('code.flow.bindingNone') },
                  ...candidates.map((b) => ({ value: b.id, label: b.name })),
                ]}
              />
            </Field>
            {framework !== null && (
              <StatusChip kind="info" size="sm">
                {framework.name}
              </StatusChip>
            )}
          </div>

          <p>{t('code.flow.hint')}</p>

          <CapabilityFlow
            nodes={stages}
            edges={graphEdges}
            selected={openStage}
            siblings={siblings}
            onPick={(picked) => {
              setOpenStage(picked.name)
            }}
            height={520}
          />

          {stage !== null && (
            <StageDrawer
              stage={stage}
              siblings={siblings}
              binding={binding}
              framework={framework}
              onClose={() => {
                setOpenStage(null)
              }}
            />
          )}
        </>
      )}
    </section>
  )
}

/**
 * One stage's configuration — everything about it that a person may change.
 *
 * The sections shown are decided by the stage's own kind, so the drawer never
 * offers a control that would not apply: an agent picker on a program stage
 * would be a promise the engine cannot keep.
 */
function StageDrawer({
  stage,
  siblings,
  binding,
  framework,
  onClose,
}: {
  stage: CapabilityGraphNode
  siblings: readonly string[]
  binding: CapabilityBindingWire | null
  framework: CapabilityFrameworkWire | null
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canEditBinding = usePermission('capability-bindings:update')
  const canEditFramework = usePermission('capability-frameworks:update')
  const canAuthorScripts = usePermission('scripts:author')

  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<AgentRow[]>('/api/agents'),
    enabled: stage.kind === 'ai',
  })

  const [agentId, setAgentId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [scriptBody, setScriptBody] = useState('')
  const [scriptLanguage, setScriptLanguage] = useState<ScriptLanguage>('bash')
  const [params, setParams] = useState<Record<string, string>>({})

  // Reload the drafts whenever the stage or the template behind it changes.
  // Without this, opening a second stage would show the first one's text and a
  // save would write it to the wrong slot.
  useEffect(() => {
    setAgentId(stage.agentSlot !== undefined ? (binding?.agentBySlot[stage.agentSlot] ?? '') : '')
    setPrompt(stage.agentSlot !== undefined ? (binding?.promptBySlot[stage.agentSlot] ?? '') : '')
    const script =
      stage.scriptSlot !== undefined
        ? (
            framework?.scripts as Record<string, { language: string; script: string }> | undefined
          )?.[stage.scriptSlot]
        : undefined
    setScriptBody(script?.script ?? '')
    setScriptLanguage(
      script?.language === 'python' || script?.language === 'node' ? script.language : 'bash',
    )
    setParams(
      Object.fromEntries(
        (framework?.paramSchema ?? []).map((p) => [
          p.name,
          String(binding?.params[p.name] ?? framework?.paramDefaults[p.name] ?? ''),
        ]),
      ),
    )
  }, [stage, binding, framework])

  const saveBinding = useMutation({
    mutationFn: (next: Partial<CapabilityBindingWire>) => {
      if (binding === null) throw new Error('no binding selected')
      return api.put<CapabilityBindingWire>(`/api/capability-bindings/${binding.id}`, {
        name: binding.name,
        description: binding.description,
        frameworkId: binding.frameworkId,
        agentBySlot: binding.agentBySlot,
        promptBySlot: binding.promptBySlot,
        params: binding.params,
        ...next,
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['capability-bindings'] }),
  })

  const saveFramework = useMutation({
    mutationFn: (next: Partial<CapabilityFrameworkWire>) => {
      if (framework === null) throw new Error('no framework selected')
      return api.put<CapabilityFrameworkWire>(`/api/capability-frameworks/${framework.id}`, {
        name: framework.name,
        description: framework.description,
        capability: framework.capability,
        scripts: framework.scripts ?? {},
        hooks: framework.hooks ?? [],
        paramSchema: framework.paramSchema,
        paramDefaults: framework.paramDefaults,
        stageContractVer: framework.stageContractVer,
        ...next,
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['capability-frameworks'] }),
  })

  const hooksHere = (framework?.hooks ?? []).filter((h) => h.stage === stage.name)

  return (
    <Dialog
      open
      onClose={onClose}
      title={stage.name}
      footer={
        <button type="button" className="btn btn--sm" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <div className="page__section">
        <StatusChip kind="info" size="sm">
          {t(`capabilityFlow.kind.${stage.kind}`)}
        </StatusChip>
        {stage.parallel && (
          <StatusChip kind="neutral" size="sm">
            {t('capabilityFlow.parallel')}
          </StatusChip>
        )}
      </div>

      {/* What the step consumes and publishes. Named rather than drawn-only,
          because "why does this step need that" is answered by the artifact. */}
      <p data-testid={`stage-io-${stage.name}`}>
        <strong>{t('capabilityFlow.requires')}:</strong>{' '}
        {stage.requires.length > 0 ? stage.requires.join(', ') : '—'}
        {' · '}
        <strong>{t('capabilityFlow.produces')}:</strong>{' '}
        {stage.produces.length > 0 ? stage.produces.join(', ') : '—'}
      </p>
      {stage.terminal.length > 0 && (
        <p data-testid={`stage-terminal-${stage.name}`}>{t('capabilityFlow.terminal')}</p>
      )}

      {siblings.length > 0 && (
        // The warning that makes slot-shaped configuration honest.
        <p className="page__section" data-testid={`stage-siblings-${stage.name}`}>
          {t('code.flow.sharedSlot', { count: siblings.length, stages: siblings.join(', ') })}
        </p>
      )}

      {stage.kind === 'ai' && stage.agentSlot !== undefined && (
        <div className="page__section form-grid" data-testid={`stage-ai-${stage.name}`}>
          <Field
            label={t('code.flow.agent')}
            hint={t('capabilityFlow.agentSlot', {
              slot: stage.agentSlot,
            })}
          >
            <Select
              value={agentId}
              onChange={setAgentId}
              disabled={binding === null || !canEditBinding}
              ariaLabel={t('code.flow.agent')}
              data-testid={`stage-agent-${stage.name}`}
              options={[
                { value: '', label: t('code.flow.agentNone') },
                ...(agents.data ?? []).map((a) => ({ value: a.id, label: a.name })),
              ]}
            />
          </Field>
          <Field label={t('code.flow.prompt')}>
            <TextArea
              value={prompt}
              onChange={setPrompt}
              monospace
              rows={6}
              disabled={binding === null || !canEditBinding}
              data-testid={`stage-prompt-${stage.name}`}
            />
          </Field>
          <div className="page__actions">
            <button
              type="button"
              className="btn btn--sm btn--primary"
              data-testid={`stage-save-binding-${stage.name}`}
              disabled={binding === null || !canEditBinding || saveBinding.isPending}
              onClick={() => {
                if (stage.agentSlot === undefined || binding === null) return
                saveBinding.mutate({
                  agentBySlot: { ...binding.agentBySlot, [stage.agentSlot]: agentId },
                  promptBySlot: { ...binding.promptBySlot, [stage.agentSlot]: prompt },
                })
              }}
            >
              {t('common.save')}
            </button>
          </div>
          {saveBinding.isError && <ErrorBanner error={saveBinding.error} />}
        </div>
      )}

      {stage.kind === 'script' && stage.scriptSlot !== undefined && (
        <div className="page__section form-grid" data-testid={`stage-script-${stage.name}`}>
          {framework?.scriptsRedacted === true ? (
            // Absent, not empty — an empty editor would invite someone to save
            // over a script they were never shown.
            <p data-testid={`stage-script-redacted-${stage.name}`}>
              {t('code.flow.scriptRedacted')}
            </p>
          ) : (
            <>
              <Field label={t('code.flow.scriptLanguage')}>
                <Select
                  value={scriptLanguage}
                  onChange={(next) => {
                    setScriptLanguage(next as ScriptLanguage)
                  }}
                  disabled={framework === null || !canEditFramework || !canAuthorScripts}
                  ariaLabel={t('code.flow.scriptLanguage')}
                  data-testid={`stage-script-language-${stage.name}`}
                  options={SCRIPT_LANGUAGES.map((l) => ({ value: l, label: l }))}
                />
              </Field>
              <Field
                label={t('code.flow.script')}
                hint={t('capabilityFlow.scriptSlot', { slot: stage.scriptSlot })}
              >
                <TextArea
                  value={scriptBody}
                  onChange={setScriptBody}
                  monospace
                  rows={12}
                  disabled={framework === null || !canEditFramework || !canAuthorScripts}
                  data-testid={`stage-script-body-${stage.name}`}
                />
              </Field>
              <div className="page__actions">
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  data-testid={`stage-save-script-${stage.name}`}
                  disabled={
                    framework === null ||
                    !canEditFramework ||
                    !canAuthorScripts ||
                    saveFramework.isPending
                  }
                  onClick={() => {
                    if (stage.scriptSlot === undefined || framework === null) return
                    saveFramework.mutate({
                      scripts: {
                        ...(framework.scripts ?? {}),
                        [stage.scriptSlot]: { language: scriptLanguage, script: scriptBody },
                      } as CapabilityFrameworkWire['scripts'],
                    })
                  }}
                >
                  {t('common.save')}
                </button>
              </div>
              {saveFramework.isError && <ErrorBanner error={saveFramework.error} />}
            </>
          )}
        </div>
      )}

      {stage.kind === 'invoke' && stage.invokes !== undefined && (
        <p data-testid={`stage-invoke-${stage.name}`}>
          {t('capabilityFlow.invokes', { capability: stage.invokes.capability })}
          {stage.invokes.stages.length > 0 && ` — ${stage.invokes.stages.join(' → ')}`}
        </p>
      )}

      {/* Params belong to the framework's declared table and are overridden per
            binding, so they appear on every stage rather than being guessed at
            per-kind: the contract does not say which stage reads which param. */}
      {(framework?.paramSchema.length ?? 0) > 0 && (
        <div className="page__section form-grid" data-testid={`stage-params-${stage.name}`}>
          <h4>{t('code.flow.params')}</h4>
          {framework?.paramSchema.map((param) => (
            <Field key={param.name} label={param.name} hint={param.kind}>
              <TextInput
                value={params[param.name] ?? ''}
                onChange={(next) => {
                  setParams((prev) => ({ ...prev, [param.name]: next }))
                }}
                disabled={binding === null || !canEditBinding}
                data-testid={`stage-param-${param.name}`}
              />
            </Field>
          ))}
          <div className="page__actions">
            <button
              type="button"
              className="btn btn--sm"
              data-testid={`stage-save-params-${stage.name}`}
              disabled={binding === null || !canEditBinding || saveBinding.isPending}
              onClick={() => {
                saveBinding.mutate({ params: coerceParams(params, framework?.paramSchema ?? []) })
              }}
            >
              {t('code.flow.saveParams')}
            </button>
          </div>
        </div>
      )}

      <StageHooks
        stage={stage}
        framework={framework}
        hooks={hooksHere}
        canEdit={canEditFramework && canAuthorScripts}
        onSave={(hooks) => {
          saveFramework.mutate({ hooks })
        }}
        pending={saveFramework.isPending}
      />
    </Dialog>
  )
}

/**
 * Hooks at this stage's two boundaries.
 *
 * The `injectable` allowlist is rendered as a plain statement, and that is the
 * point of showing it here at all: the contract already decides what a hook may
 * hand back, and until now the only way to find out was to write one and have
 * it rejected. An empty allowlist is a real answer — the hook may read or write
 * the worktree and may abort — not an absence of information.
 */
function StageHooks({
  stage,
  framework,
  hooks,
  canEdit,
  onSave,
  pending,
}: {
  stage: CapabilityGraphNode
  framework: CapabilityFrameworkWire | null
  hooks: NonNullable<CapabilityFrameworkWire['hooks']>
  canEdit: boolean
  onSave: (hooks: NonNullable<CapabilityFrameworkWire['hooks']>) => void
  pending: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<'pre' | 'post'>('pre')
  const [body, setBody] = useState('')
  const [language, setLanguage] = useState<ScriptLanguage>('bash')

  return (
    <div className="page__section form-grid" data-testid={`stage-hooks-${stage.name}`}>
      <h4>{t('code.flow.hooks')}</h4>
      <p data-testid={`stage-injectable-${stage.name}`}>
        {stage.injectable.length > 0
          ? t('capabilityFlow.injectable', { keys: stage.injectable.join(', ') })
          : t('capabilityFlow.injectableNone')}
      </p>

      {hooks.length === 0 ? (
        <p>{t('code.flow.noHooks')}</p>
      ) : (
        <ul data-testid={`stage-hook-list-${stage.name}`}>
          {hooks.map((hook, index) => (
            <li key={`${hook.phase}-${String(index)}`}>
              <StatusChip kind="neutral" size="sm">
                {hook.phase}
              </StatusChip>{' '}
              {hook.language}
              {canEdit && (
                <button
                  type="button"
                  className="btn btn--xs btn--danger"
                  data-testid={`stage-hook-remove-${stage.name}-${String(index)}`}
                  disabled={pending}
                  onClick={() => {
                    onSave(
                      (framework?.hooks ?? []).filter(
                        (h) => !(h.stage === stage.name && h === hook),
                      ),
                    )
                  }}
                >
                  {t('common.delete')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Segmented
        ariaLabel={t('code.flow.hookPhase')}
        value={phase}
        onChange={(next) => {
          setPhase(next as 'pre' | 'post')
        }}
        options={[
          { value: 'pre', label: t('code.flow.hookPre') },
          { value: 'post', label: t('code.flow.hookPost') },
        ]}
        testidPrefix={`stage-hook-phase-${stage.name}`}
      />
      <Field label={t('code.flow.scriptLanguage')}>
        <Select
          value={language}
          onChange={(next) => {
            setLanguage(next as ScriptLanguage)
          }}
          disabled={!canEdit}
          ariaLabel={t('code.flow.scriptLanguage')}
          data-testid={`stage-hook-language-${stage.name}`}
          options={SCRIPT_LANGUAGES.map((l) => ({ value: l, label: l }))}
        />
      </Field>
      <Field label={t('code.flow.hookScript')}>
        <TextArea
          value={body}
          onChange={setBody}
          monospace
          rows={6}
          disabled={!canEdit}
          data-testid={`stage-hook-body-${stage.name}`}
        />
      </Field>
      <button
        type="button"
        className="btn btn--sm"
        data-testid={`stage-hook-add-${stage.name}`}
        disabled={!canEdit || pending || body.trim() === '' || framework === null}
        onClick={() => {
          onSave([
            ...(framework?.hooks ?? []),
            {
              stage: stage.name,
              phase,
              language,
              script: body,
              blocking: true,
              // Stamped with the version the author wrote against, which is what
              // `hookRunner` compares before running it — an unstamped hook
              // would keep running after a contract change that invalidated it.
              stageContractVer: framework?.stageContractVer ?? 1,
            },
          ])
          setBody('')
        }}
      >
        {t('code.flow.addHook')}
      </button>
    </div>
  )
}

/**
 * Text inputs back to the types the framework declared.
 *
 * The form edits strings because that is what an input holds; saving them as
 * strings would silently change a `number` threshold into text that every
 * comparison downstream reads as NaN.
 */
function coerceParams(
  draft: Record<string, string>,
  schema: CapabilityFrameworkWire['paramSchema'],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const param of schema) {
    const raw = draft[param.name]
    if (raw === undefined || raw === '') continue
    if (param.kind === 'number') {
      const parsed = Number(raw)
      // A value that will not parse is left OUT rather than saved as NaN: the
      // binding then falls back to the framework default, which is a defined
      // number, instead of poisoning every comparison that reads it.
      if (Number.isFinite(parsed)) out[param.name] = parsed
      continue
    }
    if (param.kind === 'boolean') {
      out[param.name] = raw === 'true' || raw === '1'
      continue
    }
    out[param.name] = raw
  }
  return out
}

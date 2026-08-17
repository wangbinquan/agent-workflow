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
//   name / agent / prompt / params  → capability-templates:update
//   scripts / hooks                 → + scripts:author
//
// RFC-309 merged the two template layers into one row, and the boundary above
// is what survived: it is a FIELD-level check now, because scripts run as the
// daemon while choosing an agent does not. The drawer greys out what a reader
// may not write rather than hiding it — someone who cannot author scripts must
// still be able to see that a step runs one.
//
// Structure is NOT editable here (adding, removing or rewiring steps). That is
// RFC-304's D3, and the reason survives contact with this surface: five of the
// stages read and write state that outlives the round (the fingerprint ledger,
// the two-phase publish intent), and their invariants are guarantees the
// platform makes, not properties of how someone drew a line.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CapabilityTemplateWire } from '@agent-workflow/shared'

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
  const [templateId, setTemplateId] = useState<string | null>(null)
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
  const templates = useQuery({
    queryKey: ['capability-templates'],
    queryFn: () => api.get<CapabilityTemplateWire[]>('/api/capability-templates'),
    enabled: active,
  })

  // Templates for this capability. RFC-309 makes this a direct filter — it used
  // to be a two-step join through the framework, which is exactly the kind of
  // indirection the merge removed.
  const candidates = useMemo(
    () => (templates.data ?? []).filter((t) => t.capability === capability),
    [templates.data, capability],
  )

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
    setTemplateId((current) =>
      current !== null && ids.includes(current) ? current : (ids[0] ?? null),
    )
  }, [candidateKey])

  // Closing the drawer belongs to the CAPABILITY changing, which is the only
  // event that makes the open stage meaningless — its stages are gone.
  useEffect(() => {
    setOpenStage(null)
  }, [capability])

  const template = candidates.find((t) => t.id === templateId) ?? null

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
                value={templateId ?? ''}
                onChange={(next) => {
                  setTemplateId(next === '' ? null : next)
                }}
                ariaLabel={t('code.flow.binding')}
                data-testid="code-flow-binding"
                options={[
                  { value: '', label: t('code.flow.bindingNone') },
                  ...candidates.map((b) => ({ value: b.id, label: b.name })),
                ]}
              />
            </Field>
            {template !== null && template.scriptsRedacted && (
              <StatusChip kind="neutral" size="sm">
                {t('code.flow.scriptsRedactedChip')}
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
              template={template}
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
  template,
  onClose,
}: {
  stage: CapabilityGraphNode
  siblings: readonly string[]
  template: CapabilityTemplateWire | null
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canEditTemplate = usePermission('capability-templates:update')
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
    setAgentId(stage.agentSlot !== undefined ? (template?.agentBySlot[stage.agentSlot] ?? '') : '')
    setPrompt(stage.agentSlot !== undefined ? (template?.promptBySlot[stage.agentSlot] ?? '') : '')
    const script =
      stage.scriptSlot !== undefined
        ? (template?.scripts as Record<string, { language: string; script: string }> | undefined)?.[
            stage.scriptSlot
          ]
        : undefined
    setScriptBody(script?.script ?? '')
    setScriptLanguage(
      script?.language === 'python' || script?.language === 'node' ? script.language : 'bash',
    )
    setParams(
      Object.fromEntries(
        (template?.paramSchema ?? []).map((p) => [
          p.name,
          String(template?.params[p.name] ?? template?.paramDefaults[p.name] ?? ''),
        ]),
      ),
    )
  }, [stage, template])

  /**
   * One save, one invalidation.
   *
   * RFC-309 collapsed the two mutations this replaced. The important detail is
   * `scripts`/`hooks`: they are ALWAYS sent from the loaded template, so a save
   * that only changes a prompt still round-trips them unchanged and the
   * server's field-level check sees no change — which is what lets someone
   * without `scripts:author` edit the rest. When the reader is redacted those
   * fields are `undefined` here, and the ROUTE re-fills them from the stored
   * row rather than reading the absence as a delete.
   */
  const saveTemplate = useMutation({
    mutationFn: (next: Partial<CapabilityTemplateWire>) => {
      if (template === null) throw new Error('no template selected')
      return api.put<CapabilityTemplateWire>(`/api/capability-templates/${template.id}`, {
        name: template.name,
        description: template.description,
        capability: template.capability,
        ...(template.scripts === undefined ? {} : { scripts: template.scripts }),
        ...(template.hooks === undefined ? {} : { hooks: template.hooks }),
        paramSchema: template.paramSchema,
        paramDefaults: template.paramDefaults,
        agentBySlot: template.agentBySlot,
        promptBySlot: template.promptBySlot,
        params: template.params,
        stageContractVer: template.stageContractVer,
        ...next,
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['capability-templates'] }),
  })

  const hooksHere = (template?.hooks ?? []).filter((h) => h.stage === stage.name)

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
              disabled={template === null || !canEditTemplate}
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
              disabled={template === null || !canEditTemplate}
              data-testid={`stage-prompt-${stage.name}`}
            />
          </Field>
          <div className="page__actions">
            <button
              type="button"
              className="btn btn--sm btn--primary"
              data-testid={`stage-save-agent-${stage.name}`}
              disabled={template === null || !canEditTemplate || saveTemplate.isPending}
              onClick={() => {
                if (stage.agentSlot === undefined || template === null) return
                saveTemplate.mutate({
                  agentBySlot: { ...template.agentBySlot, [stage.agentSlot]: agentId },
                  promptBySlot: { ...template.promptBySlot, [stage.agentSlot]: prompt },
                })
              }}
            >
              {t('common.save')}
            </button>
          </div>
          {saveTemplate.isError && <ErrorBanner error={saveTemplate.error} />}
        </div>
      )}

      {stage.kind === 'script' && stage.scriptSlot !== undefined && (
        <div className="page__section form-grid" data-testid={`stage-script-${stage.name}`}>
          {template?.scriptsRedacted === true ? (
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
                  disabled={template === null || !canEditTemplate || !canAuthorScripts}
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
                  disabled={template === null || !canEditTemplate || !canAuthorScripts}
                  data-testid={`stage-script-body-${stage.name}`}
                />
              </Field>
              <div className="page__actions">
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  data-testid={`stage-save-script-${stage.name}`}
                  disabled={
                    template === null ||
                    !canEditTemplate ||
                    !canAuthorScripts ||
                    saveTemplate.isPending
                  }
                  onClick={() => {
                    if (stage.scriptSlot === undefined || template === null) return
                    saveTemplate.mutate({
                      scripts: {
                        ...(template.scripts ?? {}),
                        [stage.scriptSlot]: { language: scriptLanguage, script: scriptBody },
                      } as CapabilityTemplateWire['scripts'],
                    })
                  }}
                >
                  {t('common.save')}
                </button>
              </div>
              {saveTemplate.isError && <ErrorBanner error={saveTemplate.error} />}
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
      {(template?.paramSchema.length ?? 0) > 0 && (
        <div className="page__section form-grid" data-testid={`stage-params-${stage.name}`}>
          <h4>{t('code.flow.params')}</h4>
          {template?.paramSchema.map((param) => (
            <Field key={param.name} label={param.name} hint={param.kind}>
              <TextInput
                value={params[param.name] ?? ''}
                onChange={(next) => {
                  setParams((prev) => ({ ...prev, [param.name]: next }))
                }}
                disabled={template === null || !canEditTemplate}
                data-testid={`stage-param-${param.name}`}
              />
            </Field>
          ))}
          <div className="page__actions">
            <button
              type="button"
              className="btn btn--sm"
              data-testid={`stage-save-params-${stage.name}`}
              disabled={template === null || !canEditTemplate || saveTemplate.isPending}
              onClick={() => {
                saveTemplate.mutate({ params: coerceParams(params, template?.paramSchema ?? []) })
              }}
            >
              {t('code.flow.saveParams')}
            </button>
          </div>
        </div>
      )}

      <StageHooks
        stage={stage}
        template={template}
        hooks={hooksHere}
        canEdit={canEditTemplate && canAuthorScripts}
        onSave={(hooks) => {
          saveTemplate.mutate({ hooks })
        }}
        pending={saveTemplate.isPending}
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
  template,
  hooks,
  canEdit,
  onSave,
  pending,
}: {
  stage: CapabilityGraphNode
  template: CapabilityTemplateWire | null
  hooks: NonNullable<CapabilityTemplateWire['hooks']>
  canEdit: boolean
  onSave: (hooks: NonNullable<CapabilityTemplateWire['hooks']>) => void
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
                      (template?.hooks ?? []).filter(
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
        disabled={!canEdit || pending || body.trim() === '' || template === null}
        onClick={() => {
          onSave([
            ...(template?.hooks ?? []),
            {
              stage: stage.name,
              phase,
              language,
              script: body,
              blocking: true,
              // Stamped with the version the author wrote against, which is what
              // `hookRunner` compares before running it — an unstamped hook
              // would keep running after a contract change that invalidated it.
              stageContractVer: template?.stageContractVer ?? 1,
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
  schema: CapabilityTemplateWire['paramSchema'],
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

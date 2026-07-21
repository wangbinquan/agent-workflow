import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import {
  serializeWorkflowDefinitionCandidateV1,
  type Agent,
  type WorkflowCandidateHash,
  type WorkflowDefinition,
  type WorkflowDraftValidationReceipt,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field } from '@/components/Form'
import { useManagedLiveRegion } from '@/components/ManagedLiveRegion'
import { Select } from '@/components/Select'
import { sha256Hex } from '@/lib/sha256'
import {
  WORKFLOW_STARTER_CATALOG,
  planWorkflowStarter,
  workflowStarterAgentIneligibleReason,
  type WorkflowStarterId,
  type WorkflowStarterRole,
  type WorkflowStarterRoleMapping,
} from '@/lib/workflow-starters'

export interface WorkflowStarterValidationInput {
  workflowId: string
  definition: WorkflowDefinition
  signal: AbortSignal
}

export type WorkflowStarterDraftValidator = (
  input: WorkflowStarterValidationInput,
) => Promise<WorkflowDraftValidationReceipt>

export async function workflowStarterCandidateHash(
  definition: WorkflowDefinition,
): Promise<WorkflowCandidateHash> {
  // sha256Hex survives insecure http:// contexts where SubtleCrypto is
  // undefined (2026-07-21 incident) — never dereference it directly here.
  const bytes = new TextEncoder().encode(serializeWorkflowDefinitionCandidateV1(definition))
  return (await sha256Hex(bytes)) as WorkflowCandidateHash
}

export const validateWorkflowStarterDraft: WorkflowStarterDraftValidator = async ({
  workflowId,
  definition,
  signal,
}) => {
  const claimedCandidateHash = await workflowStarterCandidateHash(definition)
  const receipt = await api.post<WorkflowDraftValidationReceipt>(
    `/api/workflows/${encodeURIComponent(workflowId)}/validate-draft`,
    { definition, claimedCandidateHash },
    signal,
  )
  if (receipt.candidateHash !== claimedCandidateHash) {
    throw new Error('workflow draft validation receipt did not match the candidate')
  }
  return receipt
}

export interface WorkflowStarterDialogProps {
  open: boolean
  workflowId: string
  definition: WorkflowDefinition
  agents: Agent[]
  inventorySignature: string
  onApply: (definition: WorkflowDefinition) => void
  onUseBlank: () => void
  onClose: () => void
  triggerRef?: RefObject<HTMLElement | null>
  validateDraft?: WorkflowStarterDraftValidator
}

type ValidationState =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'done'; receipt: WorkflowDraftValidationReceipt }
  | { phase: 'error'; error: unknown }

const ROLE_ORDER: readonly WorkflowStarterRole[] = ['coder', 'auditor', 'aggregator', 'fixer']

function suggestedRoleMapping(
  starterId: Exclude<WorkflowStarterId, 'blank'>,
  agents: readonly Agent[],
  previous: WorkflowStarterRoleMapping,
): WorkflowStarterRoleMapping {
  const roles = WORKFLOW_STARTER_CATALOG.find((entry) => entry.id === starterId)?.roles ?? []
  const next: WorkflowStarterRoleMapping = {}
  const used = new Set<string>()
  for (const role of roles) {
    const eligible = agents.filter(
      (agent) => workflowStarterAgentIneligibleReason(role, agent) === null,
    )
    const existing = eligible.find((agent) => agent.name === previous[role])
    const selected = existing ?? eligible.find((agent) => !used.has(agent.name)) ?? eligible[0]
    if (selected !== undefined) {
      next[role] = selected.name
      used.add(selected.name)
    }
  }
  return next
}

function sameMapping(left: WorkflowStarterRoleMapping, right: WorkflowStarterRoleMapping): boolean {
  return ROLE_ORDER.every((role) => left[role] === right[role])
}

export function WorkflowStarterDialog({
  open,
  workflowId,
  definition,
  agents,
  inventorySignature,
  onApply,
  onUseBlank,
  onClose,
  triggerRef,
  validateDraft = validateWorkflowStarterDraft,
}: WorkflowStarterDialogProps) {
  const { t } = useTranslation()
  const managedLiveRegion = useManagedLiveRegion()
  const firstStarterRef = useRef<HTMLButtonElement | null>(null)
  const [starterId, setStarterId] =
    useState<Exclude<WorkflowStarterId, 'blank'>>('standard-development')
  const [mapping, setMapping] = useState<WorkflowStarterRoleMapping>({})
  const [validation, setValidation] = useState<ValidationState>({ phase: 'idle' })
  const [applying, setApplying] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const applyAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    setStarterId('standard-development')
    setMapping({})
    setConfirmReplace(false)
    setApplying(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    setMapping((previous) => {
      const next = suggestedRoleMapping(starterId, agents, previous)
      return sameMapping(previous, next) ? previous : next
    })
  }, [agents, open, starterId])

  const copy = useMemo(
    () => ({
      requestLabel: t('editor.starter.copy.requestLabel'),
      artifactLabel: t('editor.starter.copy.artifactLabel'),
      inputTitle: t('editor.starter.copy.inputTitle'),
      coderTitle: t('editor.starter.copy.coderTitle'),
      gitTitle: t('editor.starter.copy.gitTitle'),
      fanoutTitle: t('editor.starter.copy.fanoutTitle'),
      auditorTitle: t('editor.starter.copy.auditorTitle'),
      aggregatorTitle: t('editor.starter.copy.aggregatorTitle'),
      fixerTitle: t('editor.starter.copy.fixerTitle'),
      outputTitle: t('editor.starter.copy.outputTitle'),
    }),
    [t],
  )
  const plan = useMemo(
    () => planWorkflowStarter(starterId, mapping, agents, copy),
    [agents, copy, mapping, starterId],
  )
  const candidateKey = plan.ok ? serializeWorkflowDefinitionCandidateV1(plan.definition) : null
  const candidateKeyRef = useRef(candidateKey)
  candidateKeyRef.current = candidateKey

  useEffect(() => {
    setConfirmReplace(false)
  }, [candidateKey])

  useEffect(() => {
    if (!open || !plan.ok || candidateKey === null) {
      setValidation({ phase: 'idle' })
      return
    }
    const abort = new AbortController()
    const expectedKey = candidateKey
    setValidation({ phase: 'pending' })
    void validateDraft({ workflowId, definition: plan.definition, signal: abort.signal })
      .then((receipt) => {
        if (abort.signal.aborted || candidateKeyRef.current !== expectedKey) return
        setValidation({ phase: 'done', receipt })
      })
      .catch((error) => {
        if (abort.signal.aborted || candidateKeyRef.current !== expectedKey) return
        setValidation({ phase: 'error', error })
      })
    return () => abort.abort()
  }, [candidateKey, inventorySignature, open, plan, validateDraft, workflowId])

  useEffect(
    () => () => {
      applyAbortRef.current?.abort()
    },
    [],
  )

  const selectStarter = (id: WorkflowStarterId) => {
    if (id === 'blank') {
      onUseBlank()
      return
    }
    setStarterId(id)
    setMapping((previous) => suggestedRoleMapping(id, agents, previous))
  }

  const apply = async () => {
    if (!plan.ok || candidateKey === null || applying) return
    const replacing = definition.nodes.length > 0 || definition.edges.length > 0
    if (replacing && !confirmReplace) {
      setConfirmReplace(true)
      return
    }
    const abort = new AbortController()
    applyAbortRef.current?.abort()
    applyAbortRef.current = abort
    const expectedKey = candidateKey
    setApplying(true)
    setValidation({ phase: 'pending' })
    try {
      const receipt = await validateDraft({
        workflowId,
        definition: plan.definition,
        signal: abort.signal,
      })
      if (abort.signal.aborted || candidateKeyRef.current !== expectedKey) return
      setValidation({ phase: 'done', receipt })
      if (receipt.issues.some((issue) => (issue.severity ?? 'error') === 'error')) return
      onApply(plan.definition)
      onClose()
    } catch (error) {
      if (!abort.signal.aborted && candidateKeyRef.current === expectedKey) {
        setValidation({ phase: 'error', error })
      }
    } finally {
      if (applyAbortRef.current === abort) applyAbortRef.current = null
      setApplying(false)
    }
  }

  const catalog = WORKFLOW_STARTER_CATALOG
  const activeEntry = catalog.find((entry) => entry.id === starterId)!
  const issueByRole = new Map(
    plan.ok ? [] : plan.issues.map((issue) => [issue.role, issue.code] as const),
  )
  const validationErrors =
    validation.phase === 'done'
      ? validation.receipt.issues.filter((issue) => (issue.severity ?? 'error') === 'error')
      : []

  useEffect(() => {
    if (!open || managedLiveRegion === null) return
    if (confirmReplace) {
      managedLiveRegion.announce(t('editor.starter.replaceWarning'))
    } else if (validation.phase === 'pending') {
      managedLiveRegion.announce(t('editor.starter.validating'))
    } else if (validation.phase === 'done' && validationErrors.length === 0) {
      managedLiveRegion.announce(t('editor.starter.valid'))
    } else if (validationErrors.length > 0) {
      managedLiveRegion.announce(t('editor.starter.invalid'))
    }
  }, [confirmReplace, managedLiveRegion, open, t, validation.phase, validationErrors.length])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('editor.starter.title')}
      size="lg"
      initialFocusRef={firstStarterRef}
      triggerRef={triggerRef}
      dismissDisabled={applying}
      data-testid="workflow-starter-dialog"
      panelClassName="workflow-starter-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={applying}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={confirmReplace ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={() => void apply()}
            disabled={!plan.ok || applying || validation.phase === 'pending'}
            data-testid="workflow-starter-apply"
          >
            {applying
              ? t('editor.starter.applying')
              : confirmReplace
                ? t('editor.starter.confirmReplace')
                : t('editor.starter.apply')}
          </button>
        </>
      }
    >
      <div
        className="workflow-starter__catalog"
        role="radiogroup"
        aria-label={t('editor.starter.title')}
      >
        {catalog.map((entry, index) => {
          const selected = entry.id === starterId
          return (
            <button
              key={entry.id}
              ref={index === 0 ? firstStarterRef : undefined}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`workflow-starter__card ${selected ? 'workflow-starter__card--selected' : ''}`}
              onClick={() => selectStarter(entry.id)}
              data-testid={`workflow-starter-${entry.id}`}
            >
              <strong>{t(entry.labelKey)}</strong>
              <span>{t(entry.descriptionKey)}</span>
            </button>
          )
        })}
      </div>

      <div className="workflow-starter__roles">
        {activeEntry.roles.map((role) => {
          const options = agents.map((agent) => {
            const reason = workflowStarterAgentIneligibleReason(role, agent)
            return {
              value: agent.name,
              label: agent.name,
              disabled: reason !== null,
              description:
                reason === null ? agent.description : t(`editor.starter.issue.${reason}`),
            }
          })
          const issue = issueByRole.get(role)
          return (
            <Field
              key={role}
              label={t(`editor.starter.role.${role}`)}
              error={issue === undefined ? undefined : t(`editor.starter.issue.${issue}`)}
            >
              <Select
                value={mapping[role] ?? ''}
                options={options}
                onChange={(value) => setMapping((previous) => ({ ...previous, [role]: value }))}
                placeholder={t('editor.starter.chooseAgent')}
                ariaLabel={t(`editor.starter.role.${role}`)}
                searchable
                data-testid={`workflow-starter-role-${role}`}
              />
            </Field>
          )
        })}
      </div>

      {plan.ok && (
        <div className="workflow-starter__preview" data-testid="workflow-starter-preview">
          {t('editor.starter.preview', {
            nodes: plan.definition.nodes.length,
            edges: plan.definition.edges.length,
          })}
        </div>
      )}
      {validation.phase === 'pending' && (
        <div
          className="muted"
          role={managedLiveRegion === null ? 'status' : undefined}
          data-testid="workflow-starter-validating"
        >
          {t('editor.starter.validating')}
        </div>
      )}
      {validation.phase === 'done' && validationErrors.length === 0 && (
        <div
          className="workflow-starter__valid"
          role={managedLiveRegion === null ? 'status' : undefined}
          data-testid="workflow-starter-valid"
        >
          {t('editor.starter.valid')}
        </div>
      )}
      {validationErrors.length > 0 && (
        <div className="workflow-starter__invalid" data-testid="workflow-starter-invalid">
          <strong>{t('editor.starter.invalid')}</strong>
          <ul>
            {validationErrors.map((issue, index) => (
              <li key={`${issue.code}:${issue.pointer ?? index}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
      {validation.phase === 'error' && <ErrorBanner error={validation.error} />}
      {confirmReplace && (
        <div
          className="workflow-starter__replace-warning"
          role={managedLiveRegion === null ? 'alert' : undefined}
        >
          {t('editor.starter.replaceWarning')}
        </div>
      )}
    </Dialog>
  )
}

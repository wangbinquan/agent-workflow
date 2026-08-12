// RFC-293 — staged, multi-resource working-context editor.

import type { IntentSessionDetail } from '@agent-workflow/shared'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ulid } from 'ulid'
import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { Checkbox, Field } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { ResourcePicker } from '@/components/ResourcePicker'
import { Segmented } from '@/components/Segmented'

const MOUNT_TYPES = ['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup'] as const
export type IntentMountType = (typeof MOUNT_TYPES)[number]

const LIST_SOURCES: Record<IntentMountType, { endpoint: string; queryKey: readonly string[] }> = {
  agent: { endpoint: '/api/agents', queryKey: ['agents'] },
  skill: { endpoint: '/api/skills', queryKey: ['skills'] },
  mcp: { endpoint: '/api/mcps', queryKey: ['mcps'] },
  plugin: { endpoint: '/api/plugins', queryKey: ['plugins'] },
  workflow: { endpoint: '/api/workflows', queryKey: ['workflows'] },
  workgroup: { endpoint: '/api/workgroups', queryKey: ['workgroups'] },
}

interface MountRow {
  id: string
  name: string
  description?: string | null
}

type Picks = Record<IntentMountType, string[]>
const EMPTY_PICKS: Picks = {
  agent: [],
  skill: [],
  mcp: [],
  plugin: [],
  workflow: [],
  workgroup: [],
}

export interface IntentMountDialogProps {
  open: boolean
  onClose: () => void
  sessionId: string
  turnSeq: number
  contextRevision: number
  inFlight: boolean
  mounted: IntentSessionDetail['mounts']
  pendingChange: IntentSessionDetail['workingSetChange']
  onChanged: () => void
}

export function IntentMountDialog(props: IntentMountDialogProps) {
  const { t } = useTranslation()
  const [type, setType] = useState<IntentMountType>('agent')
  const [picks, setPicks] = useState<Picks>(EMPTY_PICKS)
  const [removals, setRemovals] = useState<string[]>([])
  const [busy, setBusy] = useState<'after-current' | 'interrupt' | 'cancel' | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const initializedRef = useRef<string | null>(null)
  const editablePending =
    props.pendingChange !== null &&
    (props.pendingChange.state === 'queued' || props.pendingChange.state === 'failed')
      ? props.pendingChange
      : null

  useEffect(() => {
    if (!props.open) {
      initializedRef.current = null
      return
    }
    const source = editablePending?.id ?? 'fresh'
    if (initializedRef.current === source) return
    initializedRef.current = source
    const next: Picks = { ...EMPTY_PICKS }
    for (const addition of editablePending?.delta.additions ?? []) {
      next[addition.resourceType] = [...next[addition.resourceType], addition.resourceId]
    }
    setPicks(next)
    setRemovals(editablePending?.delta.removals ?? [])
    setError(null)
  }, [editablePending, props.open])

  const additions = MOUNT_TYPES.flatMap((resourceType) =>
    picks[resourceType].map((resourceId) => ({ resourceType, resourceId })),
  )
  const changed = additions.length > 0 || removals.length > 0
  const close = () => {
    if (busy !== null) return
    props.onClose()
  }

  const submit = async (mode: 'after-current' | 'interrupt') => {
    setBusy(mode)
    setError(null)
    try {
      await api.post(`/api/intent-sessions/${props.sessionId}/working-set`, {
        clientMutationId: ulid(),
        expectedTurnSeq: props.turnSeq,
        expectedContextRevision: props.contextRevision,
        mode,
        ...(editablePending === null ? {} : { replacesChangeId: editablePending.id }),
        delta: { additions, removals },
      })
      props.onChanged()
      props.onClose()
    } catch (cause) {
      setError(cause as ApiError)
    } finally {
      setBusy(null)
    }
  }

  const dismissPending = async () => {
    if (editablePending === null) return
    setBusy('cancel')
    setError(null)
    try {
      await api.delete(
        `/api/intent-sessions/${props.sessionId}/working-set/${encodeURIComponent(editablePending.id)}`,
      )
      props.onChanged()
      props.onClose()
    } catch (cause) {
      setError(cause as ApiError)
    } finally {
      setBusy(null)
    }
  }

  const mountedIds = new Set(
    props.mounted.filter((mount) => mount.resourceType === type).map((mount) => mount.resourceId),
  )
  const source = LIST_SOURCES[type]

  return (
    <Dialog
      open={props.open}
      onClose={close}
      title={t('intent.workingContextManage')}
      size="lg"
      footer={
        <>
          {editablePending !== null ? (
            <button
              type="button"
              className="btn"
              onClick={() => void dismissPending()}
              disabled={busy !== null}
            >
              {t('intent.workingContextDismiss')}
            </button>
          ) : null}
          <button type="button" className="btn" onClick={close} disabled={busy !== null}>
            {t('common.cancel')}
          </button>
          {props.inFlight ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={!changed || busy !== null}
                onClick={() => void submit('after-current')}
              >
                {t('intent.workingContextQueue')}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!changed || busy !== null}
                onClick={() => void submit('interrupt')}
                data-testid="intent-working-context-interrupt"
              >
                {t('intent.workingContextInterrupt')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={!changed || busy !== null}
              onClick={() => void submit('after-current')}
              data-testid="intent-working-context-submit"
            >
              {t('intent.workingContextSaveAndRun')}
            </button>
          )}
        </>
      }
    >
      {error !== null ? <NoticeBanner tone="error">{error.message}</NoticeBanner> : null}
      {props.inFlight ? (
        <NoticeBanner tone="info">{t('intent.workingContextRunningHint')}</NoticeBanner>
      ) : null}
      {editablePending?.state === 'failed' ? (
        <NoticeBanner tone="warning">
          {editablePending.error ?? t('intent.workingContextFailed')}
        </NoticeBanner>
      ) : null}
      {props.mounted.length > 0 ? (
        <Field label={t('intent.workingContextMounted')} group>
          <div className="intent-working-context-dialog__mounted">
            {props.mounted.map((mount) => (
              <Checkbox
                key={mount.handle}
                checked={removals.includes(mount.handle)}
                onChange={(checked) =>
                  setRemovals((current) =>
                    checked
                      ? [...current, mount.handle]
                      : current.filter((handle) => handle !== mount.handle),
                  )
                }
                label={mount.displayName ?? t('intent.mountUnavailable')}
                hint={`${t(`intent.resourceType.${mount.resourceType}`)} · ${mount.handle}`}
              />
            ))}
          </div>
          <p className="field__hint">{t('intent.workingContextRemoveHint')}</p>
        </Field>
      ) : null}
      <Field label={t('intent.addMountType')}>
        <Segmented
          ariaLabel={t('intent.addMountType')}
          value={type}
          onChange={(next) => setType(next as IntentMountType)}
          options={MOUNT_TYPES.map((value) => ({
            value,
            label: t(`intent.resourceType.${value}`),
          }))}
        />
      </Field>
      <Field label={t('intent.addMountResources')}>
        <ResourcePicker<MountRow>
          value={picks[type]}
          onChange={(ids) => setPicks((current) => ({ ...current, [type]: ids }))}
          queryKey={source.queryKey}
          endpoint={source.endpoint}
          labelFn={(row) => row.name}
          descriptionFn={(row) => row.description ?? undefined}
          filter={(row) => !mountedIds.has(row.id)}
          ariaLabel={t('intent.addMountResources')}
          testid="intent-mount-picker"
          labels={{
            loading: t('intent.mountPickerLoading'),
            empty: t('intent.mountPickerEmpty'),
            loadFailed: t('intent.mountPickerLoadFailed'),
            unresolved: t('intent.mountPickerUnresolved'),
          }}
        />
      </Field>
      {additions.length > 0 || removals.length > 0 ? (
        <p className="intent-working-context-dialog__summary">
          {t('intent.workingContextDeltaSummary', {
            additions: additions.length,
            removals: removals.length,
          })}
        </p>
      ) : null}
    </Dialog>
  )
}

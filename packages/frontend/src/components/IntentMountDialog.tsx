// RFC-234 (T11) — "add mount" dialog for an intent session.
//
// One dialog for all six resource types: a Segmented type switch feeds the
// shared <ResourcePicker> (same combobox as the agent-form pickers), and the
// footer POSTs one mount per selected id through the existing
// /api/intent-sessions/:id/mounts endpoint (server enforces visibility with
// the 404-shape, and duplicate roots with `intent-mount-exists`). Selection
// resets when the type switches — mounts are added per type, not batched
// across types.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { Field } from '@/components/Form'
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
  ownerUserId?: string | null
}

export interface IntentMountDialogProps {
  open: boolean
  onClose: () => void
  sessionId: string
  /** Already-mounted roots — excluded from the picker's eligible rows. */
  mounted: ReadonlyArray<{ resourceType: string; resourceId: string }>
  /** Called after every selected mount POSTed successfully. */
  onAdded: () => void
}

export function IntentMountDialog(props: IntentMountDialogProps) {
  const { t } = useTranslation()
  const [type, setType] = useState<IntentMountType>('agent')
  const [ids, setIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  const close = () => {
    if (busy) return
    setIds([])
    setError(null)
    props.onClose()
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      for (const resourceId of ids) {
        await api.post(`/api/intent-sessions/${props.sessionId}/mounts`, {
          resourceType: type,
          resourceId,
        })
      }
      setIds([])
      props.onAdded()
      props.onClose()
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setBusy(false)
    }
  }

  const mountedIds = new Set(
    props.mounted.filter((m) => m.resourceType === type).map((m) => m.resourceId),
  )
  const source = LIST_SOURCES[type]

  return (
    <Dialog
      open={props.open}
      onClose={close}
      title={t('intent.addMountTitle')}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="intent-mount-submit"
            onClick={() => void submit()}
            disabled={busy || ids.length === 0}
          >
            {t('intent.addMountSubmit')}
          </button>
        </>
      }
    >
      {error !== null ? <NoticeBanner tone="error">{error.message}</NoticeBanner> : null}
      <Field label={t('intent.addMountType')}>
        <Segmented
          ariaLabel={t('intent.addMountType')}
          value={type}
          onChange={(next) => {
            setType(next as IntentMountType)
            setIds([])
          }}
          options={MOUNT_TYPES.map((value) => ({
            value,
            label: t(`intent.resourceType.${value}`),
          }))}
        />
      </Field>
      <Field label={t('intent.addMountResources')}>
        <ResourcePicker<MountRow>
          value={ids}
          onChange={setIds}
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
    </Dialog>
  )
}

// RFC-164 PR-1 — /workgroups/$name: the workgroup management surface.
//   1. Launch-readiness banner (shared workgroupLaunchReadiness oracle —
//      save is lenient, launch is strict; the banner explains what's missing).
//   2. Config form (description / mode / instructions / switches / rounds /
//      gate) — a draft saved via the header Save; the PUT passes the group's
//      CURRENT members through unchanged (full-document replace).
//   3. Member cards (<WorkgroupMemberCards>) — add / edit / remove /
//      set-leader commit immediately: read current → pure change → PUT.
// Header keeps the /mcps/$name action shape: ACL + Save + Delete, plus the
// Rename button + <Dialog> (POST …/rename — PUT cannot change the name).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateWorkgroup, Workgroup } from '@agent-workflow/shared'
import { WORKGROUP_NAME_RE, workgroupLaunchReadiness } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import { describeApiError } from '@/i18n'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { Dialog } from '@/components/Dialog'
import { Field, TextInput } from '@/components/Form'
import { FormSection } from '@/components/FormSection'
import { LoadingState } from '@/components/LoadingState'
import { WorkgroupForm } from '@/components/workgroup/WorkgroupForm'
import { WorkgroupMemberCards } from '@/components/workgroup/WorkgroupMemberCards'
import {
  buildConfigUpdatePayload,
  buildMembersUpdatePayload,
  workgroupToConfigDraft,
  type WorkgroupMembersState,
} from '@/lib/workgroup-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workgroups/$name',
  component: WorkgroupDetailPage,
})

function WorkgroupDetailPage() {
  const { t } = useTranslation()
  const { name } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const query = useQuery<Workgroup>({
    queryKey: ['workgroups', name],
    queryFn: ({ signal }) =>
      api.get(`/api/workgroups/${encodeURIComponent(name)}`, undefined, signal),
  })
  const group = query.data

  // RFC-151 PR-4 — hydrate-once CONFIG draft (members live outside the draft:
  // the card zone renders them straight from the query row, so its immediate
  // PUTs can never clobber pending config edits).
  const {
    draft: form,
    setDraft: setForm,
    loaded,
  } = useDraftFromQuery(group, workgroupToConfigDraft)

  function putWorkgroup(payload: UpdateWorkgroup): Promise<Workgroup> {
    return api.put<Workgroup>(`/api/workgroups/${encodeURIComponent(name)}`, payload)
  }

  const save = useMutation({
    mutationFn: putWorkgroup,
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      qc.setQueryData(['workgroups', name], w)
      navigate({ to: '/workgroups' })
    },
  })

  // Member-card operations share one PUT channel; the fresh row is written
  // back eagerly so the cards re-render from server truth.
  const membersMut = useMutation({
    mutationFn: putWorkgroup,
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      qc.setQueryData(['workgroups', name], w)
    },
  })

  async function applyMembers(next: WorkgroupMembersState): Promise<boolean> {
    if (group === undefined) return false
    const built = buildMembersUpdatePayload(group, next)
    if (!built.ok) return false
    try {
      await membersMut.mutateAsync(built.payload)
      return true
    } catch {
      // Surfaced via membersMut.error (header error row + dialog footer).
      return false
    }
  }

  const del = useMutation({
    mutationFn: () => api.delete(`/api/workgroups/${encodeURIComponent(name)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      navigate({ to: '/workgroups' })
    },
  })

  // Rename dialog state. POST …/rename, then move to the new detail URL.
  const [renameOpen, setRenameOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const renameTriggerRef = useRef<HTMLButtonElement | null>(null)
  const rename = useMutation({
    mutationFn: (nn: string): Promise<Workgroup> =>
      api.post<Workgroup>(`/api/workgroups/${encodeURIComponent(name)}/rename`, { newName: nn }),
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      qc.setQueryData(['workgroups', w.name], w)
      setRenameOpen(false)
      navigate({ to: '/workgroups/$name', params: { name: w.name } })
    },
  })
  const renameValid = newName.length > 0 && newName.length <= 128 && WORKGROUP_NAME_RE.test(newName)

  // Live pre-validation — the config draft blocks Save only on real field
  // errors (决策 #21: no leader / no members are launch problems, not save
  // problems — the readiness banner communicates them instead).
  const built =
    form !== undefined && group !== undefined ? buildConfigUpdatePayload(form, group) : undefined
  const readiness = group !== undefined ? workgroupLaunchReadiness(group) : null

  if (query.isLoading)
    return (
      <div className="page">
        <LoadingState />
      </div>
    )
  if (query.error !== null && query.error !== undefined)
    return <div className="page error-box">{describeApiError(query.error)}</div>

  return (
    <div className="page">
      <DetailHeaderActions
        acl={{
          resourceBaseUrl: `/api/workgroups/${encodeURIComponent(name)}`,
          invalidateKey: ['workgroups'],
        }}
        save={{
          label: save.isPending ? t('common.saving') : t('common.save'),
          onClick: () => {
            if (built !== undefined && built.ok) save.mutate(built.payload)
          },
          disabled: save.isPending || !loaded || built === undefined || !built.ok,
          testid: 'workgroup-save-button',
        }}
        del={{
          label: t('common.delete'),
          onConfirm: () => del.mutateAsync(),
          disabled: del.isPending,
        }}
        extra={
          <>
            {/* RFC-164 PR-4: launch entry — only when the shared readiness
                oracle says the group can actually start a task. */}
            {readiness !== null && readiness.ready && (
              <Link
                to="/tasks/new"
                search={{ kind: 'workgroup', workgroup: name }}
                className="btn btn--primary"
                data-testid="workgroup-launch-button"
              >
                {t('workgroups.launchButton')}
              </Link>
            )}
            <button
              type="button"
              className="btn"
              ref={renameTriggerRef}
              onClick={() => {
                setNewName(name)
                setRenameOpen(true)
              }}
              data-testid="workgroup-rename-button"
            >
              {t('workgroups.renameButton')}
            </button>
          </>
        }
        errors={[save.error, del.error, rename.error, membersMut.error]}
      >
        <div>
          <h1>{name}</h1>
        </div>
      </DetailHeaderActions>

      {readiness !== null && !readiness.ready && (
        <div
          className="info-box info-box--muted workgroup-readiness"
          role="status"
          data-testid="workgroup-readiness-banner"
        >
          {readiness.reasons.map((reason) => (
            <span key={reason}>
              {reason === 'no-agent-member'
                ? t('workgroups.readiness.noAgentMember')
                : t('workgroups.readiness.leaderMissing')}
            </span>
          ))}
        </div>
      )}

      {form !== undefined && (
        <WorkgroupForm
          value={form}
          onChange={(next) => setForm(next)}
          errors={built !== undefined && !built.ok ? built.errors : {}}
        />
      )}

      {group !== undefined && (
        <FormSection title={t('workgroups.sectionMembers')}>
          <WorkgroupMemberCards
            group={group}
            applying={membersMut.isPending}
            applyError={membersMut.error}
            onApply={applyMembers}
          />
        </FormSection>
      )}

      <Dialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title={t('workgroups.renameTitle')}
        size="sm"
        triggerRef={renameTriggerRef}
        data-testid="workgroup-rename-dialog"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setRenameOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={rename.isPending || !renameValid || newName === name}
              onClick={() => rename.mutate(newName)}
              data-testid="workgroup-rename-confirm"
            >
              {rename.isPending ? t('common.saving') : t('common.save')}
            </button>
          </>
        }
      >
        <Field label={t('workgroups.renameField')} required hint={t('workgroups.fieldNameHint')}>
          <TextInput
            value={newName}
            onChange={setNewName}
            pattern={WORKGROUP_NAME_RE.source}
            maxLength={128}
            data-testid="workgroup-rename-input"
          />
        </Field>
      </Dialog>
    </div>
  )
}

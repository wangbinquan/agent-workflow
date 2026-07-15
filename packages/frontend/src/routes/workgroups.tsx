// RFC-164 → RFC-191 — /workgroups list page as a card gallery. Cards open the
// room at /workgroups/$name (whole card = stretched link);「启动」deep-links
// the task wizard with the group preselected — gated on the SAME shared
// `workgroupLaunchReadiness` oracle the detail page uses (a not-ready group,
// e.g. quick-created / leaderless, hides the launch action instead of letting
// the deep link dead-end at `workgroup-not-ready`). Creation is the
// QUICK-CREATE dialog (name + description only); members/config live on the
// detail page, and delete lives in the detail header (no list-level delete).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Workgroup } from '@agent-workflow/shared'
import { workgroupLaunchReadiness } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useResourceList } from '@/hooks/useResourceList'
import { describeApiError } from '@/i18n'
import { QuickCreateDialog } from '@/components/QuickCreateDialog'
import { ResourceBadges } from '@/components/ResourceBadges'
import { StatusChip } from '@/components/StatusChip'
import { ResourceGalleryPage, type GalleryCardItem } from '@/components/gallery/ResourceGalleryPage'
import { WORKGROUP_MODE_KIND } from '@/lib/workgroup-mode'
import {
  buildQuickCreatePayload,
  workgroupLeaderDisplayName,
  type QuickCreateWorkgroupBody,
} from '@/lib/workgroup-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workgroups',
  component: WorkgroupsPage,
})

function WorkgroupsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  // RFC-151 PR-3 — shared list shell: query + owner lookup. The delete
  // mutation is unused here since RFC-191 (delete lives in the detail header).
  const { data, isLoading, error, owners } = useResourceList<Workgroup>({
    queryKey: ['workgroups'],
    endpoint: '/api/workgroups',
    deleteBy: 'name',
  })

  // Quick create — name + description only; navigate to the detail page
  // (where members and the rest of the config are managed) on success.
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const createTriggerRef = useRef<HTMLButtonElement | null>(null)
  // Mirrors createOpen for the mutation callback: dismissing the dialog while
  // a slow POST is in flight must NOT yank the user to the detail page when
  // the response lands later (same guard as the workflows list page).
  const createOpenRef = useRef(false)
  function setCreateOpenTracked(open: boolean): void {
    createOpenRef.current = open
    setCreateOpen(open)
  }
  const create = useMutation({
    mutationFn: (body: QuickCreateWorkgroupBody): Promise<Workgroup> =>
      api.post<Workgroup>('/api/workgroups', body),
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      qc.setQueryData(['workgroups', w.name], w)
      if (!createOpenRef.current) return
      setCreateOpenTracked(false)
      navigate({ to: '/workgroups/$name', params: { name: w.name } })
    },
  })
  const builtCreate = buildQuickCreatePayload({
    name: createName,
    description: createDescription,
  })

  function openCreate(): void {
    setCreateName('')
    setCreateDescription('')
    create.reset()
    setCreateOpenTracked(true)
  }

  // Gallery items — updatedAt desc. The config summary that used to spread
  // over three table columns (mode / members / leader) folds into meta chips.
  const items = useMemo<GalleryCardItem[] | undefined>(
    () =>
      data === undefined
        ? undefined
        : data
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((w) => {
              const leader = workgroupLeaderDisplayName(w)
              const ready = workgroupLaunchReadiness(w).ready
              return {
                key: w.id,
                title: w.name,
                subtitle: w.description === '' ? undefined : w.description,
                subtitleFallback: t('workgroups.noDescription'),
                badges: (
                  <ResourceBadges
                    visibility={w.visibility}
                    ownerUserId={w.ownerUserId}
                    owners={owners}
                  />
                ),
                meta: (
                  <>
                    <StatusChip kind={WORKGROUP_MODE_KIND[w.mode]} size="sm">
                      {w.mode === 'leader_worker'
                        ? t('workgroups.modeLeaderWorker')
                        : w.mode === 'dynamic_workflow'
                          ? t('workgroups.modeDynamicWorkflow')
                          : t('workgroups.modeFreeCollab')}
                    </StatusChip>
                    <span className="chip chip--tight">
                      {t('workgroups.cardMembers', { n: w.members.length })}
                    </span>
                    {leader !== null && (
                      // title carries the full value — the chip ellipsizes
                      // (64-char whitespace-free names, 实现门 P2).
                      <span className="chip chip--tight" title={leader}>
                        {t('workgroups.cardLeader', { name: leader })}
                      </span>
                    )}
                    {w.autonomous === true && (
                      <span className="chip chip--tight">{t('workgroups.autonomousChip')}</span>
                    )}
                  </>
                ),
                updatedAt: w.updatedAt,
                to: '/workgroups/$name' as const,
                params: { name: w.name },
                // Not-ready groups (no agent member / missing leader) hide
                // launch — same oracle & behavior as the detail header.
                launch: ready ? { kind: 'workgroup' as const, workgroup: w.name } : undefined,
                testid: `workgroup-card-${w.name}`,
              }
            }),
    [data, owners, t],
  )

  return (
    <ResourceGalleryPage
      title={t('workgroups.title')}
      headerActions={
        <button
          type="button"
          className="btn btn--primary"
          ref={createTriggerRef}
          onClick={openCreate}
          data-testid="workgroup-new-button"
        >
          {t('workgroups.newButton')}
        </button>
      }
      items={items}
      isLoading={isLoading}
      error={error}
      searchPlaceholder={t('common.searchEllipsis')}
      emptyListText={t('workgroups.emptyList')}
      emptyTestid="workgroups-empty"
      loadingTestid="workgroups-loading"
    >
      <QuickCreateDialog
        open={createOpen}
        onClose={() => setCreateOpenTracked(false)}
        title={t('workgroups.newTitle')}
        createLabel={t('workgroups.createButton')}
        nameLabel={t('workgroups.fieldName')}
        nameHint={t('workgroups.fieldNameHint')}
        descriptionLabel={t('workgroups.fieldDescription')}
        name={createName}
        onNameChange={setCreateName}
        description={createDescription}
        onDescriptionChange={setCreateDescription}
        nameError={
          createName !== '' && !builtCreate.ok && builtCreate.errors.name !== undefined
            ? t(builtCreate.errors.name)
            : undefined
        }
        canCreate={builtCreate.ok}
        pending={create.isPending}
        submitError={
          create.error !== null && create.error !== undefined
            ? describeApiError(create.error)
            : undefined
        }
        onCreate={() => {
          if (builtCreate.ok) create.mutate(builtCreate.payload)
        }}
        triggerRef={createTriggerRef}
        testidPrefix="workgroup"
        descriptionMaxLength={4096}
      />
    </ResourceGalleryPage>
  )
}

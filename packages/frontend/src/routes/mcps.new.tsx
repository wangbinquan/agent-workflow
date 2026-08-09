// MCP create page — the inline "new" view of the /mcps split page.
//
// RFC-169 (T15/T-D10): child route under the /mcps layout (path '/new'). Single
// config group → no tab strip. Light header with the create button.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreateMcp, Mcp } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { McpFields } from '@/components/McpFields'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { PageHeader } from '@/components/PageHeader'
import {
  ResourcePackageImportPanel,
  type ResourcePackageImportPanelHandle,
} from '@/components/ResourcePackageImportDialog'
import {
  NEW_CARD_KEY,
  useRegisterSplitDiscard,
  useReportSplitDirty,
  useSplitDirty,
  type SplitBusyRelease,
} from '@/components/split/splitDirty'
import { useDirtyBaseline } from '@/hooks/useDraftFromQuery'
import { TabBar } from '@/components/TabBar'
import { TabPanels } from '@/components/split/TabPanels'
import { buildCreatePayload, EMPTY_LOCAL_FORM, type McpFormState } from '@/lib/mcp-form'
import { Route as mcpsRoute } from './mcps'

export const Route = createRoute({
  getParentRoute: () => mcpsRoute,
  path: '/new',
  component: McpCreatePage,
})

type CreateMode = 'manual' | 'package'

function McpCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { beginBusy, report } = useSplitDirty()
  const [form, setForm] = useState<McpFormState>(EMPTY_LOCAL_FORM)
  const [createMode, setCreateMode] = useState<CreateMode>('manual')
  const [packageDirty, setPackageDirty] = useState(false)
  const [packageBusy, setPackageBusy] = useState(false)
  const [packageOutcomeUnknown, setPackageOutcomeUnknown] = useState(false)
  const packagePanelRef = useRef<ResourcePackageImportPanelHandle | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const { dirty } = useDirtyBaseline(form, EMPTY_LOCAL_FORM)
  useReportSplitDirty(NEW_CARD_KEY, dirty || packageDirty)
  useRegisterSplitDiscard(NEW_CARD_KEY, () => packagePanelRef.current?.discard() ?? true)

  const create = useMutation({
    mutationFn: ({ payload }: { payload: CreateMcp; release: SplitBusyRelease }): Promise<Mcp> =>
      api.post<Mcp>('/api/mcps', payload),
    onSuccess: (m, { release }) => {
      report(NEW_CARD_KEY, false)
      void qc.invalidateQueries({ queryKey: ['mcps'] })
      qc.setQueryData(['mcps', m.id], m)
      release()
      navigate({ to: '/mcps/$id', params: { id: m.id } })
    },
    onSettled: (_mcp, _error, { release }) => release(),
  })

  function submit() {
    const built = buildCreatePayload(form)
    if (!built.ok) {
      setErrors(built.errors)
      create.reset()
      return
    }
    setErrors({})
    if (create.isPending || packageBusy || packageOutcomeUnknown) return
    create.mutate({ payload: built.payload, release: beginBusy(NEW_CARD_KEY) })
  }

  return (
    <fieldset className="agent-new detail-freeze" disabled={create.isPending || packageBusy}>
      <PageHeader
        title={createMode === 'package' ? t('resourcePackage.importTitle') : t('mcps.newTitle')}
        headingLevel={2}
        actions={
          createMode === 'manual' ? (
            <button
              type="button"
              className="btn btn--primary"
              disabled={
                create.isPending || packageBusy || packageOutcomeUnknown || form.name === ''
              }
              onClick={submit}
              data-testid="mcp-save-button"
            >
              {create.isPending ? t('common.creating') : t('mcps.createButton')}
            </button>
          ) : null
        }
      />
      <TabBar<CreateMode>
        tabs={[
          {
            key: 'manual',
            label: t('resourcePackage.createManually'),
            disabled: packageBusy || packageOutcomeUnknown,
            ...((create.error !== null && create.error !== undefined) ||
            Object.keys(errors).length > 0
              ? {
                  badge: '!',
                  badgeTone: 'danger' as const,
                  badgeAriaLabel: t('editor.draftStatus.phase.error'),
                }
              : dirty
                ? {
                    badge: '•',
                    badgeTone: 'neutral' as const,
                    badgeAriaLabel: t('editor.statusUnsaved'),
                  }
                : {}),
          },
          {
            key: 'package',
            label: t('resourcePackage.importTitle'),
            testid: 'mcps-create-package-tab',
            disabled: packageBusy,
            ...(packageDirty
              ? {
                  badge: '•',
                  badgeTone: 'neutral' as const,
                  badgeAriaLabel: t('editor.statusUnsaved'),
                }
              : {}),
          },
        ]}
        active={createMode}
        onSelect={(nextMode) => {
          if (!packageBusy && (!packageOutcomeUnknown || nextMode === 'package')) {
            setCreateMode(nextMode)
          }
        }}
        ariaLabel={t('resourcePackage.createMethod')}
        idPrefix="mcps-create"
      />
      <TabPanels<CreateMode>
        active={createMode}
        idPrefix="mcps-create"
        className="split__detail-body"
        panels={[
          {
            key: 'manual',
            content: (
              <>
                <FeedbackStack variant="section">
                  {create.error !== null && create.error !== undefined && (
                    <ErrorBanner error={create.error} />
                  )}
                </FeedbackStack>
                <McpFields value={form} onChange={setForm} errors={errors} />
              </>
            ),
          },
          {
            key: 'package',
            content: (
              <ResourcePackageImportPanel
                ref={packagePanelRef}
                expectedRootType="mcp"
                onDirtyChange={setPackageDirty}
                onBusyChange={setPackageBusy}
                onOutcomeUnknownChange={setPackageOutcomeUnknown}
                prepareAutoOpen={() => {
                  setPackageDirty(false)
                  report(NEW_CARD_KEY, dirty)
                  return !dirty
                }}
                beginCommitBusy={() => {
                  setPackageBusy(true)
                  const release = beginBusy(NEW_CARD_KEY)
                  return () => {
                    release()
                    setPackageBusy(false)
                  }
                }}
              />
            ),
          },
        ]}
      />
    </fieldset>
  )
}

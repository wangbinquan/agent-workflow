// RFC-309 T23 — "use this template", pressed.
//
// The user's third question was 「如果我要基于模版创建一个需求开发任务，入口在
// 哪」 and the honest answer was: there isn't one. RFC-304's plan recorded the
// debt itself (T46b promised three entrances for `requirement` and shipped the
// issue-label one), so until this panel the only way to start any round was to
// go to the code host and trigger a webhook.
//
// ## Why the form changes shape with the capability
//
// The four launchable capabilities need genuinely different starting points: a
// requirement is text a person wrote, a review needs a merge request that
// exists, a CI fix needs a failed pipeline. The server models that as a
// discriminated union so `{capability: 'mr-review', title: '…'}` cannot be
// expressed; this form is the same decision made visible — you are never shown
// a field the chosen capability will ignore.
//
// The capability is NOT a choice here. It comes from the template, because a
// template drives exactly one capability and letting the two disagree is how
// somebody launches a review with a requirement's stages configured.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { CapabilityTemplateWire } from '@agent-workflow/shared'

import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'

interface RepoRow {
  id: string
  name: string
}

interface LaunchReceipt {
  workItemId: string
  roundId: string
  roundSeq: number
}

/** The four a person can start by hand. `mr-monitor` is a standing loop. */
const LAUNCHABLE = ['requirement', 'mr-review', 'ci-fix', 'mr-comment-fix']

export function LaunchRoundPanel({
  template,
}: {
  template: CapabilityTemplateWire
}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [repoId, setRepoId] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [mrIid, setMrIid] = useState('')
  const [pipelineId, setPipelineId] = useState('')
  const [discussionId, setDiscussionId] = useState('')

  const launchable = LAUNCHABLE.includes(template.capability)

  const repos = useQuery({
    queryKey: ['repos'],
    queryFn: () => api.get<RepoRow[]>('/api/repos'),
    enabled: launchable,
  })

  const launch = useMutation({
    mutationFn: () =>
      api.post<LaunchReceipt>('/api/code/rounds', {
        repoId,
        templateId: template.id,
        input: inputFor(template.capability, { title, body, mrIid, pipelineId, discussionId }),
      }),
    onSuccess: async () => {
      // The receipt is a place, not a number (RFC-304 AC-34). A person who just
      // pressed start wants to watch it, and an id they have to paste
      // somewhere is a receipt in name only.
      await navigate({ to: '/code', search: { tab: 'activity' } })
    },
  })

  if (!launchable) {
    return (
      <section className="page__section card" data-testid="code-launch-unavailable">
        <h3>{t('code.launch.title')}</h3>
        <p>{t('code.launch.notLaunchable')}</p>
      </section>
    )
  }

  const ready =
    repoId !== '' &&
    (template.capability === 'requirement'
      ? title.trim() !== ''
      : template.capability === 'ci-fix'
        ? pipelineId.trim() !== ''
        : template.capability === 'mr-review'
          ? mrIid.trim() !== ''
          : mrIid.trim() !== '' && discussionId.trim() !== '')

  return (
    <section className="page__section card" data-testid="code-launch">
      <div className="page__header--row">
        <h3>{t('code.launch.title')}</h3>
        <StatusChip kind="info" size="sm">
          {template.capability}
        </StatusChip>
      </div>
      {/* The rule that surprises people, stated where they would hit it: a
          manual launch does not need the matrix cell switched on, because the
          matrix answers "respond to webhooks automatically" and this is not
          that question. */}
      <p>{t('code.launch.hint')}</p>

      <div className="form-grid">
        <Field label={t('code.launch.repo')} required>
          <Select
            value={repoId}
            onChange={setRepoId}
            ariaLabel={t('code.launch.repo')}
            data-testid="code-launch-repo"
            options={[
              { value: '', label: t('code.launch.repoNone') },
              ...(repos.data ?? []).map((r) => ({ value: r.id, label: r.name })),
            ]}
          />
        </Field>

        {template.capability === 'requirement' && (
          <>
            <Field label={t('code.launch.reqTitle')} required>
              <TextInput value={title} onChange={setTitle} data-testid="code-launch-title" />
            </Field>
            <Field label={t('code.launch.reqBody')} hint={t('code.launch.reqBodyHint')}>
              <TextArea
                value={body}
                onChange={setBody}
                rows={8}
                monospace
                data-testid="code-launch-body"
              />
            </Field>
          </>
        )}

        {(template.capability === 'mr-review' || template.capability === 'mr-comment-fix') && (
          <Field label={t('code.launch.mrIid')} required hint={t('code.launch.mrIidHint')}>
            <TextInput value={mrIid} onChange={setMrIid} data-testid="code-launch-mr" />
          </Field>
        )}

        {template.capability === 'mr-comment-fix' && (
          <Field
            label={t('code.launch.discussionId')}
            required
            hint={t('code.launch.discussionIdHint')}
          >
            <TextInput
              value={discussionId}
              onChange={setDiscussionId}
              data-testid="code-launch-discussion"
            />
          </Field>
        )}

        {template.capability === 'ci-fix' && (
          <Field label={t('code.launch.pipelineId')} required>
            <TextInput
              value={pipelineId}
              onChange={setPipelineId}
              data-testid="code-launch-pipeline"
            />
          </Field>
        )}
      </div>

      <div className="page__actions">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          data-testid="code-launch-submit"
          disabled={!ready || launch.isPending}
          onClick={() => {
            launch.mutate()
          }}
        >
          {t('code.launch.submit')}
        </button>
      </div>

      {launch.isError && <ErrorBanner error={launch.error} />}
    </section>
  )
}

/**
 * The body's `input`, shaped for the chosen capability.
 *
 * Built here rather than accumulated in state so the request can never carry a
 * field from a capability the user switched away from — the server's union is
 * `.strict()` and would reject it, which is the right answer but a confusing
 * one to receive after filling in a form correctly.
 */
function inputFor(
  capability: string,
  draft: {
    title: string
    body: string
    mrIid: string
    pipelineId: string
    discussionId: string
  },
): Record<string, unknown> {
  switch (capability) {
    case 'requirement':
      return { capability, title: draft.title, body: draft.body, documents: [] }
    case 'mr-review':
      return { capability, mrIid: draft.mrIid }
    case 'ci-fix':
      return { capability, pipelineId: draft.pipelineId }
    default:
      return { capability, mrIid: draft.mrIid, discussionId: draft.discussionId }
  }
}

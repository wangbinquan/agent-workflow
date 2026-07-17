// RFC-120 §15 — author a MANUAL question (自主新增).
//
// A human writes a title + instruction and (optionally) assigns a handler agent node;
// dispatching it later reruns that node with the instruction injected as External Feedback
// (no human-answer step). The board's "+ 新增问题" is the only entry (the per-card 复制
// prefill was removed 2026-07-02, 用户拍板). Per CLAUDE.md UI consistency it composes the
// shared primitives only: Dialog (chrome/footer) + Field/TextInput/TextArea (form) +
// Select (handler) — NO native modal/select/input chrome.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import type { ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { Field, TextArea, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { ErrorBanner } from '@/components/ErrorBanner'

export interface QuestionAuthorFormProps {
  open: boolean
  onClose: () => void
  taskId: string
  /** Agent node ids of the task's workflow (handler candidates), with labels. */
  nodeOptions: { id: string; label: string }[]
  /** Called after a successful create (the board invalidates its query separately). */
  onCreated?: (id: string) => void
}

interface CreatedResponse {
  ok: boolean
  id: string
}

const TITLE_MAX = 512
const BODY_MAX = 20000

export function QuestionAuthorForm({
  open,
  onClose,
  taskId,
  nodeOptions,
  onCreated,
}: QuestionAuthorFormProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [targetNodeId, setTargetNodeId] = useState('')

  // Reset the fields to empty whenever the dialog (re)opens.
  useEffect(() => {
    if (!open) return
    setTitle('')
    setBody('')
    setTargetNodeId('')
  }, [open])

  const create = useMutation<CreatedResponse, ApiError>({
    mutationFn: () =>
      api.post<CreatedResponse>(`/api/tasks/${taskId}/questions/manual`, {
        title: title.trim(),
        body: body.trim(),
        targetNodeId,
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['task-questions', taskId] })
      onCreated?.(res.id)
      onClose()
    },
  })

  // RFC-120 §15 — a manual question is always posed TO a node, so a handler is REQUIRED:
  // Save stays disabled until title, body AND a handler node are all chosen.
  const isInvalid =
    title.trim().length === 0 || body.trim().length === 0 || targetNodeId.length === 0
  const handlerOptions = nodeOptions.map((n) => ({ value: n.id, label: n.label }))

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (create.isPending) return
        onClose()
      }}
      title={t('taskQuestions.author.newTitle')}
      size="md"
      data-testid="question-author-form"
      footer={
        <>
          <button
            type="button"
            className="btn btn--sm"
            onClick={onClose}
            disabled={create.isPending}
            data-testid="question-author-cancel"
          >
            {t('taskQuestions.author.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => {
              if (isInvalid || create.isPending) return
              create.mutate()
            }}
            disabled={isInvalid || create.isPending}
            data-testid="question-author-save"
          >
            {t('taskQuestions.author.save')}
          </button>
        </>
      }
    >
      {create.error !== null && create.error !== undefined && (
        <ErrorBanner error={create.error} testid="question-author-error" />
      )}
      <Field label={t('taskQuestions.author.titleLabel')} required>
        <TextInput
          value={title}
          onChange={setTitle}
          placeholder={t('taskQuestions.author.titlePlaceholder')}
          maxLength={TITLE_MAX}
          disabled={create.isPending}
          data-testid="question-author-title"
        />
      </Field>
      <Field
        label={t('taskQuestions.author.bodyLabel')}
        hint={t('taskQuestions.author.bodyHint')}
        required
      >
        <TextArea
          value={body}
          onChange={setBody}
          rows={8}
          placeholder={t('taskQuestions.author.bodyPlaceholder')}
          maxLength={BODY_MAX}
          disabled={create.isPending}
          data-testid="question-author-body"
        />
      </Field>
      <Field
        label={t('taskQuestions.author.handlerLabel')}
        hint={t('taskQuestions.author.handlerHint')}
        required
      >
        <Select
          value={targetNodeId}
          onChange={setTargetNodeId}
          options={handlerOptions}
          placeholder={t('taskQuestions.author.handlerPlaceholder')}
          ariaLabel={t('taskQuestions.author.handlerLabel')}
        />
      </Field>
    </Dialog>
  )
}

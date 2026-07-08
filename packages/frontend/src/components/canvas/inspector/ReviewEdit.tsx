// RFC-005 — human review node config. inputSource is the (upstream, port)
// we'll snapshot into doc_versions; rerunnable lists are subsets of
// reachable upstream node ids (validator enforces). Comma-separated
// text input keeps the inspector light — we could swap to a multi-select
// chip picker in a polish pass. Extracted verbatim from the NodeInspector
// EditForm switch by RFC-146 T3.

import type { WorkflowNode } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field, Switch, TextArea, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { REVIEW_INPUT_HANDLE_ID, syncEdgeFromFormField } from '../connectionSync'
import { NodeTitleField } from './NodeTitleField'
import type { EditProps } from './types'

export function ReviewEdit({ node, definition, onPatch, onCommitDef }: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const inputSource = (rec.inputSource ?? {}) as Record<string, unknown> as {
    nodeId?: string
    portName?: string
  }
  const description = typeof rec.description === 'string' ? rec.description : ''
  const rerunnableOnReject = Array.isArray(rec.rerunnableOnReject)
    ? (rec.rerunnableOnReject as string[])
    : []
  const rerunnableOnIterate = Array.isArray(rec.rerunnableOnIterate)
    ? (rec.rerunnableOnIterate as string[])
    : []
  const rollbackFilesOnReject =
    typeof rec.rollbackFilesOnReject === 'boolean' ? rec.rollbackFilesOnReject : true
  const rollbackFilesOnIterate =
    typeof rec.rollbackFilesOnIterate === 'boolean' ? rec.rollbackFilesOnIterate : false
  const commentInjectTemplate =
    typeof rec.commentInjectTemplate === 'string' ? rec.commentInjectTemplate : ''

  // Candidate upstream node ids = every node in the workflow except this
  // one and any output sink. Validator enforces "subset of reachable
  // upstreams" — this dropdown is the friendly version.
  const upstreamCandidates = definition.nodes
    .filter((n) => n.id !== node.id && n.kind !== 'output')
    .map((n) => n.id)

  const patchReview = (delta: Record<string, unknown>): void =>
    onPatch({
      ...(node as Record<string, unknown>),
      ...delta,
    } as unknown as WorkflowNode)

  /**
   * RFC-007: changing inputSource via the form must keep the canvas
   * edge in lock-step. We rebuild the node + recompute edges in one
   * commit so the auto-save sees a consistent definition.
   */
  const patchReviewInputSource = (nextSource: { nodeId: string; portName: string }): void => {
    const prevSource = {
      nodeId: inputSource.nodeId ?? '',
      portName: inputSource.portName ?? '',
    }
    const nodes = definition.nodes.map((n) =>
      n.id === node.id
        ? ({
            ...(n as Record<string, unknown>),
            inputSource: nextSource,
          } as unknown as WorkflowNode)
        : n,
    )
    const nextDef = syncEdgeFromFormField(
      { ...definition, nodes },
      { nodeId: node.id, portName: REVIEW_INPUT_HANDLE_ID },
      prevSource,
      nextSource,
    )
    onCommitDef(nextDef)
  }

  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} />
      <Field
        label={t('inspector.fieldReviewDescription')}
        hint={t('inspector.fieldReviewDescriptionHint')}
      >
        <TextArea value={description} rows={2} onChange={(v) => patchReview({ description: v })} />
      </Field>
      <Field
        label={t('inspector.fieldReviewInputSourceNode')}
        hint={t('inspector.fieldReviewInputSourceNodeHint')}
        required
      >
        <Select<string>
          value={inputSource.nodeId ?? ''}
          ariaLabel={t('inspector.fieldReviewInputSourceNode')}
          onChange={(v) =>
            patchReviewInputSource({
              nodeId: v,
              portName: inputSource.portName ?? '',
            })
          }
          options={[
            { value: '', label: '—' },
            ...upstreamCandidates.map((id) => ({ value: id, label: id })),
          ]}
        />
      </Field>
      <Field
        label={t('inspector.fieldReviewInputSourcePort')}
        hint={t('inspector.fieldReviewInputSourcePortHint')}
        required
      >
        <TextInput
          value={inputSource.portName ?? ''}
          onChange={(v) =>
            patchReviewInputSource({ nodeId: inputSource.nodeId ?? '', portName: v })
          }
          placeholder="design"
        />
      </Field>
      <Field
        label={t('inspector.fieldReviewRerunReject')}
        hint={t('inspector.fieldReviewRerunRejectHint')}
      >
        <TextInput
          value={rerunnableOnReject.join(', ')}
          onChange={(v) =>
            patchReview({
              rerunnableOnReject: v
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0),
            })
          }
          placeholder={inputSource.nodeId ?? ''}
        />
      </Field>
      <Field
        label={t('inspector.fieldReviewRerunIterate')}
        hint={t('inspector.fieldReviewRerunIterateHint')}
      >
        <TextInput
          value={rerunnableOnIterate.join(', ')}
          onChange={(v) =>
            patchReview({
              rerunnableOnIterate: v
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0),
            })
          }
          placeholder={inputSource.nodeId ?? ''}
        />
      </Field>
      <Field label={t('inspector.fieldReviewRollbackReject')}>
        <Switch
          checked={rollbackFilesOnReject}
          onChange={(c) => patchReview({ rollbackFilesOnReject: c })}
          label={t('inspector.fieldReviewRollbackRejectLabel')}
        />
      </Field>
      <Field label={t('inspector.fieldReviewRollbackIterate')}>
        <Switch
          checked={rollbackFilesOnIterate}
          onChange={(c) => patchReview({ rollbackFilesOnIterate: c })}
          label={t('inspector.fieldReviewRollbackIterateLabel')}
        />
      </Field>
      <Field
        label={t('inspector.fieldReviewCommentTemplate')}
        hint={t('inspector.fieldReviewCommentTemplateHint')}
      >
        <TextArea
          value={commentInjectTemplate}
          rows={3}
          onChange={(v) => patchReview({ commentInjectTemplate: v })}
          placeholder=""
        />
      </Field>
    </div>
  )
}

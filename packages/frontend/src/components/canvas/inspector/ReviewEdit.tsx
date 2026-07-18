// RFC-005 — human review node config. inputSource is the (upstream, port)
// we'll snapshot into doc_versions; rerunnable lists are subsets of
// reachable upstream node ids (validator enforces). Comma-separated
// text input keeps the inspector light — we could swap to a multi-select
// chip picker in a polish pass. Extracted verbatim from the NodeInspector
// EditForm switch by RFC-146 T3.

import type { WorkflowNode } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { ChipsInput } from '@/components/ChipsInput'
import { Field, Switch, TextArea, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { REVIEW_INPUT_HANDLE_ID, syncEdgeFromFormField } from '../connectionSync'
import {
  atomicNodeInspectorChange,
  continuousNodeInspectorChange,
  InspectorHistoryBoundary,
  type InspectorChangeMeta,
} from './historyMeta'
import { NodeTitleField } from './NodeTitleField'
import type { EditProps } from './types'

export function ReviewEdit({
  node,
  definition,
  onPatch,
  onCommitDef,
  onHistoryBoundary,
}: EditProps) {
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

  const patchReview = (delta: Record<string, unknown>, meta: InspectorChangeMeta): void =>
    onPatch(
      {
        ...(node as Record<string, unknown>),
        ...delta,
      } as unknown as WorkflowNode,
      meta,
    )

  /**
   * RFC-007: changing inputSource via the form must keep the canvas
   * edge in lock-step. We rebuild the node + recompute edges in one
   * commit so the auto-save sees a consistent definition.
   */
  const patchReviewInputSource = (
    nextSource: { nodeId: string; portName: string },
    meta: InspectorChangeMeta,
  ): void => {
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
    onCommitDef(nextDef, meta)
  }

  const descriptionMeta = continuousNodeInspectorChange(
    node.id,
    'description',
    t('inspector.fieldReviewDescription'),
  )
  const inputPortMeta = continuousNodeInspectorChange(
    node.id,
    'inputSource.portName',
    t('inspector.fieldReviewInputSourcePort'),
  )
  const rerunRejectMeta = continuousNodeInspectorChange(
    node.id,
    'rerunnableOnReject',
    t('inspector.fieldReviewRerunReject'),
  )
  const rerunIterateMeta = continuousNodeInspectorChange(
    node.id,
    'rerunnableOnIterate',
    t('inspector.fieldReviewRerunIterate'),
  )
  const commentTemplateMeta = continuousNodeInspectorChange(
    node.id,
    'commentInjectTemplate',
    t('inspector.fieldReviewCommentTemplate'),
  )

  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
      <Field
        label={t('inspector.fieldReviewDescription')}
        hint={t('inspector.fieldReviewDescriptionHint')}
      >
        <InspectorHistoryBoundary meta={descriptionMeta} onBoundary={onHistoryBoundary}>
          <TextArea
            value={description}
            rows={2}
            onChange={(v) => patchReview({ description: v }, descriptionMeta)}
          />
        </InspectorHistoryBoundary>
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
            patchReviewInputSource(
              {
                nodeId: v,
                portName: inputSource.portName ?? '',
              },
              atomicNodeInspectorChange(
                node.id,
                'inputSource.nodeId',
                t('inspector.fieldReviewInputSourceNode'),
              ),
            )
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
        <InspectorHistoryBoundary meta={inputPortMeta} onBoundary={onHistoryBoundary}>
          <TextInput
            value={inputSource.portName ?? ''}
            onChange={(v) =>
              patchReviewInputSource(
                { nodeId: inputSource.nodeId ?? '', portName: v },
                inputPortMeta,
              )
            }
            placeholder="design"
          />
        </InspectorHistoryBoundary>
      </Field>
      <Field
        label={t('inspector.fieldReviewRerunReject')}
        hint={t('inspector.fieldReviewRerunRejectHint')}
      >
        <InspectorHistoryBoundary meta={rerunRejectMeta} onBoundary={onHistoryBoundary}>
          <ChipsInput
            value={rerunnableOnReject}
            onChange={(next) => patchReview({ rerunnableOnReject: next }, rerunRejectMeta)}
            validate={(token) =>
              upstreamCandidates.includes(token)
                ? null
                : t('inspector.fieldReviewRerunInvalid', { id: token })
            }
            placeholder={inputSource.nodeId ?? ''}
            testidPrefix="review-rerun-reject"
          />
        </InspectorHistoryBoundary>
      </Field>
      <Field
        label={t('inspector.fieldReviewRerunIterate')}
        hint={t('inspector.fieldReviewRerunIterateHint')}
      >
        <InspectorHistoryBoundary meta={rerunIterateMeta} onBoundary={onHistoryBoundary}>
          <ChipsInput
            value={rerunnableOnIterate}
            onChange={(next) => patchReview({ rerunnableOnIterate: next }, rerunIterateMeta)}
            validate={(token) =>
              upstreamCandidates.includes(token)
                ? null
                : t('inspector.fieldReviewRerunInvalid', { id: token })
            }
            placeholder={inputSource.nodeId ?? ''}
            testidPrefix="review-rerun-iterate"
          />
        </InspectorHistoryBoundary>
      </Field>
      <Field label={t('inspector.fieldReviewRollbackReject')}>
        <Switch
          checked={rollbackFilesOnReject}
          onChange={(c) =>
            patchReview(
              { rollbackFilesOnReject: c },
              atomicNodeInspectorChange(
                node.id,
                'rollbackFilesOnReject',
                t('inspector.fieldReviewRollbackReject'),
              ),
            )
          }
          label={t('inspector.fieldReviewRollbackRejectLabel')}
        />
      </Field>
      <Field label={t('inspector.fieldReviewRollbackIterate')}>
        <Switch
          checked={rollbackFilesOnIterate}
          onChange={(c) =>
            patchReview(
              { rollbackFilesOnIterate: c },
              atomicNodeInspectorChange(
                node.id,
                'rollbackFilesOnIterate',
                t('inspector.fieldReviewRollbackIterate'),
              ),
            )
          }
          label={t('inspector.fieldReviewRollbackIterateLabel')}
        />
      </Field>
      <Field
        label={t('inspector.fieldReviewCommentTemplate')}
        hint={t('inspector.fieldReviewCommentTemplateHint')}
      >
        <InspectorHistoryBoundary meta={commentTemplateMeta} onBoundary={onHistoryBoundary}>
          <TextArea
            value={commentInjectTemplate}
            rows={3}
            onChange={(v) => patchReview({ commentInjectTemplate: v }, commentTemplateMeta)}
            placeholder=""
          />
        </InspectorHistoryBoundary>
      </Field>
    </div>
  )
}

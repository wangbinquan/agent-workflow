// RFC-005 — human review node config. inputSource is the (upstream, port)
// we'll snapshot into doc_versions; rerunnable lists are subsets of
// reachable upstream node ids (validator enforces). Comma-separated
// text input keeps the inspector light — we could swap to a multi-select
// chip picker in a polish pass. Extracted verbatim from the NodeInspector
// EditForm switch by RFC-146 T3.

import type { WorkflowNode } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field, Switch, TextArea } from '@/components/Form'
import { MultiSelect } from '@/components/MultiSelect'
import { Select } from '@/components/Select'
import { buildNodeAgentLookup } from '@agent-workflow/shared'
import { computePorts } from '../WorkflowCanvas'
import { nodeTitle } from '../nodeTitle'
import {
  atomicNodeInspectorChange,
  continuousNodeInspectorChange,
  InspectorHistoryBoundary,
  type InspectorChangeMeta,
} from './historyMeta'
import { NodeTitleField } from './NodeTitleField'
import { InspectorFieldAnchor } from './InspectorFieldAnchor'
import { InspectorSection } from './InspectorSection'
import type { EditProps } from './types'

export function ReviewEdit({
  node,
  agents,
  definition,
  onPatch,
  onTransition,
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
  // RFC-223 (PR-3a impl-gate H3): id+name keyed so stamped nodes resolve by id.
  const agentByName = buildNodeAgentLookup(agents, (a) => a)
  const upstreamCandidates = definition.nodes
    .filter((n) => n.id !== node.id && n.kind !== 'output')
    .map((candidate) => ({
      id: candidate.id,
      title: nodeTitle(candidate),
      ports: computePorts(candidate, agentByName, definition).outputs,
    }))
  const selectedSource = upstreamCandidates.find(
    (candidate) => candidate.id === (inputSource.nodeId ?? ''),
  )
  const sourceNodeMissing = (inputSource.nodeId ?? '').length > 0 && selectedSource === undefined
  const sourcePortMissing =
    (inputSource.portName ?? '').length > 0 &&
    (selectedSource === undefined || !selectedSource.ports.includes(inputSource.portName ?? ''))
  const rerunnableOptions = upstreamCandidates.map((candidate) => ({
    value: candidate.id,
    label: candidate.title === candidate.id ? candidate.id : `${candidate.title} (${candidate.id})`,
  }))

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
    onTransition(
      { kind: 'set-review-input-source', reviewNodeId: node.id, inputSource: nextSource },
      meta,
    )
  }

  const descriptionMeta = continuousNodeInspectorChange(
    node.id,
    'description',
    t('inspector.fieldReviewDescription'),
  )
  const commentTemplateMeta = continuousNodeInspectorChange(
    node.id,
    'commentInjectTemplate',
    t('inspector.fieldReviewCommentTemplate'),
  )

  return (
    <div className="inspector-sections">
      <InspectorSection title={t('inspector.sectionBasics')}>
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
      </InspectorSection>
      <InspectorSection title={t('inspector.sectionFlow')}>
        <InspectorFieldAnchor nodeId={node.id} field="review-source">
          <div className="form-grid form-grid--two">
            <Field
              label={t('inspector.fieldReviewInputSourceNode')}
              hint={t('inspector.fieldReviewInputSourceNodeHint')}
              required
            >
              <Select<string>
                searchable
                className={sourceNodeMissing ? 'form-input--invalid' : undefined}
                value={inputSource.nodeId ?? ''}
                ariaLabel={t('inspector.fieldReviewInputSourceNode')}
                onChange={(nextNodeId) => {
                  const nextCandidate = upstreamCandidates.find(
                    (candidate) => candidate.id === nextNodeId,
                  )
                  patchReviewInputSource(
                    {
                      nodeId: nextNodeId,
                      portName:
                        nextCandidate?.ports.includes(inputSource.portName ?? '') === true
                          ? (inputSource.portName ?? '')
                          : '',
                    },
                    atomicNodeInspectorChange(
                      node.id,
                      'inputSource.nodeId',
                      t('inspector.fieldReviewInputSourceNode'),
                    ),
                  )
                }}
                options={[
                  { value: '', label: '—' },
                  ...rerunnableOptions,
                  ...(sourceNodeMissing
                    ? [
                        {
                          value: inputSource.nodeId ?? '',
                          label: t('inspector.missingOption', { value: inputSource.nodeId ?? '' }),
                        },
                      ]
                    : []),
                ]}
              />
            </Field>
            <Field
              label={t('inspector.fieldReviewInputSourcePort')}
              hint={t('inspector.fieldReviewInputSourcePortHint')}
              required
            >
              <Select<string>
                searchable
                className={sourcePortMissing ? 'form-input--invalid' : undefined}
                value={inputSource.portName ?? ''}
                ariaLabel={t('inspector.fieldReviewInputSourcePort')}
                disabled={(inputSource.nodeId ?? '').length === 0}
                onChange={(nextPortName) =>
                  patchReviewInputSource(
                    { nodeId: inputSource.nodeId ?? '', portName: nextPortName },
                    atomicNodeInspectorChange(
                      node.id,
                      'inputSource.portName',
                      t('inspector.fieldReviewInputSourcePort'),
                    ),
                  )
                }
                options={[
                  { value: '', label: '—' },
                  ...(selectedSource?.ports ?? []).map((portName) => ({
                    value: portName,
                    label: portName,
                  })),
                  ...(sourcePortMissing
                    ? [
                        {
                          value: inputSource.portName ?? '',
                          label: t('inspector.missingOption', {
                            value: inputSource.portName ?? '',
                          }),
                        },
                      ]
                    : []),
                ]}
              />
            </Field>
          </div>
        </InspectorFieldAnchor>
        <InspectorFieldAnchor nodeId={node.id} field="review-rerunnable-on-reject">
          <Field
            label={t('inspector.fieldReviewRerunReject')}
            hint={t('inspector.fieldReviewRerunRejectHint')}
          >
            <MultiSelect
              value={rerunnableOnReject}
              onChange={(next) =>
                patchReview(
                  { rerunnableOnReject: next },
                  atomicNodeInspectorChange(
                    node.id,
                    'rerunnableOnReject',
                    t('inspector.fieldReviewRerunReject'),
                  ),
                )
              }
              options={rerunnableOptions}
              ariaLabel={t('inspector.fieldReviewRerunReject')}
              placeholder={inputSource.nodeId ?? ''}
              data-testid="review-rerun-reject"
            />
          </Field>
        </InspectorFieldAnchor>
        <InspectorFieldAnchor nodeId={node.id} field="review-rerunnable-on-iterate">
          <Field
            label={t('inspector.fieldReviewRerunIterate')}
            hint={t('inspector.fieldReviewRerunIterateHint')}
          >
            <MultiSelect
              value={rerunnableOnIterate}
              onChange={(next) =>
                patchReview(
                  { rerunnableOnIterate: next },
                  atomicNodeInspectorChange(
                    node.id,
                    'rerunnableOnIterate',
                    t('inspector.fieldReviewRerunIterate'),
                  ),
                )
              }
              options={rerunnableOptions}
              ariaLabel={t('inspector.fieldReviewRerunIterate')}
              placeholder={inputSource.nodeId ?? ''}
              data-testid="review-rerun-iterate"
            />
          </Field>
        </InspectorFieldAnchor>
      </InspectorSection>
      <InspectorSection title={t('inspector.sectionAdvanced')} collapsed>
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
      </InspectorSection>
    </div>
  )
}

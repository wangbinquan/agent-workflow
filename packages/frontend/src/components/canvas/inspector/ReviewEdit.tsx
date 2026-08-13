// RFC-005 — human review node config. inputSource is the (upstream, port)
// we'll snapshot into doc_versions; rerunnable lists are subsets of
// reachable upstream node ids (validator enforces). The inspector exposes
// searchable, contract-aware selectors and keeps the source edge in lock-step.
// Extracted from the NodeInspector EditForm switch by RFC-146 T3.

import {
  buildNodeAgentLookup,
  isMultiDocReviewInput,
  isReviewableBodyKindString,
  resolveNodeAgent,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { useId, useRef } from 'react'
import { Field, Switch, TextArea } from '@/components/Form'
import { RuntimeParameterPicker } from '@/components/RuntimeParameterPicker'
import { buildRuntimeParameterCatalog } from '@/components/runtime-parameters/catalog'
import { MultiSelect } from '@/components/MultiSelect'
import { NoticeBanner, type NoticeBannerTone } from '@/components/NoticeBanner'
import { Select } from '@/components/Select'
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
import { MissingRefList } from './promptRefs'
import type { EditProps } from './types'

interface ReviewSourcePort {
  name: string
  kind: string
  reviewable: boolean
  multiDocument: boolean
}

interface ReviewSourceCandidate {
  id: string
  title: string
  nodeKind: WorkflowNode['kind']
  agentId?: string
  ports: ReviewSourcePort[]
  reviewablePorts: ReviewSourcePort[]
}

function collectReachableUpstreamIds(
  definition: EditProps['definition'],
  sourceNodeId: string,
): Set<string> {
  if (sourceNodeId === '') return new Set()
  const reverse = new Map<string, string[]>()
  for (const edge of definition.edges) {
    const incoming = reverse.get(edge.target.nodeId) ?? []
    incoming.push(edge.source.nodeId)
    reverse.set(edge.target.nodeId, incoming)
  }
  const reachable = new Set<string>([sourceNodeId])
  const queue = [sourceNodeId]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    for (const upstream of reverse.get(current) ?? []) {
      if (reachable.has(upstream)) continue
      reachable.add(upstream)
      queue.push(upstream)
    }
  }
  return reachable
}

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
  const commentTemplateRef = useRef<HTMLTextAreaElement | null>(null)
  const commentTemplateLabelId = useId()

  // Review input is not an arbitrary edge: runtime snapshots exactly one
  // agent output declared as markdownish. Keep invalid nodes/ports visible
  // (with a reason) so an old workflow is diagnosable, but only let authors
  // choose values accepted by the validator. RFC-223 keeps resolution id-only.
  const agentById = buildNodeAgentLookup(agents, (a) => a)
  const sourceCandidates: ReviewSourceCandidate[] = definition.nodes
    .filter((n) => n.id !== node.id && n.kind !== 'output')
    .map((candidate) => {
      const agent =
        candidate.kind === 'agent-single' ? resolveNodeAgent(candidate, agentById) : null
      const ports = computePorts(candidate, agentById, definition).outputs.map((name) => {
        const kind = agent?.outputKinds?.[name] ?? 'string'
        const multiDocument = isMultiDocReviewInput(kind)
        const reviewable = multiDocument || isReviewableBodyKindString(kind)
        return { name, kind, reviewable, multiDocument }
      })
      return {
        id: candidate.id,
        title: nodeTitle(candidate, agentById),
        nodeKind: candidate.kind,
        ...(agent === null || agent === undefined ? {} : { agentId: agent.id }),
        ports,
        reviewablePorts: ports.filter((port) => port.reviewable),
      }
    })
  const selectedSource = sourceCandidates.find(
    (candidate) => candidate.id === (inputSource.nodeId ?? ''),
  )
  const selectedPort = selectedSource?.ports.find(
    (port) => port.name === (inputSource.portName ?? ''),
  )
  const sourceNodeMissing =
    (inputSource.nodeId ?? '').length > 0 &&
    (selectedSource === undefined || selectedSource.reviewablePorts.length === 0)
  const sourcePortMissing =
    (inputSource.portName ?? '').length > 0 &&
    (selectedPort === undefined || !selectedPort.reviewable)
  const reviewSourceReady =
    selectedSource !== undefined &&
    selectedSource.reviewablePorts.length > 0 &&
    selectedPort?.reviewable === true
  const availableSourceCount = sourceCandidates.filter(
    (candidate) => candidate.reviewablePorts.length > 0,
  ).length
  const reachableRerunnableIds = collectReachableUpstreamIds(definition, inputSource.nodeId ?? '')
  const rerunnableOptions = sourceCandidates
    .filter((candidate) => reachableRerunnableIds.has(candidate.id))
    .map((candidate) => ({
      value: candidate.id,
      label:
        candidate.title === candidate.id ? candidate.id : `${candidate.title} (${candidate.id})`,
    }))

  const sourceOptions = sourceCandidates.map((candidate) => {
    let description: string
    if (candidate.nodeKind !== 'agent-single') {
      description = t('inspector.fieldReviewSourceNonAgent')
    } else if (candidate.agentId === undefined) {
      description = t('inspector.fieldReviewSourceAgentMissing')
    } else if (candidate.reviewablePorts.length === 0) {
      description = t('inspector.fieldReviewSourceNoMarkdown')
    } else {
      description = t('inspector.fieldReviewSourceAvailable', {
        ports: candidate.reviewablePorts.map((port) => `${port.name} · ${port.kind}`).join('；'),
      })
    }
    return {
      value: candidate.id,
      label:
        candidate.title === candidate.id ? candidate.id : `${candidate.title} (${candidate.id})`,
      description,
      disabled: candidate.reviewablePorts.length === 0,
      ...(candidate.reviewablePorts.length === 0
        ? {}
        : {
            badge: t('inspector.fieldReviewSourceCount', {
              count: candidate.reviewablePorts.length,
            }),
          }),
    }
  })
  const sourcePortOptions = (selectedSource?.ports ?? []).map((port) => ({
    value: port.name,
    label: port.name,
    badge: port.kind,
    badgeTone: port.reviewable ? ('neutral' as const) : ('attention' as const),
    disabled: !port.reviewable,
    description: port.reviewable
      ? t(port.multiDocument ? 'inspector.fieldReviewPortMulti' : 'inspector.fieldReviewPortSingle')
      : t('inspector.fieldReviewPortUnsupported', { kind: port.kind }),
  }))
  const guideTone: NoticeBannerTone = reviewSourceReady
    ? 'success'
    : availableSourceCount === 0 || sourceNodeMissing || sourcePortMissing
      ? 'warning'
      : 'info'
  const guideTitle = reviewSourceReady
    ? t('inspector.fieldReviewGuideReadyTitle')
    : availableSourceCount === 0
      ? t('inspector.fieldReviewGuideUnavailableTitle')
      : sourceNodeMissing || sourcePortMissing
        ? t('inspector.fieldReviewGuideInvalidTitle')
        : t('inspector.fieldReviewGuideEmptyTitle')
  const guideBody = reviewSourceReady
    ? t('inspector.fieldReviewGuideReadyBody', {
        source: selectedSource.title,
        port: selectedPort.name,
        kind: selectedPort.kind,
        mode: t(
          selectedPort.multiDocument
            ? 'inspector.fieldReviewModeMulti'
            : 'inspector.fieldReviewModeSingle',
        ),
      })
    : availableSourceCount === 0
      ? t('inspector.fieldReviewGuideUnavailableBody')
      : sourceNodeMissing || sourcePortMissing
        ? t('inspector.fieldReviewGuideInvalidBody')
        : t('inspector.fieldReviewGuideEmptyBody')
  const shouldOfferAgentConfig = availableSourceCount === 0 || sourceNodeMissing
  const agentConfigHref =
    selectedSource?.agentId === undefined
      ? '/agents'
      : `/agents/${encodeURIComponent(selectedSource.agentId)}`

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
  const commentTemplateLabel = t('inspector.fieldReviewCommentTemplate')
  const parameterCatalog = buildRuntimeParameterCatalog(
    {
      audience: 'workflow-inspector',
      surface: 'review-comment',
      t,
    },
    {
      local: [
        {
          id: `local:review:${node.id}:comments`,
          source: 'review-context',
          field: '__review_comments__',
          token: '{{__review_comments__}}',
          label: t('runtimeParameters.reviewCommentsLabel'),
          description: t('runtimeParameters.reviewCommentsDescription'),
        },
      ],
    },
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
      <InspectorSection title={t('inspector.sectionReviewInput')}>
        <NoticeBanner
          tone={guideTone}
          size="compact"
          title={guideTitle}
          testid="review-source-guide"
          action={
            shouldOfferAgentConfig ? (
              <a
                href={agentConfigHref}
                target="_blank"
                rel="noreferrer"
                className="btn btn--sm btn--ghost"
              >
                {t('inspector.fieldReviewConfigureAgentOutputs')}
                <span aria-hidden="true">↗</span>
              </a>
            ) : undefined
          }
        >
          {guideBody}
        </NoticeBanner>
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
                data-testid="review-source-node"
                onChange={(nextNodeId) => {
                  const nextCandidate = sourceCandidates.find(
                    (candidate) => candidate.id === nextNodeId,
                  )
                  const currentPort = inputSource.portName ?? ''
                  const nextReviewablePorts = nextCandidate?.reviewablePorts ?? []
                  const nextPortName = nextReviewablePorts.some((port) => port.name === currentPort)
                    ? currentPort
                    : nextReviewablePorts.length === 1
                      ? (nextReviewablePorts[0]?.name ?? '')
                      : ''
                  patchReviewInputSource(
                    {
                      nodeId: nextNodeId,
                      portName: nextPortName,
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
                  ...sourceOptions,
                  ...(selectedSource === undefined && (inputSource.nodeId ?? '').length > 0
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
                data-testid="review-source-port"
                disabled={
                  (inputSource.nodeId ?? '').length === 0 ||
                  selectedSource === undefined ||
                  selectedSource.reviewablePorts.length === 0
                }
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
                  ...sourcePortOptions,
                  ...(selectedPort === undefined && (inputSource.portName ?? '').length > 0
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
          label={commentTemplateLabel}
          hint={t('inspector.fieldReviewCommentTemplateHint')}
          group
          labelId={commentTemplateLabelId}
          action={
            <RuntimeParameterPicker
              authority="workflow:review-prompt"
              entries={parameterCatalog}
              target={{
                id: `${node.id}:commentInjectTemplate`,
                label: commentTemplateLabel,
                mode: 'insert-at-caret',
                value: commentInjectTemplate,
                revision: commentInjectTemplate,
                element: () => commentTemplateRef.current,
                commit: (next) =>
                  patchReview(
                    { commentInjectTemplate: next },
                    atomicNodeInspectorChange(
                      node.id,
                      'commentInjectTemplate',
                      commentTemplateLabel,
                    ),
                  ),
              }}
              testId="review-runtime-parameter-picker"
            />
          }
        >
          <InspectorHistoryBoundary meta={commentTemplateMeta} onBoundary={onHistoryBoundary}>
            <TextArea
              value={commentInjectTemplate}
              rows={3}
              onChange={(v) => patchReview({ commentInjectTemplate: v }, commentTemplateMeta)}
              textareaRef={commentTemplateRef}
              placeholder=""
              aria-labelledby={commentTemplateLabelId}
            />
          </InspectorHistoryBoundary>
          <MissingRefList template={commentInjectTemplate} inputPorts={['__review_comments__']} />
        </Field>
      </InspectorSection>
    </div>
  )
}

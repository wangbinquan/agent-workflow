import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import { StatusChip } from '@/components/StatusChip'

import type { EmployeeTypePackage, ToolRegistration, WorkIngress, WorkItem } from './types'
import { localized } from './types'

export interface ResponsibilityDispatchNode {
  key: string
  classifierWorkItemRef: string
  destinationWorkItemRef: string
  routeRef: string
  displayName: string
  priority: number
  configured: boolean
  detail: string
  attention?: boolean
  state?: 'configured' | 'missing' | 'neutral' | 'running' | 'failed' | 'completed' | 'waiting'
}

type ResponsibilityMapEntry =
  | { kind: 'item'; item: WorkItem }
  | { kind: 'ingress-branch'; item: WorkItem; ingresses: WorkIngress[] }
  | { kind: 'review-branch'; item: WorkItem; gate: ResponsibilityReviewGate }
  | { kind: 'dispatch'; node: ResponsibilityDispatchNode }
  | { kind: 'ingress'; ingress: WorkIngress }

type ResponsibilityMapLayoutEntry = {
  entry: ResponsibilityMapEntry
  auxiliary?: { column: number; row: number }
}

type ResponsibilityCardState = {
  state: 'configured' | 'missing' | 'neutral' | 'running' | 'failed' | 'completed' | 'waiting'
  detail: string
  compactDetail?: string
  attention?: boolean
}

export interface ResponsibilityReviewGate {
  parentWorkItemRef: string
  optionRef: string
  label: WorkItem['label']
  description: WorkItem['description']
}

export function ResponsibilitySwimlaneMap(props: {
  type: EmployeeTypePackage
  selectedWorkItemRef: string | null
  toolsByWorkItem?: Readonly<Record<string, ToolRegistration[]>>
  language: string
  onSelect: (workItemRef: string) => void
  title?: string
  description?: string
  legend?: string
  cardIdPrefix?: string
  attentionPulse?: number
  compactChrome?: boolean
  cardState?: (item: WorkItem) => ResponsibilityCardState
  reviewGateState?: (gate: ResponsibilityReviewGate) => ResponsibilityCardState
  onConfigureIngress?: (ingress: WorkIngress) => void
  onSelectReviewGate?: (gate: ResponsibilityReviewGate) => void
  selectedReviewOptionRef?: string | null
  dispatchNodes?: readonly ResponsibilityDispatchNode[]
  selectedDispatchNodeKey?: string | null
  onSelectDispatchNode?: (node: ResponsibilityDispatchNode) => void
  /** Highest-priority event-driven duty lane first. Spine lanes stay fixed. */
  lanePriorityOrder?: readonly string[]
  onLanePriorityOrderChange?: (order: string[]) => void
}): ReactElement {
  const zh = props.language.startsWith('zh')
  const [draggedLaneId, setDraggedLaneId] = useState<string | null>(null)
  const [dragTargetLaneId, setDragTargetLaneId] = useState<string | null>(null)
  const [dragPreviewOrder, setDragPreviewOrder] = useState<string[] | null>(null)
  const [dragTranslateY, setDragTranslateY] = useState(0)
  const mapElement = useRef<HTMLElement | null>(null)
  const laneElements = useRef(new Map<string, HTMLElement>())
  const previousLaneTops = useRef(new Map<string, number>())
  const dragPreviewOrderRef = useRef<string[] | null>(null)
  const dragTranslateYRef = useRef(0)
  const pointerDrag = useRef<{
    pointerId: number
    sourceLaneId: string
    grabOffsetY: number
    laneHeight: number
    moved: boolean
    slotTops: number[]
    slotBoundaries: number[]
  } | null>(null)
  const effectiveLanePriorityOrder = dragPreviewOrder ?? props.lanePriorityOrder ?? []
  const lanePrioritySignature = effectiveLanePriorityOrder.join('\u0000')
  useLayoutEffect(() => {
    const animateLaneReorder = () => {
      const nextTops = new Map<string, number>()
      for (const [laneId, element] of laneElements.current) {
        const runningAnimations = element.getAnimations()
        const visualTop = element.getBoundingClientRect().top
        for (const animation of runningAnimations) animation.cancel()
        const nextTop =
          laneId === draggedLaneId
            ? element.getBoundingClientRect().top - dragTranslateYRef.current
            : element.getBoundingClientRect().top
        nextTops.set(laneId, nextTop)
        const previousTop = previousLaneTops.current.get(laneId)
        const animationStartTop = runningAnimations.length > 0 ? visualTop : previousTop
        const delta = animationStartTop === undefined ? 0 : animationStartTop - nextTop
        const reducedMotion =
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (
          draggedLaneId !== null &&
          laneId !== draggedLaneId &&
          Math.abs(delta) > 0.5 &&
          !reducedMotion &&
          typeof element.animate === 'function'
        ) {
          element.animate(
            [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
            { duration: 120, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
          )
        }
      }
      previousLaneTops.current = nextTops
    }
    animateLaneReorder()
  }, [draggedLaneId, lanePrioritySignature])
  const workItemsByRef = new Map(
    props.type.authoringManifest.workItems.map((item) => [item.workItemRef, item]),
  )
  const reactionLaneIds = new Set(
    props.type.reactionRules.flatMap((rule) => {
      const item = workItemsByRef.get(rule.capabilityWorkItemRef ?? rule.workItemRef)
      return item?.responsibilityLaneId == null ? [] : [item.responsibilityLaneId]
    }),
  )
  const fanOutDestinationRefs = new Set(
    props.type.authoringManifest.workItems.flatMap((source) =>
      (source.orderedDispatchAuthoring?.destinationWorkItemRefs ?? []).filter(
        (destinationRef) => workItemsByRef.get(destinationRef)?.nodeKind === 'business-tool',
      ),
    ),
  )
  const regions = [...props.type.authoringManifest.lifecycleRegions].sort(
    (left, right) => left.order - right.order,
  )
  const previewPriorityIndex = (sourceLaneId: string, targetIndex: number) => {
    const currentOrder = dragPreviewOrderRef.current ?? props.lanePriorityOrder ?? []
    const nextOrder = currentOrder.filter((laneId) => laneId !== sourceLaneId)
    nextOrder.splice(Math.max(0, Math.min(targetIndex, nextOrder.length)), 0, sourceLaneId)
    if (nextOrder.every((laneId, index) => laneId === currentOrder[index])) return
    dragPreviewOrderRef.current = nextOrder
    setDragTargetLaneId(sourceLaneId)
    setDragPreviewOrder(nextOrder)
  }
  const updatePointerDrag = (sourceLaneId: string, clientY: number) => {
    const session = pointerDrag.current
    if (session === null || session.sourceLaneId !== sourceLaneId) return
    session.moved = true
    const draggedCenterY = clientY - session.grabOffsetY + session.laneHeight / 2
    let targetIndex = session.slotBoundaries.findIndex((boundary) => draggedCenterY < boundary)
    if (targetIndex < 0) targetIndex = session.slotTops.length - 1
    const nextTranslateY =
      clientY - session.grabOffsetY - (session.slotTops[targetIndex] ?? session.slotTops[0] ?? 0)
    dragTranslateYRef.current = nextTranslateY
    setDragTranslateY(nextTranslateY)
    previewPriorityIndex(sourceLaneId, targetIndex)
  }
  const finishPriorityDrag = (commit: boolean) => {
    const finalOrder = dragPreviewOrderRef.current
    if (commit && finalOrder !== null) props.onLanePriorityOrderChange?.([...finalOrder])
    pointerDrag.current = null
    dragPreviewOrderRef.current = null
    setDraggedLaneId(null)
    setDragTargetLaneId(null)
    setDragPreviewOrder(null)
    dragTranslateYRef.current = 0
    setDragTranslateY(0)
  }
  const shiftPriorityLane = (laneId: string, delta: -1 | 1) => {
    const order = [...(props.lanePriorityOrder ?? [])]
    const sourceIndex = order.indexOf(laneId)
    const targetIndex = sourceIndex + delta
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= order.length) return
    ;[order[sourceIndex], order[targetIndex]] = [order[targetIndex]!, order[sourceIndex]!]
    props.onLanePriorityOrderChange?.(order)
  }
  const nodeKind = (item: WorkItem): { label: string; className: string } =>
    item.nodeKind === 'business-tool'
      ? { label: zh ? '工具' : 'Tool', className: 'tool' }
      : item.nodeKind === 'system'
        ? { label: zh ? '平台' : 'Platform', className: 'platform' }
        : { label: zh ? '协同' : 'Collaboration', className: 'collaboration' }
  const workItemPresentation = (item: WorkItem) => {
    const kind = nodeKind(item)
    const fanOut = fanOutDestinationRefs.has(item.workItemRef)
    const state = props.cardState?.(item)
    const availableTools = (props.toolsByWorkItem?.[item.workItemRef] ?? []).filter(
      (tool) => tool.state === 'published',
    ).length
    const nextLabels = item.nextWorkItemRefs
      .map((ref) => workItemsByRef.get(ref))
      .filter((next): next is WorkItem => next !== undefined)
      .map((next) => localized(next.label, props.language))
    const detail =
      state?.detail ??
      (item.nodeKind === 'business-tool'
        ? availableTools > 0
          ? zh
            ? `${availableTools} 个可用工具`
            : `${availableTools} available tool${availableTools === 1 ? '' : 's'}`
          : zh
            ? '尚未配置工具'
            : 'No tool configured'
        : item.nodeKind === 'system'
          ? zh
            ? '平台按固定规则执行'
            : 'Platform fixed rule'
          : zh
            ? '调起并等待其他员工'
            : 'Invoke and await employees')
    const compactDetail =
      state?.compactDetail ??
      (item.nodeKind === 'business-tool'
        ? availableTools > 0
          ? zh
            ? `${availableTools} 个工具`
            : `${availableTools} tool${availableTools === 1 ? '' : 's'}`
          : zh
            ? '未配置'
            : 'Missing'
        : item.nodeKind === 'system'
          ? zh
            ? '固定'
            : 'Fixed'
          : zh
            ? '等待'
            : 'Await')
    const next =
      nextLabels.length === 0
        ? zh
          ? '完成后等待事件或结束'
          : 'Then wait for an event or finish'
        : `${zh ? '下一步' : 'Next'}：${nextLabels.join(' / ')}`
    return { kind, fanOut, state, detail, compactDetail, next }
  }

  return (
    <section
      ref={mapElement}
      className={`employee-toolbox-map${props.compactChrome === true ? ' employee-toolbox-map--compact' : ''}`}
      aria-label={zh ? '确定性职责全景' : 'Deterministic responsibility map'}
      data-testid="employee-toolbox-responsibility-map"
      onPointerMove={(event) => {
        const session = pointerDrag.current
        if (session === null || session.pointerId !== event.pointerId) return
        event.preventDefault()
        updatePointerDrag(session.sourceLaneId, event.clientY)
      }}
      onPointerUp={(event) => {
        const session = pointerDrag.current
        if (session === null || session.pointerId !== event.pointerId) return
        event.preventDefault()
        if (!session.moved) updatePointerDrag(session.sourceLaneId, event.clientY)
        finishPriorityDrag(true)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onPointerCancel={(event) => {
        if (pointerDrag.current?.pointerId !== event.pointerId) return
        finishPriorityDrag(false)
      }}
      onLostPointerCapture={(event) => {
        if (pointerDrag.current?.pointerId !== event.pointerId) return
        finishPriorityDrag(false)
      }}
    >
      {props.compactChrome === true ? null : (
        <header className="employee-toolbox-map__header">
          <div>
            <h2>{props.title ?? (zh ? '确定性职责全景' : 'Deterministic responsibility map')}</h2>
            <p>
              {props.description ??
                (zh
                  ? '生命周期固定、职责按泳道一屏展开。点击卡片，在弹窗中查看输入输出并配置该职责。'
                  : 'The lifecycle is fixed and every duty is arranged in a one-screen swimlane view. Select a card to configure it in a dialog.')}
            </p>
          </div>
          <span>
            {props.legend ??
              (zh ? '从左到右执行 · 无需拖线' : 'Runs left to right · no edge editing')}
          </span>
        </header>
      )}

      <div className="employee-toolbox-map__regions">
        {regions.map((region, regionIndex) => {
          const declaredLanes = [...region.responsibilityLanes].sort(
            (left, right) => left.order - right.order,
          )
          const absorbedLaneIds = new Set(
            declaredLanes
              .filter(
                (lane) =>
                  lane.kind === 'branch' && !lane.optional && !reactionLaneIds.has(lane.laneId),
              )
              .map((lane) => lane.laneId),
          )
          const lanes = declaredLanes
            .filter((lane) => !absorbedLaneIds.has(lane.laneId))
            .sort((left, right) => {
              if (left.kind !== right.kind) return left.kind === 'spine' ? -1 : 1
              const leftPriority = effectiveLanePriorityOrder.indexOf(left.laneId)
              const rightPriority = effectiveLanePriorityOrder.indexOf(right.laneId)
              if (leftPriority >= 0 && rightPriority >= 0) return leftPriority - rightPriority
              if (leftPriority >= 0) return -1
              if (rightPriority >= 0) return 1
              return left.order - right.order
            })
          return (
            <section
              key={region.regionId}
              className={`employee-toolbox-region employee-toolbox-region--${lanes.length > 1 ? 'branching' : 'single-lane'}`}
            >
              <header>
                <span className="employee-toolbox-region__phase">
                  {zh ? `阶段 ${regionIndex + 1}` : `Phase ${regionIndex + 1}`}
                </span>
                <div>
                  <strong>{localized(region.label, props.language)}</strong>
                  <p>{localized(region.description, props.language)}</p>
                </div>
              </header>
              <div className="employee-toolbox-region__lanes">
                {lanes.map((lane) => {
                  const includedLaneIds =
                    lane.kind === 'spine'
                      ? new Set([lane.laneId, ...absorbedLaneIds])
                      : new Set([lane.laneId])
                  const items = props.type.authoringManifest.workItems
                    .filter(
                      (item) =>
                        item.regionId === region.regionId &&
                        item.responsibilityLaneId !== null &&
                        includedLaneIds.has(item.responsibilityLaneId),
                    )
                    .sort((left, right) => left.order - right.order)
                  const ingresses = props.type.authoringManifest.workIngresses
                    .filter(
                      (ingress) =>
                        ingress.regionId === region.regionId &&
                        includedLaneIds.has(ingress.responsibilityLaneId),
                    )
                    .sort((left, right) => left.order - right.order)
                  if (items.length === 0 && ingresses.length === 0) return null
                  const itemRefs = new Set(items.map((item) => item.workItemRef))
                  const laneDispatchNodes = (props.dispatchNodes ?? []).filter((node) =>
                    itemRefs.has(node.classifierWorkItemRef),
                  )
                  const replacedDestinationRefs = new Set(
                    laneDispatchNodes
                      .filter((node) => itemRefs.has(node.destinationWorkItemRef))
                      .map((node) => node.destinationWorkItemRef),
                  )
                  const ingressesByTarget = new Map<string, WorkIngress[]>()
                  for (const ingress of ingresses) {
                    const current = ingressesByTarget.get(ingress.nextWorkItemRef) ?? []
                    current.push(ingress)
                    ingressesByTarget.set(ingress.nextWorkItemRef, current)
                  }
                  const primaryEntryBuckets: Array<{
                    order: number
                    identity: string
                    entries: ResponsibilityMapEntry[]
                  }> = items.map((item) => ({
                    order: item.order,
                    identity: item.workItemRef,
                    entries: replacedDestinationRefs.has(item.workItemRef)
                      ? []
                      : [
                          item.humanReview === null
                            ? (ingressesByTarget.get(item.workItemRef)?.length ?? 0) > 0
                              ? {
                                  kind: 'ingress-branch' as const,
                                  item,
                                  ingresses: ingressesByTarget.get(item.workItemRef)!,
                                }
                              : { kind: 'item' as const, item }
                            : {
                                kind: 'review-branch' as const,
                                item,
                                gate: {
                                  parentWorkItemRef: item.workItemRef,
                                  optionRef: item.humanReview.optionRef,
                                  label: item.humanReview.label,
                                  description: item.humanReview.description,
                                },
                              },
                          ...laneDispatchNodes
                            .filter((node) => node.classifierWorkItemRef === item.workItemRef)
                            .map((node) => ({ kind: 'dispatch' as const, node })),
                        ],
                  }))
                  const primaryEntries = primaryEntryBuckets
                    .sort(
                      (left, right) =>
                        left.order - right.order || left.identity.localeCompare(right.identity),
                    )
                    .flatMap((entry) => entry.entries)
                  const laneColumns = Math.max(1, Math.min(primaryEntries.length, 4))
                  const hasParallelIngressBranch = primaryEntries.some(
                    (entry) => entry.kind === 'ingress-branch' && entry.ingresses.length > 1,
                  )
                  const laneTemplateColumns = hasParallelIngressBranch
                    ? [
                        '224px',
                        ...Array.from({ length: laneColumns - 1 }, () => 'minmax(0, 168px)'),
                      ].join(' ')
                    : undefined
                  const primaryColumnByWorkItem = new Map<string, number>()
                  primaryEntries.forEach((entry, index) => {
                    if (
                      entry.kind === 'item' ||
                      entry.kind === 'ingress-branch' ||
                      entry.kind === 'review-branch'
                    ) {
                      primaryColumnByWorkItem.set(entry.item.workItemRef, (index % laneColumns) + 1)
                    }
                  })
                  const groupedIngressRefs = new Set(
                    primaryEntries.flatMap((entry) =>
                      entry.kind === 'ingress-branch'
                        ? entry.ingresses.map((ingress) => ingress.ingressRef)
                        : [],
                    ),
                  )
                  const auxiliaryDrafts = [
                    ...ingresses
                      .filter((ingress) => !groupedIngressRefs.has(ingress.ingressRef))
                      .map((ingress) => ({
                        order: ingress.order,
                        identity: `ingress:${ingress.ingressRef}`,
                        targetWorkItemRef: ingress.nextWorkItemRef,
                        entry: { kind: 'ingress' as const, ingress },
                      })),
                  ].sort(
                    (left, right) =>
                      left.order - right.order || left.identity.localeCompare(right.identity),
                  )
                  const firstAuxiliaryRow = Math.ceil(primaryEntries.length / laneColumns) + 1
                  const auxiliaryOffsetByTarget = new Map<string, number>()
                  const entries: ResponsibilityMapLayoutEntry[] = [
                    ...primaryEntries.map((entry) => ({ entry })),
                    ...auxiliaryDrafts.map((draft) => {
                      const targetColumn = primaryColumnByWorkItem.get(draft.targetWorkItemRef) ?? 1
                      const offset = auxiliaryOffsetByTarget.get(draft.targetWorkItemRef) ?? 0
                      auxiliaryOffsetByTarget.set(draft.targetWorkItemRef, offset + 1)
                      const absoluteColumn = targetColumn - 1 + offset
                      return {
                        entry: draft.entry,
                        auxiliary: {
                          column: (absoluteColumn % laneColumns) + 1,
                          row: firstAuxiliaryRow + Math.floor(absoluteColumn / laneColumns),
                        },
                      }
                    }),
                  ]
                  const lanePriority = effectiveLanePriorityOrder.indexOf(lane.laneId)
                  const laneSortable =
                    lanePriority >= 0 && props.onLanePriorityOrderChange !== undefined
                  const renderIngressCard = (
                    ingress: WorkIngress,
                    options: {
                      auxiliary?: ResponsibilityMapLayoutEntry['auxiliary']
                      sourceNode?: boolean
                    } = {},
                  ) => {
                    const nextItem = workItemsByRef.get(ingress.nextWorkItemRef)
                    const next =
                      nextItem === undefined
                        ? ingress.nextWorkItemRef
                        : localized(nextItem.label, props.language)
                    const action =
                      ingress.configurationSurface === 'task-creation'
                        ? zh
                          ? '去新建任务'
                          : 'Create task'
                        : zh
                          ? '去 Webhook 配置'
                          : 'Configure Webhook'
                    return (
                      <button
                        key={`ingress:${ingress.ingressRef}`}
                        id={`${props.cardIdPrefix ?? 'toolbox-duty'}-ingress-${ingress.ingressRef}`}
                        data-work-ingress-ref={ingress.ingressRef}
                        data-next-work-item-ref={ingress.nextWorkItemRef}
                        type="button"
                        className={`employee-toolbox-card employee-toolbox-card--ingress ${
                          options.sourceNode === true
                            ? 'employee-toolbox-card--source-node'
                            : 'employee-toolbox-card--auxiliary'
                        }`}
                        style={
                          options.sourceNode === true
                            ? undefined
                            : ({
                                '--employee-aux-column': options.auxiliary?.column ?? 1,
                                '--employee-aux-row': options.auxiliary?.row ?? 1,
                              } as CSSProperties)
                        }
                        aria-label={`${localized(ingress.label, props.language)} · ${localized(ingress.valueLabel, props.language)} · ${action} · ${zh ? '下一步' : 'Next'}：${next}`}
                        title={localized(ingress.description, props.language)}
                        onClick={() => props.onConfigureIngress?.(ingress)}
                      >
                        <span className="employee-toolbox-card__kind">
                          {localized(ingress.valueLabel, props.language)}
                        </span>
                        <strong>{localized(ingress.label, props.language)}</strong>
                        {options.sourceNode === true ? null : (
                          <small title={action}>{`→ ${next}`}</small>
                        )}
                      </button>
                    )
                  }
                  return (
                    <section
                      key={lane.laneId}
                      ref={(element) => {
                        if (element === null) laneElements.current.delete(lane.laneId)
                        else laneElements.current.set(lane.laneId, element)
                      }}
                      className={`employee-toolbox-lane employee-toolbox-lane--${lane.kind}${
                        hasParallelIngressBranch ? ' employee-toolbox-lane--parallel-ingress' : ''
                      }${draggedLaneId === lane.laneId ? ' employee-toolbox-lane--dragging' : ''}${
                        dragTargetLaneId === lane.laneId
                          ? ' employee-toolbox-lane--drop-target'
                          : ''
                      }`}
                      style={
                        draggedLaneId === lane.laneId
                          ? ({
                              '--employee-lane-drag-offset': `${dragTranslateY}px`,
                              transform: `translate3d(0, ${dragTranslateY}px, 0)`,
                            } as CSSProperties)
                          : undefined
                      }
                      data-lane-id={lane.laneId}
                      aria-label={`${localized(lane.label, props.language)}：${localized(lane.description, props.language)}`}
                      title={localized(lane.description, props.language)}
                    >
                      <header>
                        <div>
                          <div className="employee-toolbox-lane__meta">
                            <span className="employee-toolbox-lane__eyebrow">
                              {lane.kind === 'spine'
                                ? zh
                                  ? '主泳道'
                                  : 'Main lane'
                                : zh
                                  ? '职责泳道'
                                  : 'Duty lane'}
                            </span>
                            {lane.optional ? (
                              <StatusChip kind="neutral" size="sm">
                                {zh ? '可选能力' : 'Optional'}
                              </StatusChip>
                            ) : null}
                            {lanePriority >= 0 ? (
                              <span
                                className="employee-toolbox-lane__priority"
                                title={zh ? '事件处理优先级' : 'Event handling priority'}
                              >
                                P{lanePriority + 1}
                              </span>
                            ) : null}
                          </div>
                          <strong>{localized(lane.label, props.language)}</strong>
                        </div>
                        {laneSortable ? (
                          <button
                            type="button"
                            className="employee-toolbox-lane__drag-handle"
                            aria-label={
                              zh
                                ? `拖动“${localized(lane.label, props.language)}”调整事件优先级`
                                : `Drag “${localized(lane.label, props.language)}” to change event priority`
                            }
                            title={
                              zh
                                ? '拖动排序；也可用上下方向键'
                                : 'Drag to reorder; arrow keys also work'
                            }
                            onClick={(event) => event.preventDefault()}
                            onPointerDown={(event) => {
                              if (event.button !== 0) return
                              event.preventDefault()
                              const order = [...(props.lanePriorityOrder ?? [])]
                              for (const laneId of order) {
                                const element = laneElements.current.get(laneId)
                                for (const animation of element?.getAnimations() ?? []) {
                                  animation.cancel()
                                }
                              }
                              const source = laneElements.current.get(lane.laneId)
                              const slotRects = order
                                .flatMap((laneId) => {
                                  const element = laneElements.current.get(laneId)
                                  return element === undefined
                                    ? []
                                    : [element.getBoundingClientRect()]
                                })
                                .sort((left, right) => left.top - right.top)
                              if (source === undefined || slotRects.length !== order.length) return
                              const sourceRect = source.getBoundingClientRect()
                              const slotCenters = slotRects.map(
                                (rect) => rect.top + rect.height / 2,
                              )
                              pointerDrag.current = {
                                pointerId: event.pointerId,
                                sourceLaneId: lane.laneId,
                                grabOffsetY: event.clientY - sourceRect.top,
                                laneHeight: sourceRect.height,
                                moved: false,
                                slotTops: slotRects.map((rect) => rect.top),
                                slotBoundaries: slotCenters
                                  .slice(0, -1)
                                  .map((center, index) => (center + slotCenters[index + 1]!) / 2),
                              }
                              dragPreviewOrderRef.current = order
                              setDraggedLaneId(lane.laneId)
                              setDragTargetLaneId(null)
                              setDragPreviewOrder(order)
                              setDragTranslateY(0)
                              mapElement.current?.setPointerCapture(event.pointerId)
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                              event.preventDefault()
                              shiftPriorityLane(lane.laneId, event.key === 'ArrowUp' ? -1 : 1)
                            }}
                          >
                            <span aria-hidden="true">⠿</span>
                          </button>
                        ) : null}
                      </header>
                      <span className="employee-toolbox-lane__axis" aria-hidden="true">
                        <span />
                      </span>
                      <div
                        className="employee-toolbox-lane__cards"
                        style={
                          {
                            '--employee-lane-columns': laneColumns,
                            '--employee-lane-template': laneTemplateColumns,
                          } as CSSProperties
                        }
                      >
                        {entries.map(({ entry, auxiliary }, itemIndex) => {
                          if (entry.kind === 'ingress') {
                            return renderIngressCard(entry.ingress, { auxiliary })
                          }
                          if (entry.kind === 'ingress-branch') {
                            const item = entry.item
                            const { kind, fanOut, state, detail, compactDetail, next } =
                              workItemPresentation(item)
                            const selected =
                              item.workItemRef === props.selectedWorkItemRef &&
                              props.selectedReviewOptionRef == null
                            return (
                              <div
                                key={`ingress-branch:${item.workItemRef}`}
                                className={`employee-toolbox-ingress-branch${
                                  itemIndex > 0 && itemIndex % laneColumns === 0
                                    ? ' employee-toolbox-ingress-branch--row-start'
                                    : ''
                                }`}
                                data-ingress-branch-work-item-ref={item.workItemRef}
                                aria-label={
                                  zh
                                    ? `工作来源汇聚到${localized(item.label, props.language)}`
                                    : `Work sources converge on ${localized(item.label, props.language)}`
                                }
                              >
                                <div className="employee-toolbox-ingress-branch__sources">
                                  {entry.ingresses.map((ingress) =>
                                    renderIngressCard(ingress, { sourceNode: true }),
                                  )}
                                </div>
                                <span
                                  className="employee-toolbox-ingress-branch__merge"
                                  aria-hidden="true"
                                >
                                  <span />
                                </span>
                                <button
                                  id={`${props.cardIdPrefix ?? 'toolbox-duty'}-${item.workItemRef}`}
                                  data-work-item-ref={item.workItemRef}
                                  type="button"
                                  className={`employee-toolbox-card employee-toolbox-card--${kind.className}${
                                    state === undefined
                                      ? ''
                                      : ` employee-toolbox-card--${state.state}`
                                  }${fanOut ? ' employee-toolbox-card--fan-out' : ''}${
                                    state?.attention === true
                                      ? ' employee-toolbox-card--attention'
                                      : ''
                                  }${selected ? ' employee-toolbox-card--active' : ''}`}
                                  aria-pressed={selected}
                                  aria-label={`${localized(item.label, props.language)} · ${kind.label} · ${detail} · ${next}`}
                                  title={localized(item.description, props.language)}
                                  onClick={() => props.onSelect(item.workItemRef)}
                                >
                                  <span className="employee-toolbox-card__kind">{kind.label}</span>
                                  <strong>{localized(item.label, props.language)}</strong>
                                  <small title={detail}>{compactDetail}</small>
                                  <span className="sr-only">{next}</span>
                                </button>
                              </div>
                            )
                          }
                          if (entry.kind === 'review-branch') {
                            const item = entry.item
                            const gate = entry.gate
                            const { kind, fanOut, state, detail, compactDetail, next } =
                              workItemPresentation(item)
                            const gateState = props.reviewGateState?.(gate)
                            const gateSelected =
                              props.selectedWorkItemRef === gate.parentWorkItemRef &&
                              props.selectedReviewOptionRef === gate.optionRef
                            const itemSelected =
                              props.selectedWorkItemRef === item.workItemRef &&
                              props.selectedReviewOptionRef == null
                            const gateDetail =
                              gateState?.detail ??
                              (zh ? '可选，任务发起时决定' : 'Optional; decided when work starts')
                            const beforeReviewLabel = localized(
                              item.humanReview?.reviewedPath?.beforeReviewLabel ?? {
                                'zh-CN': '分析',
                                'en-US': 'Analyze',
                              },
                              props.language,
                            )
                            const afterApprovalLabel = localized(
                              item.humanReview?.reviewedPath?.afterApprovalLabel ?? {
                                'zh-CN': '实现',
                                'en-US': 'Implement',
                              },
                              props.language,
                            )
                            const selectItem = () => props.onSelect(item.workItemRef)
                            return (
                              <div
                                key={`review-branch:${item.workItemRef}`}
                                className={`employee-toolbox-review-branch${
                                  itemIndex > 0 && itemIndex % laneColumns === 0
                                    ? ' employee-toolbox-review-branch--row-start'
                                    : ''
                                }`}
                                data-review-branch-work-item-ref={item.workItemRef}
                                aria-label={
                                  zh
                                    ? `${localized(item.label, props.language)}的审核分支`
                                    : `Review branches for ${localized(item.label, props.language)}`
                                }
                              >
                                <div className="employee-toolbox-review-branch__path">
                                  <span className="employee-toolbox-review-branch__label">
                                    {zh ? '不启用审核' : 'No review'}
                                  </span>
                                  <button
                                    id={`${props.cardIdPrefix ?? 'toolbox-duty'}-${item.workItemRef}`}
                                    data-work-item-ref={item.workItemRef}
                                    type="button"
                                    className={`employee-toolbox-card employee-toolbox-card--${kind.className}${
                                      state === undefined
                                        ? ''
                                        : ` employee-toolbox-card--${state.state}`
                                    }${fanOut ? ' employee-toolbox-card--fan-out' : ''}${
                                      state?.attention === true
                                        ? ' employee-toolbox-card--attention'
                                        : ''
                                    }${itemSelected ? ' employee-toolbox-card--active' : ''}`}
                                    aria-pressed={itemSelected}
                                    aria-label={`${localized(item.label, props.language)} · ${zh ? '不启用审核' : 'No review'} · ${kind.label} · ${detail} · ${next}`}
                                    title={localized(item.description, props.language)}
                                    onClick={selectItem}
                                  >
                                    <span className="employee-toolbox-card__kind">
                                      {kind.label}
                                    </span>
                                    <strong>{localized(item.label, props.language)}</strong>
                                    <small title={detail}>{compactDetail}</small>
                                  </button>
                                </div>
                                <div className="employee-toolbox-review-branch__path">
                                  <span className="employee-toolbox-review-branch__label">
                                    {zh ? '启用审核' : 'Review enabled'}
                                  </span>
                                  <div className="employee-toolbox-review-branch__reviewed-flow">
                                    <button
                                      type="button"
                                      className="employee-toolbox-card employee-toolbox-card--review-stage"
                                      data-review-stage="analysis"
                                      aria-label={`${beforeReviewLabel} · ${localized(item.description, props.language)}`}
                                      title={localized(item.description, props.language)}
                                      onClick={selectItem}
                                    >
                                      <strong>{beforeReviewLabel}</strong>
                                    </button>
                                    <button
                                      id={`${props.cardIdPrefix ?? 'toolbox-duty'}-review-${gate.optionRef}`}
                                      data-review-option-ref={gate.optionRef}
                                      type="button"
                                      className={`employee-toolbox-card employee-toolbox-card--human-gate employee-toolbox-card--review-stage${
                                        gateState === undefined
                                          ? ''
                                          : ` employee-toolbox-card--${gateState.state}`
                                      }${
                                        gateState?.attention === true
                                          ? ' employee-toolbox-card--attention'
                                          : ''
                                      }${gateSelected ? ' employee-toolbox-card--active' : ''}`}
                                      aria-pressed={gateSelected}
                                      aria-label={`${localized(gate.label, props.language)} · ${zh ? '人工门禁' : 'Human gate'} · ${gateDetail}`}
                                      title={`${localized(gate.description, props.language)} · ${gateDetail}`}
                                      onClick={() => {
                                        if (props.onSelectReviewGate === undefined) {
                                          props.onSelect(gate.parentWorkItemRef)
                                        } else {
                                          props.onSelectReviewGate(gate)
                                        }
                                      }}
                                    >
                                      <strong>{localized(gate.label, props.language)}</strong>
                                    </button>
                                    <button
                                      type="button"
                                      className="employee-toolbox-card employee-toolbox-card--review-stage"
                                      data-review-stage="implementation"
                                      aria-label={`${afterApprovalLabel} · ${localized(item.description, props.language)}`}
                                      title={localized(item.description, props.language)}
                                      onClick={selectItem}
                                    >
                                      <strong>{afterApprovalLabel}</strong>
                                    </button>
                                  </div>
                                </div>
                                <span className="sr-only">{next}</span>
                              </div>
                            )
                          }
                          if (entry.kind === 'dispatch') {
                            const node = entry.node
                            const destination = workItemsByRef.get(node.destinationWorkItemRef)
                            const kind =
                              destination === undefined
                                ? { label: zh ? '工具' : 'Tool', className: 'tool' }
                                : nodeKind(destination)
                            const selected = props.selectedDispatchNodeKey === node.key
                            const displayName =
                              node.displayName.trim() ||
                              node.routeRef.trim() ||
                              (zh ? '未命名错误类型' : 'Unnamed failure type')
                            return (
                              <button
                                key={`${node.key}:${node.attention === true ? (props.attentionPulse ?? 0) : 0}`}
                                id={`${props.cardIdPrefix ?? 'toolbox-duty'}-dispatch-${node.key}`}
                                data-dispatch-route-key={node.key}
                                type="button"
                                className={`employee-toolbox-card employee-toolbox-card--${kind.className} employee-toolbox-card--${node.state ?? (node.configured ? 'configured' : 'missing')}${
                                  node.attention === true ? ' employee-toolbox-card--attention' : ''
                                }${selected ? ' employee-toolbox-card--active' : ''}${
                                  itemIndex > 0 && itemIndex % laneColumns === 0
                                    ? ' employee-toolbox-card--row-start'
                                    : ''
                                }`}
                                aria-pressed={selected}
                                aria-label={`${zh ? '优先级' : 'Priority'} ${node.priority} · ${displayName} · ${node.detail}`}
                                onClick={() => props.onSelectDispatchNode?.(node)}
                              >
                                <span className="employee-toolbox-card__kind">
                                  P{node.priority} · {kind.label}
                                </span>
                                <strong>{displayName}</strong>
                                <small title={node.detail}>{node.detail}</small>
                              </button>
                            )
                          }
                          const item = entry.item
                          const { kind, fanOut, state, detail, compactDetail, next } =
                            workItemPresentation(item)
                          return (
                            <button
                              key={`${item.workItemRef}:${state?.attention === true ? (props.attentionPulse ?? 0) : 0}`}
                              id={`${props.cardIdPrefix ?? 'toolbox-duty'}-${item.workItemRef}`}
                              data-work-item-ref={item.workItemRef}
                              type="button"
                              className={`employee-toolbox-card employee-toolbox-card--${kind.className}${
                                state === undefined ? '' : ` employee-toolbox-card--${state.state}`
                              }${fanOut ? ' employee-toolbox-card--fan-out' : ''}${
                                state?.attention === true ? ' employee-toolbox-card--attention' : ''
                              }${
                                item.workItemRef === props.selectedWorkItemRef &&
                                props.selectedReviewOptionRef == null
                                  ? ' employee-toolbox-card--active'
                                  : ''
                              }${itemIndex > 0 && itemIndex % laneColumns === 0 ? ' employee-toolbox-card--row-start' : ''}`}
                              aria-pressed={
                                item.workItemRef === props.selectedWorkItemRef &&
                                props.selectedReviewOptionRef == null
                              }
                              aria-label={`${localized(item.label, props.language)} · ${kind.label}${
                                fanOut ? (zh ? ' · 多项扇出' : ' · Fan-out collection') : ''
                              } · ${detail} · ${next}`}
                              title={localized(item.description, props.language)}
                              onClick={() => props.onSelect(item.workItemRef)}
                            >
                              <span className="employee-toolbox-card__kind">{kind.label}</span>
                              <strong>{localized(item.label, props.language)}</strong>
                              <small title={detail}>{compactDetail}</small>
                              <span className="sr-only">{next}</span>
                            </button>
                          )
                        })}
                      </div>
                    </section>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </section>
  )
}

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import { StatusChip } from '@/components/StatusChip'

import {
  ResponsibilityFlowCard,
  ResponsibilityIngressBranch,
  ResponsibilityIngressCard,
  ResponsibilityLaneAxis,
  ResponsibilityReviewBranch,
  type ResponsibilityCardPresentation,
  type ResponsibilityProjectedIngress,
} from './ResponsibilityFlowDisplay'
import type {
  EmployeeTypePackage,
  LaneAdapterSlot,
  ToolRegistration,
  WorkIngress,
  WorkItem,
} from './types'
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
  | { kind: 'adapter'; laneId: string; slot: LaneAdapterSlot }
  | { kind: 'item'; item: WorkItem }
  | {
      kind: 'ingress-branch'
      item: WorkItem
      ingresses: ResponsibilityProjectedIngress[]
      bypassIngresses: ResponsibilityProjectedIngress[]
    }
  | {
      kind: 'review-branch'
      item: WorkItem
      gate: ResponsibilityReviewGate
      mode: 'conditional' | 'active'
    }
  | { kind: 'dispatch'; node: ResponsibilityDispatchNode }
  | { kind: 'ingress'; ingress: ResponsibilityProjectedIngress }

type ResponsibilityMapLayoutEntry = {
  entry: ResponsibilityMapEntry
  auxiliary?: { column: number; row: number }
}

export type EmployeeCapabilityPhase =
  EmployeeTypePackage['authoringManifest']['lifecycleRegions'][number]
export type EmployeeCapabilityLane = EmployeeCapabilityPhase['responsibilityLanes'][number]
export type EmployeeCapabilityTool = WorkItem

export type EmployeeCapabilityToolState = {
  /** False removes this tool from the phase/lane projection. */
  active?: boolean
  state: 'configured' | 'missing' | 'neutral' | 'running' | 'failed' | 'completed' | 'waiting'
  detail: string
  compactDetail?: string
  attention?: boolean
}

type ResponsibilityCardState = EmployeeCapabilityToolState

export interface ResponsibilityReviewGate {
  parentWorkItemRef: string
  optionRef: string
  label: WorkItem['label']
  description: WorkItem['description']
}

export interface ResponsibilityToolSlotTarget {
  workItemRef: string
  roleRef: string
  slotRef: string
}

export interface ResponsibilityAdapterSlotTarget {
  laneId: string
  slotRef: string
  slot: LaneAdapterSlot
}

export interface ResponsibilityAdapterSlotState {
  state: 'configured' | 'missing' | 'neutral'
  detail: string
  compactDetail?: string
  attention?: boolean
}

export interface EmployeeCapabilityPanoramaProps {
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
  /** Keep duty nodes visible as context while only lane Adapter cards remain actionable. */
  workItemsReadOnly?: boolean
  /** Public phase → capability lane → tool projection used by authoring and runtime pages. */
  toolState?: (tool: EmployeeCapabilityTool) => EmployeeCapabilityToolState
  /**
   * Undefined active means authoring mode (show both conditional paths).
   * True selects the review path; false collapses it to the ordinary tool.
   */
  reviewToolState?: (gate: ResponsibilityReviewGate) => EmployeeCapabilityToolState
  /** @deprecated Use toolState. Kept for third-party employee pages during migration. */
  cardState?: (item: WorkItem) => ResponsibilityCardState
  /** @deprecated Use reviewToolState. */
  reviewGateState?: (gate: ResponsibilityReviewGate) => ResponsibilityCardState
  onConfigureIngress?: (ingress: WorkIngress) => void
  onSelectReviewGate?: (gate: ResponsibilityReviewGate) => void
  selectedReviewOptionRef?: string | null
  selectedToolSlotTarget?: ResponsibilityToolSlotTarget | null
  onSelectToolSlot?: (target: ResponsibilityToolSlotTarget) => void
  toolSlotState?: (target: ResponsibilityToolSlotTarget) => EmployeeCapabilityToolState
  selectedAdapterSlotKey?: string | null
  onSelectAdapterSlot?: (target: ResponsibilityAdapterSlotTarget) => void
  adapterSlotState?: (target: ResponsibilityAdapterSlotTarget) => ResponsibilityAdapterSlotState
  dispatchNodes?: readonly ResponsibilityDispatchNode[]
  selectedDispatchNodeKey?: string | null
  onSelectDispatchNode?: (node: ResponsibilityDispatchNode) => void
  /** Highest-priority event-driven duty lane first. Spine lanes stay fixed. */
  lanePriorityOrder?: readonly string[]
  onLanePriorityOrderChange?: (order: string[]) => void
}

function projectWorkIngresses(
  type: EmployeeTypePackage,
  workItemsByRef: ReadonlyMap<string, WorkItem>,
): ResponsibilityProjectedIngress[] {
  const intake = type.workIntakeAuthoring as EmployeeTypePackage['workIntakeAuthoring'] | undefined
  return type.authoringManifest.workIngresses.flatMap((ingress) => {
    const sourceIngress = ingress
    const fallback: ResponsibilityProjectedIngress = {
      ...ingress,
      sourceIngress,
      routeKind: 'standard',
    }
    const startItem = workItemsByRef.get(ingress.nextWorkItemRef)
    const directTargetRef =
      startItem?.nextWorkItemRefs.length === 1 ? startItem.nextWorkItemRefs[0] : undefined
    const directTarget =
      directTargetRef === undefined ? undefined : workItemsByRef.get(directTargetRef)
    if (
      ingress.configurationSurface === 'event-response-rules' &&
      ingress.sourceClass === 'issue' &&
      directTargetRef !== undefined &&
      directTarget !== undefined
    ) {
      return [
        {
          ...ingress,
          nextWorkItemRef: directTargetRef,
          sourceIngress,
          routeKind: 'bypass',
        },
      ]
    }
    if (ingress.configurationSurface !== 'task-creation' || intake === undefined) {
      return [fallback]
    }

    const externalIdRequirement = intake.kindRequirements.find(
      (requirement) =>
        requirement.kind === 'external-id' && requirement.workItemRef === ingress.nextWorkItemRef,
    )
    const directlyAcceptedKinds = intake.acceptedKinds.filter(
      (kind) =>
        kind !== 'external-id' &&
        !intake.kindRequirements.some((requirement) => requirement.kind === kind),
    )
    if (
      externalIdRequirement === undefined ||
      directlyAcceptedKinds.length === 0 ||
      directTargetRef === undefined ||
      directTarget === undefined
    ) {
      return [fallback]
    }

    return [
      {
        ...ingress,
        ingressRef: `${ingress.ingressRef}:direct`,
        order: ingress.order,
        label: { 'zh-CN': '输入描述/文档', 'en-US': 'Description / document' },
        valueLabel: { 'zh-CN': '界面', 'en-US': 'UI' },
        description: {
          'zh-CN': `从统一新建任务界面输入需求描述或上传文档，直接进入${localized(directTarget.label, 'zh-CN')}`,
          'en-US': `Enter a description or upload documents in unified task creation and continue directly to ${localized(directTarget.label, 'en-US')}`,
        },
        nextWorkItemRef: directTargetRef,
        sourceIngress,
        routeKind: 'bypass',
      },
      {
        ...ingress,
        ingressRef: `${ingress.ingressRef}:external-id`,
        order: ingress.order + 1,
        label: { 'zh-CN': '输入 ID', 'en-US': 'Input ID' },
        valueLabel: { 'zh-CN': '界面', 'en-US': 'UI' },
        description: intake.externalId.description,
        sourceIngress,
        routeKind: 'standard',
      },
    ]
  })
}

export function EmployeeCapabilityPanorama(props: EmployeeCapabilityPanoramaProps): ReactElement {
  const zh = props.language.startsWith('zh')
  const [draggedLaneId, setDraggedLaneId] = useState<string | null>(null)
  const [dragTargetLaneId, setDragTargetLaneId] = useState<string | null>(null)
  const [dragPreviewOrder, setDragPreviewOrder] = useState<string[] | null>(null)
  const [dragTranslateY, setDragTranslateY] = useState(0)
  const [laneColumnCapacityById, setLaneColumnCapacityById] = useState<
    Readonly<Record<string, number>>
  >({})
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
  const capabilityToolState = (item: WorkItem) => props.toolState?.(item) ?? props.cardState?.(item)
  const capabilityReviewState = (gate: ResponsibilityReviewGate) =>
    props.reviewToolState?.(gate) ?? props.reviewGateState?.(gate)
  const activeWorkItems = props.type.authoringManifest.workItems.filter(
    (item) => capabilityToolState(item)?.active !== false,
  )
  const workItemsByRef = new Map(activeWorkItems.map((item) => [item.workItemRef, item]))
  const activeIngresses = projectWorkIngresses(props.type, workItemsByRef).filter((ingress) =>
    workItemsByRef.has(ingress.nextWorkItemRef),
  )
  const reactionLaneIds = new Set(
    props.type.reactionRules.flatMap((rule) => {
      const item = workItemsByRef.get(rule.capabilityWorkItemRef ?? rule.workItemRef)
      return item?.responsibilityLaneId == null ? [] : [item.responsibilityLaneId]
    }),
  )
  const fanOutDestinationRefs = new Set(
    activeWorkItems.flatMap((source) =>
      (source.orderedDispatchAuthoring?.destinationWorkItemRefs ?? []).filter(
        (destinationRef) => workItemsByRef.get(destinationRef)?.nodeKind === 'business-tool',
      ),
    ),
  )
  const regions = [...props.type.authoringManifest.lifecycleRegions]
    .filter(
      (region) =>
        activeWorkItems.some((item) => item.regionId === region.regionId) ||
        activeIngresses.some((ingress) => ingress.regionId === region.regionId),
    )
    .sort((left, right) => left.order - right.order)
  const renderedLaneSignature = regions
    .flatMap((region) =>
      region.responsibilityLanes
        .filter(
          (lane) =>
            activeWorkItems.some((item) => item.responsibilityLaneId === lane.laneId) ||
            activeIngresses.some((ingress) => ingress.responsibilityLaneId === lane.laneId),
        )
        .map((lane) => lane.laneId),
    )
    .join('\u0000')
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return

    const measureLaneColumns = () => {
      const nextCapacityById: Record<string, number> = {}
      for (const [laneId, laneElement] of laneElements.current) {
        const cards = laneElement.querySelector<HTMLElement>('.employee-toolbox-lane__cards')
        if (cards === null) continue
        const styles = window.getComputedStyle(cards)
        const cardWidth = Number.parseFloat(styles.getPropertyValue('--employee-tool-card-width'))
        const columnGap = Number.parseFloat(styles.columnGap)
        const horizontalPadding =
          Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight)
        if (!Number.isFinite(cardWidth) || cardWidth <= 0) continue
        const safeGap = Number.isFinite(columnGap) ? columnGap : 0
        const usableWidth = Math.max(0, cards.clientWidth - horizontalPadding)
        nextCapacityById[laneId] = Math.max(
          1,
          Math.floor((usableWidth + safeGap) / (cardWidth + safeGap)),
        )
      }
      setLaneColumnCapacityById((current) => {
        const currentEntries = Object.entries(current)
        const nextEntries = Object.entries(nextCapacityById)
        if (
          currentEntries.length === nextEntries.length &&
          nextEntries.every(([laneId, capacity]) => current[laneId] === capacity)
        ) {
          return current
        }
        return nextCapacityById
      })
    }

    const observer = new ResizeObserver(measureLaneColumns)
    for (const laneElement of laneElements.current.values()) {
      const cards = laneElement.querySelector<HTMLElement>('.employee-toolbox-lane__cards')
      if (cards !== null) observer.observe(cards)
    }
    measureLaneColumns()
    return () => observer.disconnect()
  }, [renderedLaneSignature])
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
  const availableToolCount = (item: WorkItem, roleRefs?: ReadonlySet<string>): number =>
    (props.toolsByWorkItem?.[item.workItemRef] ?? []).filter(
      (tool) =>
        tool.state === 'published' &&
        (roleRefs === undefined || roleRefs.has(tool.content.roleRef)),
    ).length
  const mainToolRoleRefs = (item: WorkItem): ReadonlySet<string> | undefined => {
    const planningRoleRef = item.humanReview?.planningRoleRef
    if (planningRoleRef === undefined) return undefined
    return new Set(
      item.toolRoleGroups
        .map((role) => role.roleRef)
        .filter((roleRef) => roleRef !== planningRoleRef),
    )
  }
  const toolCountPresentation = (
    count: number,
  ): Pick<ResponsibilityCardPresentation, 'detail' | 'compactDetail'> => ({
    detail:
      count > 0
        ? zh
          ? `${count} 个可用工具`
          : `${count} available tool${count === 1 ? '' : 's'}`
        : zh
          ? '尚未配置工具'
          : 'No tool configured',
    compactDetail:
      count > 0
        ? zh
          ? `${count} 个工具`
          : `${count} tool${count === 1 ? '' : 's'}`
        : zh
          ? '未配置'
          : 'Missing',
  })
  const workItemPresentation = (item: WorkItem): ResponsibilityCardPresentation => {
    const kind = nodeKind(item)
    const fanOut = fanOutDestinationRefs.has(item.workItemRef)
    const state = capabilityToolState(item)
    const availableTools = availableToolCount(item, mainToolRoleRefs(item))
    const availableToolPresentation = toolCountPresentation(availableTools)
    const nextLabels = item.nextWorkItemRefs
      .map((ref) => workItemsByRef.get(ref))
      .filter((next): next is WorkItem => next !== undefined)
      .map((next) => localized(next.label, props.language))
    const detail =
      state?.detail ??
      (item.nodeKind === 'business-tool'
        ? availableToolPresentation.detail
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
        ? availableToolPresentation.compactDetail
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
            .filter((lane) => {
              const includedLaneIds =
                lane.kind === 'spine'
                  ? new Set([lane.laneId, ...absorbedLaneIds])
                  : new Set([lane.laneId])
              return (
                activeWorkItems.some(
                  (item) =>
                    item.regionId === region.regionId &&
                    item.responsibilityLaneId !== null &&
                    includedLaneIds.has(item.responsibilityLaneId),
                ) ||
                activeIngresses.some(
                  (ingress) =>
                    ingress.regionId === region.regionId &&
                    includedLaneIds.has(ingress.responsibilityLaneId),
                )
              )
            })
          return (
            <section
              key={region.regionId}
              className={`employee-toolbox-region employee-toolbox-region--${lanes.length > 1 ? 'branching' : 'single-lane'}`}
              data-capability-phase-id={region.regionId}
            >
              <header>
                <span className="employee-toolbox-region__phase">
                  {zh ? `职责 ${regionIndex + 1}` : `Responsibility ${regionIndex + 1}`}
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
                  const items = activeWorkItems
                    .filter(
                      (item) =>
                        item.regionId === region.regionId &&
                        item.responsibilityLaneId !== null &&
                        includedLaneIds.has(item.responsibilityLaneId),
                    )
                    .sort((left, right) => left.order - right.order)
                  const ingresses = activeIngresses
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
                  const ingressesByTarget = new Map<string, ResponsibilityProjectedIngress[]>()
                  for (const ingress of ingresses) {
                    const current = ingressesByTarget.get(ingress.nextWorkItemRef) ?? []
                    current.push(ingress)
                    ingressesByTarget.set(ingress.nextWorkItemRef, current)
                  }
                  const reviewProjectionByWorkItem = new Map<
                    string,
                    { gate: ResponsibilityReviewGate; mode: 'conditional' | 'active' }
                  >()
                  for (const item of items) {
                    if (
                      item.humanReview === null ||
                      replacedDestinationRefs.has(item.workItemRef)
                    ) {
                      continue
                    }
                    const gate: ResponsibilityReviewGate = {
                      parentWorkItemRef: item.workItemRef,
                      optionRef: item.humanReview.optionRef,
                      label: item.humanReview.label,
                      description: item.humanReview.description,
                    }
                    const reviewActive = capabilityReviewState(gate)?.active
                    if (reviewActive === false) continue
                    reviewProjectionByWorkItem.set(item.workItemRef, {
                      gate,
                      mode: reviewActive === true ? 'active' : 'conditional',
                    })
                  }
                  // Assign every ingress card to exactly one branch. Earlier source items own
                  // bypass routes to their single successor; the successor only owns a route
                  // when no active predecessor branch already presents it.
                  const claimedIngressRefs = new Set<string>()
                  const ingressProjectionByWorkItem = new Map<
                    string,
                    {
                      ingresses: ResponsibilityProjectedIngress[]
                      bypassIngresses: ResponsibilityProjectedIngress[]
                    }
                  >()
                  for (const item of items) {
                    if (
                      replacedDestinationRefs.has(item.workItemRef) ||
                      reviewProjectionByWorkItem.has(item.workItemRef)
                    ) {
                      continue
                    }
                    const itemIngresses = (ingressesByTarget.get(item.workItemRef) ?? []).filter(
                      (ingress) => !claimedIngressRefs.has(ingress.ingressRef),
                    )
                    if (itemIngresses.length === 0) continue
                    for (const ingress of itemIngresses) claimedIngressRefs.add(ingress.ingressRef)
                    const bypassIngresses =
                      item.nextWorkItemRefs.length === 1
                        ? (ingressesByTarget.get(item.nextWorkItemRefs[0]!) ?? []).filter(
                            (ingress) =>
                              ingress.routeKind === 'bypass' &&
                              !claimedIngressRefs.has(ingress.ingressRef),
                          )
                        : []
                    for (const ingress of bypassIngresses) {
                      claimedIngressRefs.add(ingress.ingressRef)
                    }
                    ingressProjectionByWorkItem.set(item.workItemRef, {
                      ingresses: itemIngresses,
                      bypassIngresses,
                    })
                  }
                  const primaryEntryFor = (item: WorkItem): ResponsibilityMapEntry => {
                    const reviewProjection = reviewProjectionByWorkItem.get(item.workItemRef)
                    if (reviewProjection !== undefined) {
                      return {
                        kind: 'review-branch',
                        item,
                        gate: reviewProjection.gate,
                        mode: reviewProjection.mode,
                      }
                    }
                    const ingressProjection = ingressProjectionByWorkItem.get(item.workItemRef)
                    return ingressProjection !== undefined
                      ? {
                          kind: 'ingress-branch',
                          item,
                          ingresses: ingressProjection.ingresses,
                          bypassIngresses: ingressProjection.bypassIngresses,
                        }
                      : { kind: 'item', item }
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
                          primaryEntryFor(item),
                          ...laneDispatchNodes
                            .filter((node) => node.classifierWorkItemRef === item.workItemRef)
                            .map((node) => ({ kind: 'dispatch' as const, node })),
                        ],
                  }))
                  const workItemEntries = primaryEntryBuckets
                    .sort(
                      (left, right) =>
                        left.order - right.order || left.identity.localeCompare(right.identity),
                    )
                    .flatMap((entry) => entry.entries)
                  // Adapter slots are configuration dependencies owned by the lane, not
                  // schedulable WorkItems. Project them first without adding them to the
                  // manifest graph, reaction rules, rounds, or runtime status counts.
                  const primaryEntries: ResponsibilityMapEntry[] = [
                    ...(lane.adapterSlots ?? []).map((slot) => ({
                      kind: 'adapter' as const,
                      laneId: lane.laneId,
                      slot,
                    })),
                    ...workItemEntries,
                  ]
                  const entryColumnSpan = (entry: ResponsibilityMapEntry): number =>
                    entry.kind === 'review-branch' ? 3 : entry.kind === 'ingress-branch' ? 2 : 1
                  const totalColumnSpan = workItemEntries.reduce(
                    (total, entry) => total + entryColumnSpan(entry),
                    0,
                  )
                  const laneColumns = Math.max(
                    1,
                    Math.min(
                      totalColumnSpan,
                      laneColumnCapacityById[lane.laneId] ?? totalColumnSpan,
                    ),
                    ...workItemEntries.map(entryColumnSpan),
                  )
                  const hasParallelIngressBranch = primaryEntries.some(
                    (entry) =>
                      entry.kind === 'ingress-branch' &&
                      entry.ingresses.length + entry.bypassIngresses.length > 1,
                  )
                  let nextPrimaryColumn = 1
                  let nextPrimaryRow = 1
                  const primaryPlacements = primaryEntries.map((entry, index) => {
                    // Adapter is the first configuration card in the lane, but it is not an
                    // executable predecessor. Give each Adapter a dedicated leading row so
                    // adding the card never breaks the horizontal WorkItem flow or draws a
                    // false sequence arrow from configuration into execution.
                    if (entry.kind === 'adapter') {
                      const placement = {
                        column: 1,
                        row: nextPrimaryRow,
                        rowStart: true,
                      }
                      nextPrimaryColumn = 1
                      nextPrimaryRow += 1
                      return placement
                    }
                    const columnSpan = entryColumnSpan(entry)
                    if (nextPrimaryColumn + columnSpan - 1 > laneColumns) {
                      nextPrimaryColumn = 1
                      nextPrimaryRow += 1
                    }
                    const placement = {
                      column: nextPrimaryColumn,
                      row: nextPrimaryRow,
                      rowStart: index > 0 && nextPrimaryColumn === 1,
                    }
                    nextPrimaryColumn += columnSpan
                    if (nextPrimaryColumn > laneColumns) {
                      nextPrimaryColumn = 1
                      nextPrimaryRow += 1
                    }
                    return placement
                  })
                  const primaryRowStartIndices = new Set(
                    primaryPlacements.flatMap((placement, index) =>
                      placement.rowStart ? [index] : [],
                    ),
                  )
                  const primaryColumnByWorkItem = new Map<string, number>()
                  primaryEntries.forEach((entry, index) => {
                    if (
                      entry.kind === 'item' ||
                      entry.kind === 'ingress-branch' ||
                      entry.kind === 'review-branch'
                    ) {
                      primaryColumnByWorkItem.set(
                        entry.item.workItemRef,
                        primaryPlacements[index]?.column ?? 1,
                      )
                    }
                  })
                  const auxiliaryDrafts = [
                    ...ingresses
                      .filter((ingress) => !claimedIngressRefs.has(ingress.ingressRef))
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
                  const firstAuxiliaryRow =
                    Math.max(0, ...primaryPlacements.map((placement) => placement.row)) + 1
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
                  const nextLabelForIngress = (ingress: ResponsibilityProjectedIngress) => {
                    const nextItem = workItemsByRef.get(ingress.nextWorkItemRef)
                    return nextItem === undefined
                      ? ingress.nextWorkItemRef
                      : localized(nextItem.label, props.language)
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
                        {
                          '--employee-adapter-axis-offset': `${(lane.adapterSlots?.length ?? 0) * 20}px`,
                          ...(draggedLaneId === lane.laneId
                            ? {
                                '--employee-lane-drag-offset': `${dragTranslateY}px`,
                                transform: `translate3d(0, ${dragTranslateY}px, 0)`,
                              }
                            : {}),
                        } as CSSProperties
                      }
                      data-lane-id={lane.laneId}
                      data-capability-lane-id={lane.laneId}
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
                      <ResponsibilityLaneAxis />
                      <div
                        className="employee-toolbox-lane__cards"
                        style={
                          {
                            '--employee-lane-columns': laneColumns,
                          } as CSSProperties
                        }
                      >
                        {entries.map(({ entry, auxiliary }, itemIndex) => {
                          if (entry.kind === 'adapter') {
                            const target: ResponsibilityAdapterSlotTarget = {
                              laneId: entry.laneId,
                              slotRef: entry.slot.slotRef,
                              slot: entry.slot,
                            }
                            const state = props.adapterSlotState?.(target) ?? {
                              state: 'neutral' as const,
                              detail: zh ? '管理企业连接资源' : 'Manage enterprise connections',
                              compactDetail: zh ? '连接' : 'Links',
                            }
                            const key = `${entry.laneId}/${entry.slot.slotRef}`
                            const selected = props.selectedAdapterSlotKey === key
                            const rowStart = primaryRowStartIndices.has(itemIndex)
                            return (
                              <ResponsibilityFlowCard
                                key={`adapter:${key}:${state.attention === true ? (props.attentionPulse ?? 0) : 0}`}
                                id={`${props.cardIdPrefix ?? 'toolbox-duty'}-adapter-${entry.laneId}-${entry.slot.slotRef}`}
                                data-lane-adapter-slot={key}
                                data-capability-adapter-purpose={entry.slot.purpose}
                                type="button"
                                className={`employee-toolbox-card--adapter employee-toolbox-card--${state.state}${
                                  state.attention === true
                                    ? ' employee-toolbox-card--attention'
                                    : ''
                                }${selected ? ' employee-toolbox-card--active' : ''}${
                                  rowStart ? ' employee-toolbox-card--row-start' : ''
                                }`}
                                aria-pressed={selected}
                                aria-label={`${localized(entry.slot.label, props.language)} · ${
                                  zh ? '企业连接' : 'Enterprise connection'
                                } · ${state.detail}`}
                                title={localized(entry.slot.description, props.language)}
                                disabled={props.onSelectAdapterSlot === undefined}
                                onClick={() => props.onSelectAdapterSlot?.(target)}
                                incoming={itemIndex > 0 && !rowStart}
                                kindLabel="Adapter"
                                label={null}
                                detailText={state.compactDetail ?? state.detail}
                                detailTitle={state.detail}
                              />
                            )
                          }
                          if (entry.kind === 'ingress') {
                            return (
                              <ResponsibilityIngressCard
                                key={`ingress:${entry.ingress.ingressRef}`}
                                ingress={entry.ingress}
                                language={props.language}
                                cardIdPrefix={props.cardIdPrefix ?? 'toolbox-duty'}
                                auxiliary={auxiliary}
                                nextLabel={nextLabelForIngress(entry.ingress)}
                                readOnly={props.workItemsReadOnly}
                                onConfigure={props.onConfigureIngress}
                              />
                            )
                          }
                          if (entry.kind === 'ingress-branch') {
                            const item = entry.item
                            const selected =
                              item.workItemRef === props.selectedWorkItemRef &&
                              props.selectedReviewOptionRef == null
                            const sourceIngresses = [
                              ...entry.ingresses,
                              ...entry.bypassIngresses,
                            ].sort(
                              (left, right) =>
                                left.order - right.order ||
                                left.ingressRef.localeCompare(right.ingressRef),
                            )
                            const rowStart = primaryRowStartIndices.has(itemIndex)
                            return (
                              <ResponsibilityIngressBranch
                                key={`ingress-branch:${item.workItemRef}`}
                                item={item}
                                ingresses={sourceIngresses}
                                presentation={workItemPresentation(item)}
                                language={props.language}
                                cardIdPrefix={props.cardIdPrefix ?? 'toolbox-duty'}
                                selected={selected}
                                incoming={itemIndex > 0 && !rowStart}
                                rowStart={rowStart}
                                readOnly={props.workItemsReadOnly}
                                onSelect={() => props.onSelect(item.workItemRef)}
                                onConfigureIngress={props.onConfigureIngress}
                                nextLabelFor={nextLabelForIngress}
                              />
                            )
                          }
                          if (entry.kind === 'review-branch') {
                            const item = entry.item
                            const gate = entry.gate
                            const { kind, fanOut, state, detail, compactDetail, next } =
                              workItemPresentation(item)
                            const gateState = capabilityReviewState(gate)
                            const planningTarget: ResponsibilityToolSlotTarget = {
                              workItemRef: item.workItemRef,
                              roleRef: item.humanReview!.planningRoleRef,
                              slotRef: item.humanReview!.planningSlotRef,
                            }
                            const planningToolState = props.toolSlotState?.(planningTarget)
                            const planningPresentation =
                              planningToolState !== undefined
                                ? {
                                    detail: planningToolState.detail,
                                    compactDetail:
                                      planningToolState.compactDetail ?? planningToolState.detail,
                                  }
                                : props.toolsByWorkItem === undefined
                                  ? undefined
                                  : toolCountPresentation(
                                      availableToolCount(item, new Set([planningTarget.roleRef])),
                                    )
                            const gateSelected =
                              props.selectedWorkItemRef === gate.parentWorkItemRef &&
                              props.selectedReviewOptionRef === gate.optionRef
                            const planningSelected =
                              props.selectedToolSlotTarget?.workItemRef ===
                                planningTarget.workItemRef &&
                              props.selectedToolSlotTarget.roleRef === planningTarget.roleRef &&
                              props.selectedToolSlotTarget.slotRef === planningTarget.slotRef
                            const itemSelected =
                              props.selectedWorkItemRef === item.workItemRef &&
                              props.selectedReviewOptionRef == null &&
                              props.selectedToolSlotTarget == null
                            const gateDetail =
                              gateState?.detail ??
                              (zh ? '可选，任务发起时决定' : 'Optional; decided when work starts')
                            const beforeReviewState =
                              entry.mode !== 'active'
                                ? planningToolState?.state
                                : gateState?.state === 'waiting' ||
                                    gateState?.state === 'completed' ||
                                    gateState?.state === 'failed'
                                  ? 'completed'
                                  : state?.state
                            const afterApprovalState =
                              entry.mode !== 'active'
                                ? undefined
                                : gateState?.state === 'completed'
                                  ? (state?.state ?? 'waiting')
                                  : 'waiting'
                            const beforeReviewLabel = localized(
                              item.humanReview?.reviewedPath?.beforeReviewLabel ?? {
                                'zh-CN': '分析',
                                'en-US': 'Analyze',
                              },
                              props.language,
                            )
                            const planningDescription = localized(
                              item.toolRoleGroups.find(
                                (role) => role.roleRef === planningTarget.roleRef,
                              )?.description ?? item.description,
                              props.language,
                            )
                            const selectItem = () => props.onSelect(item.workItemRef)
                            const rowStart = primaryRowStartIndices.has(itemIndex)
                            return (
                              <ResponsibilityReviewBranch
                                key={`review-branch:${item.workItemRef}`}
                                item={item}
                                gate={gate}
                                mode={entry.mode}
                                presentation={{
                                  kind,
                                  fanOut,
                                  state,
                                  detail,
                                  compactDetail,
                                  next,
                                }}
                                language={props.language}
                                cardIdPrefix={props.cardIdPrefix ?? 'toolbox-duty'}
                                beforeReviewLabel={beforeReviewLabel}
                                planningDescription={planningDescription}
                                planningRoleRef={planningTarget.roleRef}
                                planningSlotRef={planningTarget.slotRef}
                                planningPresentation={planningPresentation}
                                gateDetail={gateDetail}
                                gateState={gateState}
                                beforeReviewState={beforeReviewState}
                                afterApprovalState={afterApprovalState}
                                gateSelected={gateSelected}
                                planningSelected={planningSelected}
                                itemSelected={itemSelected}
                                incoming={itemIndex > 0 && !rowStart}
                                rowStart={rowStart}
                                readOnly={props.workItemsReadOnly}
                                onSelectPlanning={() => {
                                  if (props.onSelectToolSlot === undefined) {
                                    props.onSelect(item.workItemRef)
                                  } else {
                                    props.onSelectToolSlot(planningTarget)
                                  }
                                }}
                                onSelectItem={selectItem}
                                onSelectGate={() => {
                                  if (props.onSelectReviewGate === undefined) {
                                    props.onSelect(gate.parentWorkItemRef)
                                  } else {
                                    props.onSelectReviewGate(gate)
                                  }
                                }}
                              />
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
                            const rowStart = primaryRowStartIndices.has(itemIndex)
                            return (
                              <ResponsibilityFlowCard
                                key={`${node.key}:${node.attention === true ? (props.attentionPulse ?? 0) : 0}`}
                                id={`${props.cardIdPrefix ?? 'toolbox-duty'}-dispatch-${node.key}`}
                                data-dispatch-route-key={node.key}
                                data-capability-tool-ref={`dispatch:${node.key}`}
                                type="button"
                                className={`employee-toolbox-card--${kind.className} employee-toolbox-card--${node.state ?? (node.configured ? 'configured' : 'missing')}${
                                  node.attention === true ? ' employee-toolbox-card--attention' : ''
                                }${selected ? ' employee-toolbox-card--active' : ''}${
                                  rowStart ? ' employee-toolbox-card--row-start' : ''
                                }`}
                                aria-pressed={selected}
                                aria-label={`${zh ? '优先级' : 'Priority'} ${node.priority} · ${displayName} · ${node.detail}`}
                                disabled={props.workItemsReadOnly === true}
                                onClick={() => props.onSelectDispatchNode?.(node)}
                                incoming={itemIndex > 0 && !rowStart}
                                kindLabel={`P${node.priority} · ${kind.label}`}
                                label={displayName}
                                detailText={node.detail}
                                detailTitle={node.detail}
                              />
                            )
                          }
                          const item = entry.item
                          const { kind, fanOut, state, detail, compactDetail, next } =
                            workItemPresentation(item)
                          const selected =
                            item.workItemRef === props.selectedWorkItemRef &&
                            props.selectedReviewOptionRef == null
                          const rowStart = primaryRowStartIndices.has(itemIndex)
                          return (
                            <ResponsibilityFlowCard
                              key={`${item.workItemRef}:${state?.attention === true ? (props.attentionPulse ?? 0) : 0}`}
                              id={`${props.cardIdPrefix ?? 'toolbox-duty'}-${item.workItemRef}`}
                              data-work-item-ref={item.workItemRef}
                              data-capability-tool-ref={`work-item:${item.workItemRef}`}
                              type="button"
                              className={`employee-toolbox-card--${kind.className}${
                                state === undefined ? '' : ` employee-toolbox-card--${state.state}`
                              }${fanOut ? ' employee-toolbox-card--fan-out' : ''}${
                                state?.attention === true ? ' employee-toolbox-card--attention' : ''
                              }${selected ? ' employee-toolbox-card--active' : ''}${
                                rowStart ? ' employee-toolbox-card--row-start' : ''
                              }`}
                              aria-pressed={selected}
                              aria-label={`${localized(item.label, props.language)} · ${kind.label}${
                                fanOut ? (zh ? ' · 多项扇出' : ' · Fan-out collection') : ''
                              } · ${detail} · ${next}`}
                              title={localized(item.description, props.language)}
                              disabled={props.workItemsReadOnly === true}
                              onClick={() => props.onSelect(item.workItemRef)}
                              incoming={itemIndex > 0 && !rowStart}
                              kindLabel={kind.label}
                              label={localized(item.label, props.language)}
                              detailText={compactDetail}
                              detailTitle={detail}
                              nextText={next}
                            />
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

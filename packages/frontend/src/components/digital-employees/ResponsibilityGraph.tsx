import type { ReactElement } from 'react'

import type { EmployeeTypePackage, WorkItem } from './types'
import { localized } from './types'

export interface ResponsibilityNodeLayout {
  item: WorkItem
  regionIndex: number
  laneId: string | null
  laneKind: 'spine' | 'branch' | null
  row: number
  column: number
  x: number
  y: number
}

interface ResponsibilityLaneLayout {
  id: string
  label: EmployeeTypePackage['authoringManifest']['lifecycleRegions'][number]['responsibilityLanes'][number]['label']
  description: EmployeeTypePackage['authoringManifest']['lifecycleRegions'][number]['responsibilityLanes'][number]['description']
  kind: 'spine' | 'branch'
  y: number
  height: number
}

export interface ResponsibilityBandLayout {
  id: string
  y: number
  height: number
  lanes: ResponsibilityLaneLayout[]
}

export interface ResponsibilityGraphLayout {
  width: number
  height: number
  nodes: ResponsibilityNodeLayout[]
  bands: ResponsibilityBandLayout[]
}

const NODE_WIDTH = 160
const NODE_HEIGHT = 80
const COLUMN_GAP = 14
const ROW_GAP = 18
const LANE_GAP = 10
const BAND_GAP = 22
const PADDING_X = 18
const BAND_HEADER = 58
const BAND_BOTTOM = 14
const LANE_LABEL_WIDTH = 132
const LANE_PADDING_Y = 10
const FALLBACK_COLUMNS = 4
const MAX_LANE_COLUMNS = 5
const LOOP_GUTTER = 50

function rowStartX(contentX: number, contentWidth: number, count: number): number {
  const rowWidth = count * NODE_WIDTH + Math.max(0, count - 1) * COLUMN_GAP
  return contentX + Math.max(0, (contentWidth - rowWidth) / 2)
}

export function buildResponsibilityGraphLayout(
  type: EmployeeTypePackage,
): ResponsibilityGraphLayout {
  const regions = [...type.authoringManifest.lifecycleRegions].sort(
    (left, right) => left.order - right.order,
  )
  const itemsByRegion = new Map(
    regions.map((region) => [
      region.regionId,
      type.authoringManifest.workItems
        .filter((item) => item.regionId === region.regionId)
        .sort((left, right) => left.order - right.order),
    ]),
  )
  const largestLane = Math.max(
    1,
    ...regions.flatMap((region) => {
      const items = itemsByRegion.get(region.regionId) ?? []
      return region.responsibilityLanes.length === 0
        ? [Math.min(FALLBACK_COLUMNS, items.length)]
        : region.responsibilityLanes.map(
            (lane) => items.filter((item) => item.responsibilityLaneId === lane.laneId).length,
          )
    }),
  )
  const columns = Math.max(1, Math.min(MAX_LANE_COLUMNS, largestLane))
  const contentX = PADDING_X + LANE_LABEL_WIDTH
  const contentWidth = columns * NODE_WIDTH + Math.max(0, columns - 1) * COLUMN_GAP
  const width = contentX + contentWidth + LOOP_GUTTER + PADDING_X
  const nodes: ResponsibilityNodeLayout[] = []
  const bands: ResponsibilityBandLayout[] = []
  let graphY = 0
  let logicalRow = 0

  for (const [regionIndex, region] of regions.entries()) {
    const items = itemsByRegion.get(region.regionId) ?? []
    const lanes: ResponsibilityLaneLayout[] = []
    let cursorY = graphY + BAND_HEADER

    if (region.responsibilityLanes.length > 0) {
      for (const lane of [...region.responsibilityLanes].sort(
        (left, right) => left.order - right.order,
      )) {
        const laneItems = items.filter((item) => item.responsibilityLaneId === lane.laneId)
        const rowCount = Math.max(1, Math.ceil(laneItems.length / columns))
        const laneHeight =
          LANE_PADDING_Y * 2 + rowCount * NODE_HEIGHT + Math.max(0, rowCount - 1) * ROW_GAP
        lanes.push({
          id: lane.laneId,
          label: lane.label,
          description: lane.description,
          kind: lane.kind,
          y: cursorY,
          height: laneHeight,
        })
        for (let row = 0; row < rowCount; row += 1) {
          const rowItems = laneItems.slice(row * columns, (row + 1) * columns)
          const startX =
            lane.kind === 'spine' ? rowStartX(contentX, contentWidth, rowItems.length) : contentX
          rowItems.forEach((item, column) => {
            nodes.push({
              item,
              regionIndex,
              laneId: lane.laneId,
              laneKind: lane.kind,
              row: logicalRow + row,
              column,
              x: startX + column * (NODE_WIDTH + COLUMN_GAP),
              y: cursorY + LANE_PADDING_Y + row * (NODE_HEIGHT + ROW_GAP),
            })
          })
        }
        logicalRow += rowCount
        cursorY += laneHeight + LANE_GAP
      }
    } else {
      const rowCount = Math.max(1, Math.ceil(items.length / columns))
      items.forEach((item, index) => {
        const row = Math.floor(index / columns)
        const rowItems = items.slice(row * columns, (row + 1) * columns)
        const column = index % columns
        nodes.push({
          item,
          regionIndex,
          laneId: null,
          laneKind: null,
          row: logicalRow + row,
          column,
          x:
            rowStartX(contentX, contentWidth, rowItems.length) + column * (NODE_WIDTH + COLUMN_GAP),
          y: cursorY + row * (NODE_HEIGHT + ROW_GAP),
        })
      })
      cursorY += rowCount * NODE_HEIGHT + Math.max(0, rowCount - 1) * ROW_GAP
      logicalRow += rowCount
    }

    const height = cursorY - graphY - (lanes.length > 0 ? LANE_GAP : 0) + BAND_BOTTOM
    bands.push({ id: region.regionId, y: graphY, height, lanes })
    graphY += height + BAND_GAP
  }

  return {
    width,
    height: Math.max(320, graphY - BAND_GAP),
    nodes,
    bands,
  }
}

function stableEdgeLane(sourceRef: string, targetRef: string): number {
  let value = 0
  for (const char of `${sourceRef}:${targetRef}`) value = (value * 31 + char.charCodeAt(0)) % 7
  return value
}

function edgePath(
  source: ResponsibilityNodeLayout,
  target: ResponsibilityNodeLayout,
  sourceBand: ResponsibilityBandLayout,
  targetBand: ResponsibilityBandLayout,
  width: number,
  loop: boolean,
): string {
  const sourceRight = source.x + NODE_WIDTH
  const sourceCenterX = source.x + NODE_WIDTH / 2
  const sourceCenterY = source.y + NODE_HEIGHT / 2
  const targetRight = target.x + NODE_WIDTH
  const targetCenterY = target.y + NODE_HEIGHT / 2
  const edgeLane = stableEdgeLane(source.item.workItemRef, target.item.workItemRef)

  if (loop) {
    const loopX = width - PADDING_X - 6 - edgeLane * 4
    if (source.item.workItemRef === target.item.workItemRef) {
      return `M ${sourceRight} ${sourceCenterY} H ${loopX} V ${source.y - 6} H ${sourceCenterX} V ${source.y}`
    }
    return `M ${sourceRight} ${sourceCenterY} H ${loopX} V ${targetCenterY} H ${targetRight}`
  }

  if (source.regionIndex === target.regionIndex && source.row === target.row) {
    return `M ${sourceRight} ${sourceCenterY} H ${target.x}`
  }

  const sourceBottom = source.y + NODE_HEIGHT
  const sourceAboveTarget = source.y < target.y
  if (source.regionIndex !== target.regionIndex || source.laneId !== target.laneId) {
    const transitionX = width - PADDING_X - 10 - edgeLane * 3
    const laneY =
      source.regionIndex === target.regionIndex
        ? sourceBottom + 4 + (edgeLane - 3) * 0.6
        : sourceBand.y +
          sourceBand.height +
          (targetBand.y - sourceBand.y - sourceBand.height) / 2 +
          (edgeLane - 3) * 2
    return [
      `M ${sourceCenterX} ${sourceBottom}`,
      `V ${laneY}`,
      `H ${transitionX}`,
      `V ${targetCenterY}`,
      `H ${targetRight}`,
    ].join(' ')
  }

  const sourceY = sourceAboveTarget ? sourceBottom : source.y
  const laneY = sourceY + (targetCenterY - sourceY) / 2 + (edgeLane - 3) * 2
  return [
    `M ${sourceCenterX} ${sourceY}`,
    `V ${laneY}`,
    `H ${target.x - 12}`,
    `V ${targetCenterY}`,
    `H ${target.x}`,
  ].join(' ')
}

export function ResponsibilityGraph(props: {
  type: EmployeeTypePackage
  language: string
  selectedWorkItemRef: string | null
  onSelect: (workItemRef: string) => void
  toolCounts?: Readonly<Record<string, number>>
  mode: 'toolbox' | 'job-template' | 'employee' | 'runtime'
}): ReactElement {
  const regions = [...props.type.authoringManifest.lifecycleRegions].sort(
    (left, right) => left.order - right.order,
  )
  const layout = buildResponsibilityGraphLayout(props.type)
  const byRef = new Map(layout.nodes.map((node) => [node.item.workItemRef, node] as const))
  const edges = layout.nodes.flatMap((source) =>
    source.item.nextWorkItemRefs.flatMap((targetRef) => {
      const target = byRef.get(targetRef)
      if (target === undefined) return []
      const loop =
        target.regionIndex < source.regionIndex ||
        (target.regionIndex === source.regionIndex && target.item.order <= source.item.order)
      return [{ source, target, loop }]
    }),
  )
  const dispatchGroups = new Map<string, typeof edges>()
  for (const edge of edges) {
    if (
      edge.loop ||
      edge.source.regionIndex !== edge.target.regionIndex ||
      edge.source.laneKind !== 'spine' ||
      edge.target.laneKind !== 'branch'
    ) {
      continue
    }
    const existing = dispatchGroups.get(edge.source.item.workItemRef) ?? []
    existing.push(edge)
    dispatchGroups.set(edge.source.item.workItemRef, existing)
  }
  const dispatchEdgeKeys = new Set(
    [...dispatchGroups.values()].flatMap((group) =>
      group.map(({ source, target }) => `${source.item.workItemRef}:${target.item.workItemRef}`),
    ),
  )

  return (
    <div
      className="employee-graph-shell"
      data-mode={props.mode}
      data-testid="digital-employee-responsibility-graph"
    >
      <svg
        className="employee-graph"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={
          props.language.startsWith('zh')
            ? '数字员工确定性职责全景图'
            : 'Deterministic digital employee responsibility map'
        }
      >
        <defs>
          <marker
            id="employee-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
          <marker
            id="employee-arrow-active"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
            className="employee-graph__arrow--active"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>

        {layout.bands.map((band, index) => {
          const region = regions.find((candidate) => candidate.regionId === band.id)!
          return (
            <g key={band.id} className="employee-graph__region">
              <rect
                x="1"
                y={band.y + 1}
                width={layout.width - 2}
                height={band.height - 2}
                rx="18"
                className={`employee-graph__region-bg employee-graph__region-bg--${index % 3}`}
              />
              <text x={PADDING_X} y={band.y + 28} className="employee-graph__region-title">
                {localized(region.label, props.language)}
              </text>
              <text x={PADDING_X} y={band.y + 48} className="employee-graph__region-description">
                {localized(region.description, props.language)}
              </text>
              {band.lanes.map((lane) => (
                <g key={lane.id} className="employee-graph__lane">
                  <rect
                    x={PADDING_X / 2}
                    y={lane.y}
                    width={layout.width - PADDING_X}
                    height={lane.height}
                    rx="12"
                    className={`employee-graph__lane-bg employee-graph__lane-bg--${lane.kind}`}
                  />
                  <foreignObject
                    x={PADDING_X}
                    y={lane.y}
                    width={LANE_LABEL_WIDTH - 18}
                    height={lane.height}
                  >
                    <div className="employee-graph-lane-label" data-lane-kind={lane.kind}>
                      <strong>{localized(lane.label, props.language)}</strong>
                      <span>{localized(lane.description, props.language)}</span>
                    </div>
                  </foreignObject>
                </g>
              ))}
            </g>
          )
        })}

        <g className="employee-graph__edges" aria-hidden="true">
          {edges.flatMap(({ source, target, loop }) => {
            const edgeKey = `${source.item.workItemRef}:${target.item.workItemRef}`
            if (dispatchEdgeKeys.has(edgeKey)) return []
            const active =
              props.selectedWorkItemRef === source.item.workItemRef ||
              props.selectedWorkItemRef === target.item.workItemRef
            return [
              <path
                key={edgeKey}
                data-from={source.item.workItemRef}
                data-to={target.item.workItemRef}
                className={`${active ? 'employee-graph__edge--active' : ''}${
                  loop ? ' employee-graph__edge--loop' : ''
                }`}
                d={edgePath(
                  source,
                  target,
                  layout.bands[source.regionIndex]!,
                  layout.bands[target.regionIndex]!,
                  layout.width,
                  loop,
                )}
                markerEnd={active ? 'url(#employee-arrow-active)' : 'url(#employee-arrow)'}
                vectorEffect="non-scaling-stroke"
              />,
            ]
          })}
          {[...dispatchGroups.entries()].flatMap(([sourceRef, group], groupIndex) => {
            const source = group[0]?.source
            if (source === undefined) return []
            const branchTopYs = group.map(({ target }) => target.y - 6)
            const busStartY = Math.min(...branchTopYs)
            const busEndY = Math.max(...branchTopYs)
            const busX = PADDING_X + LANE_LABEL_WIDTH - 12 - groupIndex * 5
            const sourceCenterX = source.x + NODE_WIDTH / 2
            const sourceBottom = source.y + NODE_HEIGHT
            const sourceSelected = props.selectedWorkItemRef === source.item.workItemRef
            const selectedBranch = group.find(
              ({ target }) => props.selectedWorkItemRef === target.item.workItemRef,
            )
            return [
              <path
                key={`${sourceRef}:dispatch-trunk`}
                className={`employee-graph__dispatch-trunk${
                  sourceSelected ? ' employee-graph__edge--active' : ''
                }`}
                d={`M ${sourceCenterX} ${sourceBottom} V ${busStartY} H ${busX} V ${busEndY}`}
                vectorEffect="non-scaling-stroke"
              />,
              selectedBranch === undefined || sourceSelected ? null : (
                <path
                  key={`${sourceRef}:dispatch-selection`}
                  className="employee-graph__dispatch-trunk employee-graph__edge--active"
                  d={`M ${sourceCenterX} ${sourceBottom} V ${busStartY} H ${busX} V ${
                    selectedBranch.target.y - 6
                  }`}
                  vectorEffect="non-scaling-stroke"
                />
              ),
              ...group.map(({ target }) => {
                const active =
                  props.selectedWorkItemRef === source.item.workItemRef ||
                  props.selectedWorkItemRef === target.item.workItemRef
                const branchY = target.y - 6
                return (
                  <path
                    key={`${sourceRef}:${target.item.workItemRef}`}
                    data-from={sourceRef}
                    data-to={target.item.workItemRef}
                    className={`employee-graph__dispatch-branch${
                      active ? ' employee-graph__edge--active' : ''
                    }`}
                    d={`M ${busX} ${branchY} H ${target.x - 10} V ${
                      target.y + NODE_HEIGHT / 2
                    } H ${target.x}`}
                    markerEnd={active ? 'url(#employee-arrow-active)' : 'url(#employee-arrow)'}
                    vectorEffect="non-scaling-stroke"
                  />
                )
              }),
            ]
          })}
        </g>

        {layout.nodes.map(({ item, x, y }) => {
          const selected = props.selectedWorkItemRef === item.workItemRef
          const count = props.toolCounts?.[item.workItemRef] ?? 0
          return (
            <foreignObject
              key={item.workItemRef}
              x={x}
              y={y}
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
            >
              <button
                type="button"
                className={`employee-graph-node${selected ? ' employee-graph-node--selected' : ''}`}
                data-node-kind={item.nodeKind}
                data-testid={`employee-work-item-${item.workItemRef}`}
                aria-pressed={selected}
                onClick={() => props.onSelect(item.workItemRef)}
              >
                <span className="employee-graph-node__kind" aria-hidden="true">
                  {item.nodeKind === 'business-tool'
                    ? props.language.startsWith('zh')
                      ? '工具'
                      : 'Tool'
                    : item.nodeKind === 'system'
                      ? props.language.startsWith('zh')
                        ? '平台'
                        : 'Platform'
                      : props.language.startsWith('zh')
                        ? '协同'
                        : 'Delegate'}
                </span>
                <strong>{localized(item.label, props.language)}</strong>
                <span>{localized(item.description, props.language)}</span>
                {props.mode === 'toolbox' && item.nodeKind === 'business-tool' ? (
                  <small>
                    {props.language.startsWith('zh') ? `${count} 个工具` : `${count} tools`}
                  </small>
                ) : null}
              </button>
            </foreignObject>
          )
        })}
      </svg>
    </div>
  )
}

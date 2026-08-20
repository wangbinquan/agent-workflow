import type { ReactElement } from 'react'

import type { EmployeeTypePackage, WorkItem } from './types'
import { localized } from './types'

interface NodeLayout {
  item: WorkItem
  regionIndex: number
  row: number
  column: number
  x: number
  y: number
}

interface BandLayout {
  id: string
  y: number
  height: number
}

const NODE_WIDTH = 226
const NODE_HEIGHT = 86
const COLUMN_GAP = 44
const ROW_GAP = 34
const BAND_GAP = 28
const PADDING_X = 42
const BAND_HEADER = 62
const COLUMNS = 4

function edgePath(
  source: NodeLayout,
  target: NodeLayout,
  sourceBand: BandLayout,
  targetBand: BandLayout,
  laneIndex: number,
): string {
  const sourceRight = source.x + NODE_WIDTH
  const sourceCenterY = source.y + NODE_HEIGHT / 2
  const targetCenterY = target.y + NODE_HEIGHT / 2

  if (
    source.regionIndex === target.regionIndex &&
    source.row === target.row &&
    target.column === source.column + 1
  ) {
    return `M ${sourceRight} ${sourceCenterY} H ${target.x}`
  }

  const laneOffset = (laneIndex % 4) * 4
  let laneY: number
  if (source.regionIndex !== target.regionIndex) {
    const upper = sourceBand.y < targetBand.y ? sourceBand : targetBand
    const lower = sourceBand.y < targetBand.y ? targetBand : sourceBand
    laneY = upper.y + upper.height + (lower.y - upper.y - upper.height) / 2 + laneOffset - 6
  } else if (target.row > 0) {
    laneY = target.y - ROW_GAP / 2 + laneOffset - 6
  } else {
    laneY = target.y + NODE_HEIGHT + ROW_GAP / 2 + laneOffset - 6
  }

  const sourceLaneX = sourceRight + 10 + (laneIndex % 3) * 4
  const targetLaneX = target.x - 10 - (laneIndex % 3) * 4
  return [
    `M ${sourceRight} ${sourceCenterY}`,
    `H ${sourceLaneX}`,
    `V ${laneY}`,
    `H ${targetLaneX}`,
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
  const layouts: NodeLayout[] = []
  const bands: BandLayout[] = []
  let y = 0
  for (const [regionIndex, region] of regions.entries()) {
    const items = props.type.authoringManifest.workItems
      .filter((item) => item.regionId === region.regionId)
      .sort((left, right) => left.order - right.order)
    const rows = Math.max(1, Math.ceil(items.length / COLUMNS))
    const height = BAND_HEADER + rows * NODE_HEIGHT + Math.max(0, rows - 1) * ROW_GAP + 32
    bands.push({ id: region.regionId, y, height })
    items.forEach((item, index) => {
      const row = Math.floor(index / COLUMNS)
      const column = index % COLUMNS
      layouts.push({
        item,
        regionIndex,
        row,
        column,
        x: PADDING_X + column * (NODE_WIDTH + COLUMN_GAP),
        y: y + BAND_HEADER + row * (NODE_HEIGHT + ROW_GAP),
      })
    })
    y += height + BAND_GAP
  }
  const width = PADDING_X * 2 + COLUMNS * NODE_WIDTH + (COLUMNS - 1) * COLUMN_GAP
  const height = Math.max(320, y - BAND_GAP)
  const byRef = new Map(layouts.map((layout) => [layout.item.workItemRef, layout] as const))

  return (
    <div
      className="employee-graph-shell"
      data-mode={props.mode}
      data-testid="digital-employee-responsibility-graph"
    >
      <svg
        className="employee-graph"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={
          props.language.startsWith('zh')
            ? '数字员工确定性职责全景图'
            : 'Deterministic digital employee responsibility map'
        }
      >
        {bands.map((band, index) => {
          const region = regions.find((candidate) => candidate.regionId === band.id)!
          return (
            <g key={band.id} className="employee-graph__region">
              <rect
                x="1"
                y={band.y + 1}
                width={width - 2}
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
            </g>
          )
        })}

        <g className="employee-graph__edges" aria-hidden="true">
          {layouts.flatMap((source) =>
            source.item.nextWorkItemRefs.flatMap((targetRef, targetIndex) => {
              const target = byRef.get(targetRef)
              if (target === undefined) return []
              const active =
                props.selectedWorkItemRef === source.item.workItemRef ||
                props.selectedWorkItemRef === target.item.workItemRef
              const loop =
                target.regionIndex < source.regionIndex ||
                (target.regionIndex === source.regionIndex &&
                  target.item.order <= source.item.order)
              return [
                <path
                  key={`${source.item.workItemRef}:${targetRef}`}
                  className={`${active ? 'employee-graph__edge--active' : ''}${
                    loop ? ' employee-graph__edge--loop' : ''
                  }`}
                  d={edgePath(
                    source,
                    target,
                    bands[source.regionIndex]!,
                    bands[target.regionIndex]!,
                    targetIndex,
                  )}
                  markerEnd={active ? 'url(#employee-arrow-active)' : 'url(#employee-arrow)'}
                  vectorEffect="non-scaling-stroke"
                />,
              ]
            }),
          )}
        </g>
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

        {layouts.map(({ item, x, y: nodeY }) => {
          const selected = props.selectedWorkItemRef === item.workItemRef
          const count = props.toolCounts?.[item.workItemRef] ?? 0
          return (
            <foreignObject
              key={item.workItemRef}
              x={x}
              y={nodeY}
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

import type { CSSProperties, ReactElement } from 'react'

import { StatusChip } from '@/components/StatusChip'

import type { EmployeeTypePackage, ToolRegistration, WorkItem } from './types'
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
  | { kind: 'dispatch'; node: ResponsibilityDispatchNode }

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
  cardState?: (item: WorkItem) => {
    state: 'configured' | 'missing' | 'neutral' | 'running' | 'failed' | 'completed' | 'waiting'
    detail: string
    compactDetail?: string
    attention?: boolean
  }
  dispatchNodes?: readonly ResponsibilityDispatchNode[]
  selectedDispatchNodeKey?: string | null
  onSelectDispatchNode?: (node: ResponsibilityDispatchNode) => void
}): ReactElement {
  const zh = props.language.startsWith('zh')
  const workItemsByRef = new Map(
    props.type.authoringManifest.workItems.map((item) => [item.workItemRef, item]),
  )
  const regions = [...props.type.authoringManifest.lifecycleRegions].sort(
    (left, right) => left.order - right.order,
  )
  const nodeKind = (item: WorkItem): { label: string; className: string } =>
    item.nodeKind === 'business-tool'
      ? { label: zh ? '工具' : 'Tool', className: 'tool' }
      : item.nodeKind === 'system'
        ? { label: zh ? '平台' : 'Platform', className: 'platform' }
        : { label: zh ? '协同' : 'Collaboration', className: 'collaboration' }

  return (
    <section
      className={`employee-toolbox-map${props.compactChrome === true ? ' employee-toolbox-map--compact' : ''}`}
      aria-label={zh ? '确定性职责全景' : 'Deterministic responsibility map'}
      data-testid="employee-toolbox-responsibility-map"
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
          const lanes = [...region.responsibilityLanes].sort(
            (left, right) => left.order - right.order,
          )
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
                  const items = props.type.authoringManifest.workItems
                    .filter(
                      (item) =>
                        item.regionId === region.regionId &&
                        item.responsibilityLaneId === lane.laneId,
                    )
                    .sort((left, right) => left.order - right.order)
                  if (items.length === 0) return null
                  const itemRefs = new Set(items.map((item) => item.workItemRef))
                  const laneDispatchNodes = (props.dispatchNodes ?? []).filter((node) =>
                    itemRefs.has(node.classifierWorkItemRef),
                  )
                  const replacedDestinationRefs = new Set(
                    laneDispatchNodes
                      .filter((node) => itemRefs.has(node.destinationWorkItemRef))
                      .map((node) => node.destinationWorkItemRef),
                  )
                  const entries: ResponsibilityMapEntry[] = items.flatMap((item) => {
                    if (replacedDestinationRefs.has(item.workItemRef)) return []
                    return [
                      { kind: 'item' as const, item },
                      ...laneDispatchNodes
                        .filter((node) => node.classifierWorkItemRef === item.workItemRef)
                        .map((node) => ({ kind: 'dispatch' as const, node })),
                    ]
                  })
                  const laneColumns = Math.min(entries.length, 4)
                  return (
                    <section
                      key={lane.laneId}
                      className={`employee-toolbox-lane employee-toolbox-lane--${lane.kind}`}
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
                          </div>
                          <strong>{localized(lane.label, props.language)}</strong>
                        </div>
                      </header>
                      <span className="employee-toolbox-lane__axis" aria-hidden="true">
                        <span />
                      </span>
                      <div
                        className="employee-toolbox-lane__cards"
                        style={{ '--employee-lane-columns': laneColumns } as CSSProperties}
                      >
                        {entries.map((entry, itemIndex) => {
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
                          const kind = nodeKind(item)
                          const fanOut = item.inputMultiplicity === 'collection'
                          const state = props.cardState?.(item)
                          const availableTools = (
                            props.toolsByWorkItem?.[item.workItemRef] ?? []
                          ).filter((tool) => tool.state === 'published').length
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
                                item.workItemRef === props.selectedWorkItemRef
                                  ? ' employee-toolbox-card--active'
                                  : ''
                              }${itemIndex > 0 && itemIndex % laneColumns === 0 ? ' employee-toolbox-card--row-start' : ''}`}
                              aria-pressed={item.workItemRef === props.selectedWorkItemRef}
                              aria-label={`${localized(item.label, props.language)} · ${kind.label}${
                                fanOut ? (zh ? ' · 多项扇出' : ' · Fan-out collection') : ''
                              } · ${detail} · ${next}`}
                              title={localized(item.description, props.language)}
                              onClick={() => props.onSelect(item.workItemRef)}
                            >
                              {fanOut ? (
                                <>
                                  <span
                                    className="employee-toolbox-card__stack-layer employee-toolbox-card__stack-layer--back"
                                    aria-hidden="true"
                                  />
                                  <span
                                    className="employee-toolbox-card__stack-layer employee-toolbox-card__stack-layer--middle"
                                    aria-hidden="true"
                                  />
                                </>
                              ) : null}
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

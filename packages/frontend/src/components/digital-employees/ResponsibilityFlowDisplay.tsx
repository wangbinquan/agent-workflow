import type { ButtonHTMLAttributes, CSSProperties, ReactElement, ReactNode } from 'react'

import type { WorkIngress, WorkItem } from './types'
import { localized } from './types'

export type ResponsibilityIngressRouteKind = 'standard' | 'bypass'

export type ResponsibilityProjectedIngress = WorkIngress & {
  sourceIngress: WorkIngress
  routeKind: ResponsibilityIngressRouteKind
}

export interface ResponsibilityCardPresentation {
  kind: { label: string; className: string }
  fanOut: boolean
  state?: {
    state: string
    attention?: boolean
  }
  detail: string
  compactDetail: string
  next: string
}

export interface ResponsibilityFlowConnectorProps {
  kind: 'axis' | 'ingress-target' | 'sequence'
  className?: string
  targetRef?: string
}

/** One shared line-and-solid-arrow primitive for every horizontal card edge. */
export function ResponsibilityFlowConnector(props: ResponsibilityFlowConnectorProps): ReactElement {
  return (
    <span
      className={`employee-responsibility-flow-connector employee-responsibility-flow-connector--${props.kind}${props.className === undefined ? '' : ` ${props.className}`}`}
      data-responsibility-flow-connector={props.kind}
      data-ingress-route-arrow-to={props.targetRef}
      aria-hidden="true"
    >
      <svg
        className="employee-responsibility-flow-connector__line"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <ResponsibilityFlowPath d="M 0 50 H 100" />
      </svg>
      <svg
        className="employee-responsibility-flow-connector__arrow"
        viewBox="0 0 4 6"
        preserveAspectRatio="none"
        aria-hidden="true"
        data-flow-arrow
      >
        <ResponsibilityFlowArrow />
      </svg>
    </span>
  )
}

export function ResponsibilityLaneAxis(): ReactElement {
  return (
    <span className="employee-toolbox-lane__axis" aria-hidden="true">
      <ResponsibilityFlowConnector kind="axis" />
    </span>
  )
}

export interface ResponsibilityFlowCardProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  kindLabel: ReactNode
  label: ReactNode
  detailText?: ReactNode
  detailTitle?: string
  nextText?: string
  incoming?: boolean
}

/** Shared visual card used by ingress, tool, platform, review and dispatch nodes. */
export function ResponsibilityFlowCard(props: ResponsibilityFlowCardProps): ReactElement {
  const {
    kindLabel,
    label,
    detailText,
    detailTitle,
    nextText,
    incoming = false,
    className,
    ...buttonProps
  } = props
  return (
    <button
      {...buttonProps}
      className={`employee-toolbox-card${className === undefined ? '' : ` ${className}`}`}
    >
      {incoming ? <ResponsibilityFlowConnector kind="sequence" /> : null}
      <span className="employee-toolbox-card__kind">{kindLabel}</span>
      <strong>{label}</strong>
      {detailText === undefined ? null : <small title={detailTitle}>{detailText}</small>}
      {nextText === undefined ? null : <span className="sr-only">{nextText}</span>}
    </button>
  )
}

export interface ResponsibilityIngressCardProps {
  ingress: ResponsibilityProjectedIngress
  language: string
  cardIdPrefix: string
  sourceNode?: boolean
  auxiliary?: { column: number; row: number }
  nextLabel: string
  readOnly?: boolean
  onConfigure?: (ingress: WorkIngress) => void
}

export function ResponsibilityIngressCard(props: ResponsibilityIngressCardProps): ReactElement {
  const zh = props.language.startsWith('zh')
  const action =
    props.ingress.configurationSurface === 'task-creation'
      ? zh
        ? '去新建任务'
        : 'Create task'
      : zh
        ? '去 Webhook 配置'
        : 'Configure Webhook'
  const auxiliaryStyle =
    props.sourceNode === true
      ? undefined
      : ({
          '--employee-aux-column': props.auxiliary?.column ?? 1,
          '--employee-aux-row': props.auxiliary?.row ?? 1,
        } as CSSProperties)

  return (
    <ResponsibilityFlowCard
      id={`${props.cardIdPrefix}-ingress-${props.ingress.ingressRef}`}
      data-work-ingress-ref={props.ingress.ingressRef}
      data-capability-tool-ref={`ingress:${props.ingress.ingressRef}`}
      data-next-work-item-ref={props.ingress.nextWorkItemRef}
      data-ingress-route={props.ingress.routeKind}
      type="button"
      className={`employee-toolbox-card--ingress ${
        props.sourceNode === true
          ? 'employee-toolbox-card--source-node'
          : 'employee-toolbox-card--auxiliary'
      }`}
      style={auxiliaryStyle}
      aria-label={`${localized(props.ingress.label, props.language)} · ${localized(props.ingress.valueLabel, props.language)} · ${action} · ${zh ? '下一步' : 'Next'}：${props.nextLabel}`}
      title={localized(props.ingress.description, props.language)}
      disabled={props.readOnly === true}
      onClick={() => props.onConfigure?.(props.ingress.sourceIngress)}
      kindLabel={localized(props.ingress.valueLabel, props.language)}
      label={localized(props.ingress.label, props.language)}
      detailText={props.sourceNode === true ? undefined : `→ ${props.nextLabel}`}
      detailTitle={action}
    />
  )
}

interface IngressRoute {
  routeId: string
  targetRef: string
  sourceY: number
  kind: ResponsibilityIngressRouteKind
}

function ResponsibilityFlowPath(props: {
  d: string
  route?: IngressRoute
  className?: string
}): ReactElement {
  return (
    <path
      className={`employee-responsibility-flow-path${props.className === undefined ? '' : ` ${props.className}`}`}
      d={props.d}
      vectorEffect="non-scaling-stroke"
      data-ingress-route-from={props.route?.routeId}
      data-ingress-route-to={props.route?.targetRef}
    />
  )
}

/** The only arrowhead used by the responsibility panorama. */
function ResponsibilityFlowArrow(): ReactElement {
  return <polygon className="employee-responsibility-flow-arrow" points="0,0 4,3 0,6" />
}

export interface ResponsibilityIngressRoutesProps {
  ingresses: readonly ResponsibilityProjectedIngress[]
}

/**
 * Data-driven ingress router. It draws shared trunks and exactly one target
 * arrow per destination, regardless of how many source cards feed that route.
 */
export function ResponsibilityIngressRoutes(props: ResponsibilityIngressRoutesProps): ReactElement {
  const denominator = props.ingresses.length * 60 - 4
  const routes: IngressRoute[] = props.ingresses.map((ingress, index) => ({
    routeId: ingress.ingressRef,
    targetRef: ingress.nextWorkItemRef,
    sourceY: ((index * 60 + 28) / denominator) * 100,
    kind: ingress.routeKind,
  }))
  const targetRoutes = routes.filter((route) => route.kind === 'standard')
  const continuationRoutes = routes.filter((route) => route.kind === 'bypass')
  const span = (selected: readonly IngressRoute[]): [number, number] => {
    const centers = [50, ...selected.map((route) => route.sourceY)]
    return [Math.min(...centers), Math.max(...centers)]
  }
  const [targetTop, targetBottom] = span(targetRoutes)
  const [continuationTop, continuationBottom] = span(continuationRoutes)

  return (
    <>
      <svg
        className="employee-toolbox-ingress-branch__routing"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
        data-ingress-routing
      >
        {targetRoutes.map((route) => (
          <ResponsibilityFlowPath
            key={route.routeId}
            d={`M 46 ${route.sourceY} H 48`}
            route={route}
          />
        ))}
        {targetRoutes.length === 0 ? null : (
          <>
            <ResponsibilityFlowPath d={`M 48 ${targetTop} V ${targetBottom}`} />
            <ResponsibilityFlowPath d="M 48 50 H 46" />
          </>
        )}
        {continuationRoutes.map((route) => (
          <ResponsibilityFlowPath
            key={route.routeId}
            d={`M 46 ${route.sourceY} H 101`}
            route={route}
          />
        ))}
        {continuationRoutes.length === 0 ? null : (
          <>
            <ResponsibilityFlowPath d={`M 101 ${continuationTop} V ${continuationBottom}`} />
            <ResponsibilityFlowPath d="M 101 50 H 100" />
          </>
        )}
      </svg>
      {targetRoutes.length === 0 ? null : (
        <ResponsibilityFlowConnector kind="ingress-target" targetRef={targetRoutes[0]!.targetRef} />
      )}
    </>
  )
}

export interface ResponsibilityIngressBranchProps {
  item: WorkItem
  ingresses: readonly ResponsibilityProjectedIngress[]
  presentation: ResponsibilityCardPresentation
  language: string
  cardIdPrefix: string
  selected: boolean
  incoming: boolean
  rowStart: boolean
  readOnly?: boolean
  onSelect: () => void
  onConfigureIngress?: (ingress: WorkIngress) => void
  nextLabelFor: (ingress: ResponsibilityProjectedIngress) => string
}

export function ResponsibilityIngressBranch(props: ResponsibilityIngressBranchProps): ReactElement {
  const { kind, fanOut, state, detail, compactDetail, next } = props.presentation
  return (
    <div
      className={`employee-toolbox-ingress-branch${
        props.rowStart ? ' employee-toolbox-ingress-branch--row-start' : ''
      }`}
      data-ingress-branch-work-item-ref={props.item.workItemRef}
      aria-label={
        props.language.startsWith('zh')
          ? `工作来源汇聚到${localized(props.item.label, props.language)}`
          : `Work sources converge on ${localized(props.item.label, props.language)}`
      }
    >
      {props.incoming ? <ResponsibilityFlowConnector kind="sequence" /> : null}
      <div className="employee-toolbox-ingress-branch__sources">
        {props.ingresses.map((ingress) => (
          <ResponsibilityIngressCard
            key={ingress.ingressRef}
            ingress={ingress}
            language={props.language}
            cardIdPrefix={props.cardIdPrefix}
            sourceNode
            nextLabel={props.nextLabelFor(ingress)}
            readOnly={props.readOnly}
            onConfigure={props.onConfigureIngress}
          />
        ))}
      </div>
      <span className="employee-toolbox-ingress-branch__merge" aria-hidden="true" />
      <ResponsibilityIngressRoutes ingresses={props.ingresses} />
      <ResponsibilityFlowCard
        id={`${props.cardIdPrefix}-${props.item.workItemRef}`}
        data-work-item-ref={props.item.workItemRef}
        data-capability-tool-ref={`work-item:${props.item.workItemRef}`}
        type="button"
        className={`employee-toolbox-card--${kind.className}${
          state === undefined ? '' : ` employee-toolbox-card--${state.state}`
        }${fanOut ? ' employee-toolbox-card--fan-out' : ''}${
          state?.attention === true ? ' employee-toolbox-card--attention' : ''
        }${props.selected ? ' employee-toolbox-card--active' : ''}`}
        aria-pressed={props.selected}
        aria-label={`${localized(props.item.label, props.language)} · ${kind.label} · ${detail} · ${next}`}
        title={localized(props.item.description, props.language)}
        disabled={props.readOnly === true}
        onClick={props.onSelect}
        kindLabel={kind.label}
        label={localized(props.item.label, props.language)}
        detailText={compactDetail}
        detailTitle={detail}
        nextText={next}
      />
    </div>
  )
}

export interface ResponsibilityReviewBypassProps {
  label: string
}

export function ResponsibilityReviewBypass(props: ResponsibilityReviewBypassProps): ReactElement {
  return (
    <span className="employee-toolbox-review-branch__bypass" data-review-bypass>
      <svg
        className="employee-toolbox-review-branch__bypass-route"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <ResponsibilityFlowPath d="M 0 100 V 0 H 100 V 100" />
      </svg>
      <span className="employee-toolbox-review-branch__bypass-label">{props.label}</span>
      <span className="employee-toolbox-review-branch__bypass-join" data-review-bypass-join />
    </span>
  )
}

export interface ResponsibilityReviewGateDisplay {
  parentWorkItemRef: string
  optionRef: string
  label: WorkItem['label']
  description: WorkItem['description']
}

export interface ResponsibilityReviewBranchProps {
  item: WorkItem
  gate: ResponsibilityReviewGateDisplay
  mode: 'conditional' | 'active'
  presentation: ResponsibilityCardPresentation
  language: string
  cardIdPrefix: string
  beforeReviewLabel: string
  planningDescription: string
  planningRoleRef: string
  planningSlotRef: string
  planningPresentation?: Pick<ResponsibilityCardPresentation, 'detail' | 'compactDetail'>
  gateDetail: string
  gateState?: { state: string; attention?: boolean }
  beforeReviewState?: string
  afterApprovalState?: string
  gateSelected: boolean
  planningSelected: boolean
  itemSelected: boolean
  incoming: boolean
  rowStart: boolean
  readOnly?: boolean
  onSelectPlanning: () => void
  onSelectItem: () => void
  onSelectGate: () => void
}

export function ResponsibilityReviewBranch(props: ResponsibilityReviewBranchProps): ReactElement {
  const zh = props.language.startsWith('zh')
  const { kind, fanOut, state, detail, compactDetail, next } = props.presentation
  return (
    <div
      className={`employee-toolbox-review-branch${
        props.mode === 'conditional' ? ' employee-toolbox-review-branch--conditional' : ''
      }${props.rowStart ? ' employee-toolbox-review-branch--row-start' : ''}`}
      data-review-branch-work-item-ref={props.item.workItemRef}
      aria-label={
        props.mode === 'active'
          ? zh
            ? `${localized(props.item.label, props.language)}的已启用审核路径`
            : `Active review path for ${localized(props.item.label, props.language)}`
          : zh
            ? `${localized(props.item.label, props.language)}的审核分支`
            : `Review branches for ${localized(props.item.label, props.language)}`
      }
    >
      {props.incoming ? <ResponsibilityFlowConnector kind="sequence" /> : null}
      {props.mode === 'conditional' ? (
        <ResponsibilityReviewBypass label={zh ? '无需人工审核' : 'No human review'} />
      ) : null}
      <div className="employee-toolbox-review-branch__prefix">
        <span className="employee-toolbox-review-branch__label">
          {zh ? '需人工审核' : 'Human review required'}
        </span>
        <div className="employee-toolbox-review-branch__reviewed-flow">
          <ResponsibilityFlowCard
            type="button"
            className={`employee-toolbox-card--${kind.className} employee-toolbox-card--review-stage${
              props.beforeReviewState === undefined
                ? ''
                : ` employee-toolbox-card--${props.beforeReviewState}`
            }${props.planningSelected ? ' employee-toolbox-card--active' : ''}`}
            data-review-stage="analysis"
            data-capability-tool-ref={`review:${props.gate.optionRef}:analysis`}
            data-tool-role-ref={props.planningRoleRef}
            data-tool-slot-ref={props.planningSlotRef}
            aria-pressed={props.planningSelected}
            aria-label={`${props.beforeReviewLabel} · ${props.planningDescription}${
              props.planningPresentation === undefined
                ? ''
                : ` · ${props.planningPresentation.detail}`
            }`}
            title={props.planningPresentation?.detail ?? props.planningDescription}
            disabled={props.readOnly === true}
            onClick={props.onSelectPlanning}
            kindLabel={kind.label}
            label={props.beforeReviewLabel}
            detailText={props.planningPresentation?.compactDetail}
            detailTitle={props.planningPresentation?.detail}
          />
          <ResponsibilityFlowCard
            id={`${props.cardIdPrefix}-review-${props.gate.optionRef}`}
            data-review-option-ref={props.gate.optionRef}
            data-capability-tool-ref={`review:${props.gate.optionRef}`}
            type="button"
            className={`employee-toolbox-card--human-gate employee-toolbox-card--review-stage${
              props.gateState === undefined
                ? ''
                : ` employee-toolbox-card--${props.gateState.state}`
            }${
              props.gateState?.attention === true ? ' employee-toolbox-card--attention' : ''
            }${props.gateSelected ? ' employee-toolbox-card--active' : ''}`}
            aria-pressed={props.gateSelected}
            aria-label={`${localized(props.gate.label, props.language)} · ${zh ? '人工门禁' : 'Human gate'} · ${props.gateDetail}`}
            title={`${localized(props.gate.description, props.language)} · ${props.gateDetail}`}
            disabled={props.readOnly === true}
            onClick={props.onSelectGate}
            incoming
            kindLabel={zh ? '审核' : 'Review'}
            label={localized(props.gate.label, props.language)}
          />
        </div>
      </div>
      <div className="employee-toolbox-review-branch__merge-target">
        <ResponsibilityFlowCard
          id={`${props.cardIdPrefix}-${props.item.workItemRef}`}
          data-work-item-ref={props.item.workItemRef}
          data-capability-tool-ref={`work-item:${props.item.workItemRef}`}
          type="button"
          className={`employee-toolbox-review-branch__merged-item employee-toolbox-card--${kind.className}${
            props.afterApprovalState === undefined
              ? ''
              : ` employee-toolbox-card--${props.afterApprovalState}`
          }${fanOut ? ' employee-toolbox-card--fan-out' : ''}${
            state?.attention === true ? ' employee-toolbox-card--attention' : ''
          }${props.itemSelected ? ' employee-toolbox-card--active' : ''}`}
          aria-pressed={props.itemSelected}
          aria-label={`${localized(props.item.label, props.language)} · ${kind.label} · ${detail} · ${next}`}
          title={localized(props.item.description, props.language)}
          disabled={props.readOnly === true}
          onClick={props.onSelectItem}
          incoming
          kindLabel={kind.label}
          label={localized(props.item.label, props.language)}
          detailText={compactDetail}
          detailTitle={detail}
          nextText={next}
        />
      </div>
    </div>
  )
}

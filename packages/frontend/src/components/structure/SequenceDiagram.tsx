// RFC-085 T7 — custom-SVG UML sequence diagram for a method's forward call chain.
// No new dependency (consistent with the rest of the structure views, which are
// hand-rolled SVG/xyflow). Renderer is fed the PURE SequenceModel (lib/sequence),
// so it can be swapped without touching the data. Participants are columns
// (lifelines); messages are ordered top-to-bottom arrows; unresolved/external are
// dashed/dotted + muted.

import { useTranslation } from 'react-i18next'
import {
  classDisplay,
  seqDiagramLayout,
  seqHeadLabel,
  seqMessageLabel,
  SEQ_COL_W as COL_W,
  SEQ_HEAD_H as HEAD_H,
  SEQ_LABEL_GAP,
  SEQ_PAD as PAD,
  SEQ_ROW_H as ROW_H,
  UNRESOLVED_LIFELINE,
  type SequenceModel,
} from '@/lib/sequence'

export function SequenceDiagram({
  model,
  onOpenSource,
}: {
  model: SequenceModel
  /** RFC-258 — message labels jump to the callee's definition (resolved only). */
  onOpenSource?: (target: { structuralPath: string; qualifiedName: string }) => void
}) {
  const { t } = useTranslation()
  if (model.messages.length === 0) {
    return <div className="callchain__empty muted">{t('tasks.structCallNoCalls')}</div>
  }
  const cx = (p: string): number => {
    const i = Math.max(0, model.participants.indexOf(p))
    return PAD + i * COL_W + COL_W / 2
  }
  const { width, height } = seqDiagramLayout(model)
  const chartTop = HEAD_H + PAD

  return (
    <div className="seqdiag" data-testid="sequence-diagram">
      <svg width={width} height={height} role="img" aria-label={t('tasks.structSeqTitle')}>
        {/* lifelines */}
        {model.participants.map((p, i) => {
          const x = PAD + i * COL_W + COL_W / 2
          const unresolved = p === UNRESOLVED_LIFELINE
          const full = classDisplay(p)
          const drawn = seqHeadLabel(full)
          // impl-gate P1-7 — participant heads jump to the owner class/file.
          const headTarget = (() => {
            if (onOpenSource === undefined || unresolved) return null
            const sep = p.indexOf('::')
            if (sep < 0) return null
            return { structuralPath: p.slice(0, sep), qualifiedName: p.slice(sep + 2) }
          })()
          const headInteractive =
            headTarget === null
              ? {}
              : {
                  role: 'button' as const,
                  tabIndex: 0,
                  style: { cursor: 'pointer' } as const,
                  onClick: () => onOpenSource?.(headTarget),
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === 'Enter') onOpenSource?.(headTarget)
                  },
                }
          return (
            <g key={p} className={`seqdiag__life${unresolved ? ' seqdiag__life--unresolved' : ''}`}>
              <rect
                x={PAD + i * COL_W + 8}
                y={PAD - 4}
                width={COL_W - 16}
                height={HEAD_H - 8}
                rx={5}
                className="seqdiag__head"
              />
              <text
                x={x}
                y={PAD + HEAD_H / 2 - 2}
                textAnchor="middle"
                className="seqdiag__head-label"
                {...headInteractive}
              >
                {/* truncated to the fixed column; full name via <title> hover */}
                {drawn !== full && <title>{full}</title>}
                {drawn}
              </text>
              <line x1={x} y1={chartTop} x2={x} y2={height - PAD} className="seqdiag__lifeline" />
            </g>
          )
        })}
        {/* messages */}
        {model.messages.map((m, idx) => {
          const y = chartTop + (idx + 0.5) * ROW_H
          const x1 = cx(m.from)
          const x2 = cx(m.to)
          const self = x1 === x2
          const cls = `seqdiag__msg seqdiag__msg--${m.resolution}`
          const label = seqMessageLabel(m)
          const sourceTarget = (() => {
            if (onOpenSource === undefined || m.resolution !== 'resolved' || m.ref === undefined)
              return null
            const hash = m.ref.indexOf('#')
            return {
              structuralPath: hash < 0 ? m.ref : m.ref.slice(0, hash),
              qualifiedName: hash < 0 ? '' : m.ref.slice(hash + 1),
            }
          })()
          const labelInteractive =
            sourceTarget === null
              ? {}
              : {
                  role: 'button' as const,
                  tabIndex: 0,
                  style: { cursor: 'pointer' } as const,
                  onClick: () => onOpenSource?.(sourceTarget),
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === 'Enter') onOpenSource?.(sourceTarget)
                  },
                }
          if (self) {
            // self-call: a small loop to the right of the lifeline
            return (
              <g key={idx} className={cls}>
                <path
                  d={`M ${x1} ${y - 6} h 22 v 12 h -22`}
                  className="seqdiag__line"
                  fill="none"
                  markerEnd="url(#seq-arrow)"
                />
                <text x={x1 + 26} y={y - 8} className="seqdiag__msg-label" {...labelInteractive}>
                  {label}
                </text>
              </g>
            )
          }
          const dir = x2 > x1 ? 1 : -1
          // Left-align the label at the arrow's left endpoint (reading rightward)
          // instead of centering it — otherwise on long arrows (root calling a
          // far-right participant) the method name floats in the middle, far from
          // either lifeline. Anchoring at min(x1,x2) also keeps it inside the svg.
          return (
            <g key={idx} className={cls}>
              <text
                x={Math.min(x1, x2) + SEQ_LABEL_GAP}
                y={y - 6}
                textAnchor="start"
                className="seqdiag__msg-label"
                {...labelInteractive}
              >
                {label}
              </text>
              <line
                x1={x1}
                y1={y}
                x2={x2 - dir * 6}
                y2={y}
                className="seqdiag__line"
                markerEnd="url(#seq-arrow)"
              />
            </g>
          )
        })}
        <defs>
          <marker
            id="seq-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="6"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L6,3 L0,6 Z" className="seqdiag__arrowhead" />
          </marker>
        </defs>
      </svg>
    </div>
  )
}

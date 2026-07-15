// RFC-190 — the homepage hero's animated mini-pipeline, drawn as a REAL
// business flow (acceptance revision: the first cut showed "snapshot" and
// "aggregate" as standalone steps, but both are framework mechanics, not
// business nodes — the git wrapper CONTAINS the coder and yields git_diff
// from its before/after snapshots, and a multi-process node aggregates its
// own fan-out internally):
//
//   [input] → ┊GIT wrapper [code]┊ —git_diff→ audit ×3 (exploded fan-out)
//           → fix (fan-in lands directly; aggregation is implicit) → [output]
//
// Pure hand-written SVG + CSS animation (zero dependencies); node chrome
// echoes `.canvas-node`, the GIT wrapper echoes the editor's dashed blue
// `.canvas-node--wrapper-group--git` container, IO pills echo the canvas IO
// nodes — the hero rhymes with what users actually build on the canvas.
//
// - Fan edges carry the three brand gradients (stop values copied from the
//   sidebar logo, __root.tsx). Gradient ids are `aw-pipe-*` — the
//   `aw-stream-*` ids are source-locked to __root.tsx and duplicating DOM
//   ids would be invalid (design.md §1).
// - All motion lives in styles.css under `.pipeline-hero__edge` / `__dot` /
//   `__node--live` and is disabled per-selector under
//   `prefers-reduced-motion: reduce` (repo idiom).
// - The SVG is decorative: aria-hidden, with the wrapping <Link> carrying
//   the accessible name (a11y gate on `/`).

import { Link } from '@tanstack/react-router'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

/** Brand gradient stops — keep in sync with the sidebar logo (__root.tsx). */
const PIPE_GRADIENTS = [
  { id: 'aw-pipe-a', from: '#10b981', to: '#06b6d4' },
  { id: 'aw-pipe-b', from: '#3b82f6', to: '#a855f7' },
  { id: 'aw-pipe-c', from: '#ec4899', to: '#f97316' },
] as const

// Edge paths (SVG user units). The fan-out (wrapper's git_diff → audits) and
// fan-in (audits → fix) reuse these for both the stroke and the dot motion.
const EDGE_TRUNK: string[] = [
  'M 52 88 H 62', // input → git wrapper
  'M 486 88 H 496', // fix → output
]
const EDGE_FAN_OUT = [
  'M 186 88 C 212 88, 228 28, 254 28',
  'M 186 88 H 254',
  'M 186 88 C 212 88, 228 148, 254 148',
] as const
const EDGE_FAN_IN = [
  'M 338 28 C 364 28, 380 88, 406 88',
  'M 338 88 H 406',
  'M 338 148 C 364 148, 380 88, 406 88',
] as const

interface NodeSpec {
  x: number
  y: number
  w: number
  kind: string
  label: string
  live?: boolean
}

function PipelineNode({ node }: { node: NodeSpec }): ReactElement {
  return (
    <g className={`pipeline-hero__node${node.live === true ? ' pipeline-hero__node--live' : ''}`}>
      <rect
        className="pipeline-hero__node-box"
        x={node.x}
        y={node.y}
        width={node.w}
        height={40}
        rx={8}
      />
      <text className="pipeline-hero__kind" x={node.x + 12} y={node.y + 16}>
        {node.kind}
      </text>
      <text className="pipeline-hero__title" x={node.x + 12} y={node.y + 31}>
        {node.label}
      </text>
    </g>
  )
}

/** Small IO pill — the canvas input/output node, miniaturized. */
function IoPill({ x, w, label }: { x: number; w: number; label: string }): ReactElement {
  return (
    <g className="pipeline-hero__io">
      <rect className="pipeline-hero__io-box" x={x} y={76} width={w} height={24} rx={12} />
      <text className="pipeline-hero__io-text" x={x + w / 2} y={92} textAnchor="middle">
        {label}
      </text>
    </g>
  )
}

export function PipelineHero(): ReactElement {
  const { t } = useTranslation()
  const agentNodes: NodeSpec[] = [
    { x: 74, y: 76, w: 100, kind: 'AGENT', label: t('home.pipeline.code') },
    { x: 254, y: 8, w: 84, kind: 'AGENT', label: t('home.pipeline.audit'), live: true },
    { x: 254, y: 68, w: 84, kind: 'AGENT', label: t('home.pipeline.audit'), live: true },
    { x: 254, y: 128, w: 84, kind: 'AGENT', label: t('home.pipeline.audit'), live: true },
    { x: 406, y: 68, w: 80, kind: 'AGENT', label: t('home.pipeline.fix') },
  ]
  return (
    <Link
      to="/workflows"
      className="pipeline-hero"
      aria-label={t('home.pipeline.open')}
      data-testid="pipeline-hero"
    >
      <svg
        className="pipeline-hero__svg"
        viewBox="0 0 560 176"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          {PIPE_GRADIENTS.map((g) => (
            <linearGradient
              key={g.id}
              id={g.id}
              x1="0"
              y1="0"
              x2="560"
              y2="0"
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0" stopColor={g.from} />
              <stop offset="1" stopColor={g.to} />
            </linearGradient>
          ))}
        </defs>
        {/* GIT wrapper container around the coder — before/after snapshots
            live HERE (the editor's dashed blue wrapper-group, miniaturized). */}
        <rect
          className="pipeline-hero__wrapper-box"
          x={62}
          y={48}
          width={124}
          height={80}
          rx={10}
        />
        <text className="pipeline-hero__wrapper-label" x={74} y={62}>
          GIT
        </text>
        {EDGE_TRUNK.map((d) => (
          <path key={d} className="pipeline-hero__edge pipeline-hero__edge--trunk" d={d} />
        ))}
        {EDGE_FAN_OUT.map((d, i) => (
          <path
            key={d}
            className="pipeline-hero__edge"
            d={d}
            stroke={`url(#${PIPE_GRADIENTS[i]!.id})`}
          />
        ))}
        {EDGE_FAN_IN.map((d, i) => (
          <path
            key={d}
            className="pipeline-hero__edge"
            d={d}
            stroke={`url(#${PIPE_GRADIENTS[i]!.id})`}
          />
        ))}
        {/* The wrapper's output port name — the one piece of mechanism worth
            naming, because it IS the artifact the audits consume. */}
        <text className="pipeline-hero__edge-label" x={192} y={78}>
          git_diff
        </text>
        {[...EDGE_FAN_OUT, ...EDGE_FAN_IN].map((d) => (
          <circle
            key={`dot-${d}`}
            className="pipeline-hero__dot"
            r={2.4}
            style={{ offsetPath: `path('${d}')` }}
          />
        ))}
        <IoPill x={2} w={50} label={t('home.pipeline.input')} />
        <IoPill x={496} w={56} label={t('home.pipeline.output')} />
        {agentNodes.map((node, i) => (
          <PipelineNode key={i} node={node} />
        ))}
      </svg>
      <span className="pipeline-hero__caption">{t('home.pipeline.caption')}</span>
    </Link>
  )
}

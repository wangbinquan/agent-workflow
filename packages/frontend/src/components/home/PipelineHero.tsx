// RFC-190 — the homepage hero's animated mini-pipeline: the platform's core
// abstraction (git snapshot → code → audit ×3 fan-out → aggregate → fix)
// drawn as a small workflow canvas. Pure hand-written SVG + CSS animation
// (zero dependencies); node chrome echoes `.canvas-node` (panel bg / 1px
// border / 8px radius / uppercase kind label) so the hero visually rhymes
// with the workflow editor.
//
// - Fan-out edges carry the three brand gradients (stop values copied from
//   the sidebar logo, __root.tsx). Gradient ids are `aw-pipe-*` — the
//   `aw-stream-*` ids are source-locked to __root.tsx and duplicating DOM
//   ids would be invalid (design.md §1).
// - All motion lives in styles.css under `.pipeline-hero__edge` /
//   `__dot` / `__node--live` and is disabled per-selector under
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

// Edge paths (SVG user units). Fan-out (code → audits) and fan-in
// (audits → aggregate) reuse these for both the stroke and the dot motion.
const EDGE_TRUNK: string[] = [
  'M 100 88 H 128', // snapshot → code
  'M 468 88 H 488', // aggregate → fix
]
const EDGE_FAN_OUT = [
  'M 220 88 C 240 88, 236 28, 256 28',
  'M 220 88 H 256',
  'M 220 88 C 240 88, 236 148, 256 148',
] as const
const EDGE_FAN_IN = [
  'M 348 28 C 368 28, 362 88, 380 88',
  'M 348 88 H 380',
  'M 348 148 C 368 148, 362 88, 380 88',
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

export function PipelineHero(): ReactElement {
  const { t } = useTranslation()
  const nodes: NodeSpec[] = [
    { x: 8, y: 68, w: 92, kind: 'GIT', label: t('home.pipeline.snapshot') },
    { x: 128, y: 68, w: 92, kind: 'AGENT', label: t('home.pipeline.code') },
    { x: 256, y: 8, w: 92, kind: 'AGENT ×3', label: t('home.pipeline.audit'), live: true },
    { x: 256, y: 68, w: 92, kind: 'AGENT ×3', label: t('home.pipeline.audit'), live: true },
    { x: 256, y: 128, w: 92, kind: 'AGENT ×3', label: t('home.pipeline.audit'), live: true },
    { x: 380, y: 68, w: 88, kind: 'AGG', label: t('home.pipeline.aggregate') },
    { x: 488, y: 68, w: 64, kind: 'AGENT', label: t('home.pipeline.fix') },
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
        {[...EDGE_FAN_OUT, ...EDGE_FAN_IN].map((d) => (
          <circle
            key={`dot-${d}`}
            className="pipeline-hero__dot"
            r={2.4}
            style={{ offsetPath: `path('${d}')` }}
          />
        ))}
        {nodes.map((node, i) => (
          <PipelineNode key={i} node={node} />
        ))}
      </svg>
      <span className="pipeline-hero__caption">{t('home.pipeline.caption')}</span>
    </Link>
  )
}

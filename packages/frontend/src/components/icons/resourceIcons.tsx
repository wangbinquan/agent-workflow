// RFC-173 (T4) — the six inline line-icons for the AgentForm "resources & deps"
// tab: two group icons (Capabilities / Dependencies) + four resource-type icons
// (Skill / MCP / Plugin / Agent). No icon-library dependency — the repo idiom
// is inline SVG with stroke="currentColor" (see ChoiceCards' icon slot), so
// each icon inherits the surrounding text/accent colour and works in both
// themes. Each carries a unique `data-icon` so `agent-resources-groups.test`
// can assert all six render and are distinct.

import type { ReactNode } from 'react'

export type ResourceIconKey =
  | 'home'
  | 'agent'
  | 'skill'
  | 'mcp'
  | 'plugin'
  | 'workflow'
  | 'workgroup'
  | 'task'
  | 'schedule'
  | 'repo'
  | 'memory'

function IconSvg({ name, children }: { name: string; children: ReactNode }) {
  return (
    <svg
      data-icon={name}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

// ---- Group icons -------------------------------------------------------------

/** Capabilities group — a lightning bolt (power injected into the process). */
export const CAP_ICON: ReactNode = (
  <IconSvg name="cap">
    <path d="M8.5 1.5 3 9h3.5L6 14.5 13 7H9z" />
  </IconSvg>
)

/** Dependencies group — a small dependency graph (nodes + edges). */
export const DEP_ICON: ReactNode = (
  <IconSvg name="dep">
    <circle cx="4" cy="4" r="1.6" />
    <circle cx="4" cy="12" r="1.6" />
    <circle cx="12" cy="8" r="1.6" />
    <path d="M4 5.6v4.8M5.4 4.8 10.6 7.4" />
  </IconSvg>
)

// ---- Resource-type icons -----------------------------------------------------

/** Skill — an open book. */
export const SKILL_ICON: ReactNode = (
  <IconSvg name="skill">
    <path d="M8 3.2C6.8 2.4 5.3 2 3.5 2H2.5v9.2h1C5.3 11.2 6.8 11.6 8 12.4" />
    <path d="M8 3.2C9.2 2.4 10.7 2 12.5 2h1v9.2h-1c-1.8 0-3.3.4-4.5 1.2" />
    <path d="M8 3.2v9.2" />
  </IconSvg>
)

/** MCP server — two stacked server rows with status dots. */
export const MCP_ICON: ReactNode = (
  <IconSvg name="mcp">
    <rect x="2.5" y="2.5" width="11" height="4.4" rx="1.1" />
    <rect x="2.5" y="9.1" width="11" height="4.4" rx="1.1" />
    <path d="M4.8 4.7h.01M4.8 11.3h.01" />
  </IconSvg>
)

/** Plugin — a puzzle piece. */
export const PLUGIN_ICON: ReactNode = (
  <IconSvg name="plugin">
    <path d="M6.2 2.5a1.4 1.4 0 0 1 2.8 0c0 .5-.3.8-.3 1.2 0 .3.3.6.6.6h1.9a1 1 0 0 1 1 1v1.9c0 .3.3.6.6.6.4 0 .7-.3 1.2-.3a1.4 1.4 0 0 1 0 2.8c-.5 0-.8-.3-1.2-.3-.3 0-.6.3-.6.6v1.4a1 1 0 0 1-1 1H8.9c-.3 0-.6-.3-.6-.6 0-.4.3-.7.3-1.2a1.4 1.4 0 0 0-2.8 0c0 .5.3.8.3 1.2 0 .3-.3.6-.6.6H4a1 1 0 0 1-1-1V9.7c0-.3.3-.6.6-.6.4 0 .7.3 1.2.3a1.4 1.4 0 0 0 0-2.8c-.5 0-.8.3-1.2.3-.3 0-.6-.3-.6-.6V5.3a1 1 0 0 1 1-1h1.9c.3 0 .6-.3.6-.6 0-.4-.3-.7-.3-1.2z" />
  </IconSvg>
)

/** Agent — a simple bot head. */
export const AGENT_ICON: ReactNode = (
  <IconSvg name="agent">
    <rect x="3" y="5.2" width="10" height="7.6" rx="2" />
    <path d="M8 2.4V5.2" />
    <circle cx="8" cy="2" r="0.7" />
    <path d="M6.2 8.4h.01M9.8 8.4h.01" />
    <path d="M6.6 10.8h2.8" />
  </IconSvg>
)

// ---- RFC-190: capability-portal tile icons ------------------------------------
// Same 16×16 stroke idiom; consumed by the homepage CapabilityGrid (and any
// future surface that needs a per-resource glyph).

/** Workflow — three nodes joined by edges (a mini pipeline). */
export const WORKFLOW_ICON: ReactNode = (
  <IconSvg name="workflow">
    <rect x="1.8" y="6" width="4" height="4" rx="1" />
    <rect x="10.2" y="2.2" width="4" height="4" rx="1" />
    <rect x="10.2" y="9.8" width="4" height="4" rx="1" />
    <path d="M5.8 8h2.2M8 8V4.2h2.2M8 8v3.8h2.2" />
  </IconSvg>
)

/** Workgroup — a leader dot above two member dots. */
export const WORKGROUP_ICON: ReactNode = (
  <IconSvg name="workgroup">
    <circle cx="8" cy="4" r="1.9" />
    <circle cx="4" cy="11.4" r="1.9" />
    <circle cx="12" cy="11.4" r="1.9" />
    <path d="M6.8 5.6 5 9.7M9.2 5.6 11 9.7" />
  </IconSvg>
)

/** Memory — a labeled archive box (distilled knowledge). */
export const MEMORY_ICON: ReactNode = (
  <IconSvg name="memory">
    <rect x="2.5" y="2.8" width="11" height="3.2" rx="0.8" />
    <path d="M3.5 6v6.2a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6" />
    <path d="M6.4 8.6h3.2" />
  </IconSvg>
)

/** Scheduled — a clock face. */
export const SCHEDULE_ICON: ReactNode = (
  <IconSvg name="schedule">
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 4.8V8l2.4 1.6" />
  </IconSvg>
)

/** Repo — a git branch glyph. */
export const REPO_ICON: ReactNode = (
  <IconSvg name="repo">
    <circle cx="4.6" cy="3.6" r="1.7" />
    <circle cx="4.6" cy="12.4" r="1.7" />
    <circle cx="11.4" cy="6" r="1.7" />
    <path d="M4.6 5.3v5.4M11.4 7.7c0 2.6-2.6 2.6-5 3.4" />
  </IconSvg>
)

/** Task — a compact checklist for one execution record. */
export const TASK_ICON: ReactNode = (
  <IconSvg name="task">
    <path d="m2.7 4.2.9.9 1.7-1.8M2.7 8l.9.9 1.7-1.8M2.7 11.8l.9.9 1.7-1.8" />
    <path d="M7 4.2h6.2M7 8h6.2M7 11.8h6.2" />
  </IconSvg>
)

/** Home — a simple roof and doorway. */
export const HOME_ICON: ReactNode = (
  <IconSvg name="home">
    <path d="m2.5 7 5.5-4.5L13.5 7v6H9.8V9.5H6.2V13H2.5z" />
  </IconSvg>
)

const RESOURCE_ICONS: Record<ResourceIconKey, ReactNode> = {
  home: HOME_ICON,
  agent: AGENT_ICON,
  skill: SKILL_ICON,
  mcp: MCP_ICON,
  plugin: PLUGIN_ICON,
  workflow: WORKFLOW_ICON,
  workgroup: WORKGROUP_ICON,
  task: TASK_ICON,
  schedule: SCHEDULE_ICON,
  repo: REPO_ICON,
  memory: MEMORY_ICON,
}

export function ResourceIcon({ name }: { name: ResourceIconKey }) {
  return RESOURCE_ICONS[name]
}

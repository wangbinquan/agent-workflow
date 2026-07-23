// RFC-197 — localization-neutral view model for the agent.md import review.
// Keep every parser-owned field routed in one place so UI refactors cannot
// silently apply fields that the review screen forgot to disclose.

import type { AgentMarkdownParseResult, CreateAgent } from '@agent-workflow/shared'
import { agentSkillRefName } from '@agent-workflow/shared'
import type { AgentTab } from '@/components/AgentForm'

type AgentInputPort = NonNullable<CreateAgent['inputs']>[number]

interface PreviewItemBase {
  id: string
  field: string
}

export type AgentImportPreviewItem =
  | (PreviewItemBase & { kind: 'text'; value: string })
  | (PreviewItemBase & {
      kind: 'body'
      bytes: number
      lines: number
      excerpt: string
    })
  | (PreviewItemBase & { kind: 'inputs'; values: AgentInputPort[] })
  | (PreviewItemBase & { kind: 'list'; values: string[] })
  | (PreviewItemBase & { kind: 'map'; entries: Array<[string, string]> })
  | (PreviewItemBase & { kind: 'json'; value: string; entries: number })
  | (PreviewItemBase & {
      kind: 'extra'
      value: string
      valueType: string
    })

export interface AgentImportPreviewSection {
  tab: AgentTab
  items: AgentImportPreviewItem[]
}

export interface AgentImportPreview {
  sections: AgentImportPreviewSection[]
  itemCount: number
  sectionCount: number
  firstTab: AgentTab | null
}

const SECTION_ORDER: readonly AgentTab[] = ['basics', 'prompt', 'ports', 'resources', 'advanced']

export function describeAgentImport(result: AgentMarkdownParseResult): AgentImportPreview {
  const byTab: Record<AgentTab, AgentImportPreviewItem[]> = {
    basics: [],
    prompt: [],
    ports: [],
    resources: [],
    advanced: [],
  }
  const partial = result.partial

  addText(byTab.basics, 'name', partial.name)
  addText(byTab.basics, 'description', partial.description)
  addText(byTab.basics, 'runtime', partial.runtime)

  if (partial.bodyMd !== undefined) {
    byTab.prompt.push({
      id: 'bodyMd',
      field: 'bodyMd',
      kind: 'body',
      bytes: utf8Bytes(partial.bodyMd),
      lines: lineCount(partial.bodyMd),
      excerpt: firstContentExcerpt(partial.bodyMd),
    })
  }

  if (partial.inputs !== undefined) {
    byTab.ports.push({
      id: 'inputs',
      field: 'inputs',
      kind: 'inputs',
      values: partial.inputs,
    })
  }
  addList(byTab.ports, 'outputs', partial.outputs)
  addMap(byTab.ports, 'outputKinds', partial.outputKinds)
  addMap(byTab.ports, 'outputWrapperPortNames', partial.outputWrapperPortNames)

  // RFC-223 (PR-1): skills are typed refs; show them by display name.
  addList(byTab.resources, 'skills', partial.skills?.map(agentSkillRefName))
  addList(byTab.resources, 'dependsOn', partial.dependsOn)
  addList(byTab.resources, 'mcp', partial.mcp)
  addList(byTab.resources, 'plugins', partial.plugins)

  addText(byTab.advanced, 'role', partial.role)
  if (partial.permission !== undefined) {
    byTab.advanced.push({
      id: 'permission',
      field: 'permission',
      kind: 'json',
      value: safeDisplayValue(partial.permission),
      entries: Object.keys(partial.permission).length,
    })
  }
  if (partial.frontmatterExtra !== undefined) {
    for (const [key, value] of Object.entries(partial.frontmatterExtra)) {
      byTab.advanced.push({
        id: `frontmatterExtra.${key}`,
        field: key,
        kind: 'extra',
        value: safeDisplayValue(value),
        valueType: displayValueType(value),
      })
    }
  }

  const sections = SECTION_ORDER.flatMap((tab) => {
    const items = byTab[tab]
    return items.length === 0 ? [] : [{ tab, items }]
  })
  const itemCount = sections.reduce((total, section) => total + section.items.length, 0)
  return {
    sections,
    itemCount,
    sectionCount: sections.length,
    firstTab: sections[0]?.tab ?? null,
  }
}

function addText(target: AgentImportPreviewItem[], field: string, value: string | undefined): void {
  if (value === undefined) return
  target.push({ id: field, field, kind: 'text', value })
}

function addList(
  target: AgentImportPreviewItem[],
  field: string,
  value: string[] | undefined,
): void {
  if (value === undefined) return
  target.push({ id: field, field, kind: 'list', values: value })
}

function addMap(
  target: AgentImportPreviewItem[],
  field: string,
  value: Record<string, unknown> | undefined,
): void {
  if (value === undefined) return
  target.push({
    id: field,
    field,
    kind: 'map',
    entries: Object.entries(value).map(([key, entry]) => [key, String(entry)]),
  })
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function lineCount(value: string): number {
  return value === '' ? 0 : value.split(/\r\n?|\n/).length
}

function firstContentExcerpt(value: string): string {
  const line = value.split(/\r\n?|\n/).find((candidate) => candidate.trim() !== '') ?? ''
  const normalized = line.trim()
  return normalized.length > 160 ? `${normalized.slice(0, 157)}…` : normalized
}

function safeDisplayValue(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2)
    if (json !== undefined) return json
  } catch {
    // Fall through to String for circular or otherwise non-JSON values.
  }
  try {
    return String(value)
  } catch {
    return '[unrenderable]'
  }
}

function displayValueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

export type AgentMarkdownFileCheck = { ok: true; file: File } | { ok: false; reason: 'extension' }

export function validateAgentMarkdownFile(file: File): AgentMarkdownFileCheck {
  if (!/\.(?:md|markdown)$/i.test(file.name)) return { ok: false, reason: 'extension' }
  return { ok: true, file }
}

export function agentMarkdownFilenameStem(fileName: string): string {
  return fileName.replace(/\.(?:md|markdown)$/i, '')
}

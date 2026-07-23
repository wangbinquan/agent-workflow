// RFC-219 — pure view model for the workflow node catalog. Keeping category,
// search, recommended, and recent projection out of React makes the large-agent
// behavior directly testable and keeps the renderer focused on accessibility.

import type {
  PaletteItem,
  PaletteSection,
  PaletteSectionKey,
} from '@/components/canvas/nodePalette'

export type NodePickerCategory = 'all' | PaletteSectionKey
export type NodePickerGroupKey = 'recommended' | 'recent' | PaletteSectionKey

export interface NodePickerEntry {
  identity: string
  item: PaletteItem
  label: string
  description: string
  sectionKey: PaletteSectionKey
  sectionLabel: string
}

export interface NodePickerGroup {
  key: NodePickerGroupKey
  label: string
  entries: NodePickerEntry[]
}

export interface NodePickerCatalogModel {
  categoryCounts: Record<NodePickerCategory, number>
  groups: NodePickerGroup[]
  visibleEntryCount: number
}

export interface NodePickerCatalogLabels {
  recommended: string
  recent: string
}

export function workflowNodePickerIdentity(item: PaletteItem): string {
  return item.kind === 'agent-single' ? `agent:${item.agentId}` : `kind:${item.kind}`
}

function buildEntries(sections: readonly PaletteSection[]): NodePickerEntry[] {
  return sections.flatMap((section) =>
    section.items.map((entry) => ({
      identity: workflowNodePickerIdentity(entry.item),
      item: entry.item,
      label: entry.label,
      description: entry.description,
      sectionKey: section.key,
      sectionLabel: section.label,
    })),
  )
}

function recommendedEntries(entries: readonly NodePickerEntry[]): NodePickerEntry[] {
  const agents = entries.filter((entry) => entry.item.kind === 'agent-single').slice(0, 3)
  const commonKinds = new Set<PaletteItem['kind']>(['input', 'output', 'review'])
  const common = entries.filter((entry) => commonKinds.has(entry.item.kind))
  const chosen = [...agents, ...common]
  return (chosen.length > 0 ? chosen : entries).slice(0, 6)
}

function entryMatchesQuery(entry: NodePickerEntry, query: string): boolean {
  if (query === '') return true
  const haystack = [
    entry.label,
    entry.description,
    entry.item.kind,
    entry.item.kind === 'agent-single' ? entry.item.agentName : '',
  ]
    .join('\n')
    .toLowerCase()
  return haystack.includes(query)
}

export function deriveNodePickerCatalog(input: {
  sections: readonly PaletteSection[]
  activeCategory: NodePickerCategory
  query: string
  recentIdentities: readonly string[]
  labels: NodePickerCatalogLabels
}): NodePickerCatalogModel {
  const entries = buildEntries(input.sections)
  const categoryCounts: Record<NodePickerCategory, number> = {
    all: entries.length,
    agents: 0,
    wrappers: 0,
    io: 0,
    human: 0,
  }
  for (const section of input.sections) {
    categoryCounts[section.key] += section.items.length
  }

  const normalizedQuery = input.query.trim().toLowerCase()
  const scopedSections =
    input.activeCategory === 'all'
      ? input.sections
      : input.sections.filter((section) => section.key === input.activeCategory)

  const canonicalGroups = scopedSections.flatMap<NodePickerGroup>((section) => {
    const sectionEntries = entries.filter(
      (entry) => entry.sectionKey === section.key && entryMatchesQuery(entry, normalizedQuery),
    )
    return sectionEntries.length === 0
      ? []
      : [
          {
            key: section.key,
            label: section.label,
            entries: sectionEntries,
          },
        ]
  })
  const visibleEntryCount = canonicalGroups.reduce(
    (count, group) => count + group.entries.length,
    0,
  )

  if (input.activeCategory !== 'all' || normalizedQuery !== '') {
    return { categoryCounts, groups: canonicalGroups, visibleEntryCount }
  }

  const byIdentity = new Map(entries.map((entry) => [entry.identity, entry] as const))
  const recentEntries = input.recentIdentities.flatMap((identity) => {
    const entry = byIdentity.get(identity)
    return entry === undefined ? [] : [entry]
  })
  const discoveryGroups: NodePickerGroup[] = [
    {
      key: 'recommended',
      label: input.labels.recommended,
      entries: recommendedEntries(entries),
    },
    ...(recentEntries.length > 0
      ? [
          {
            key: 'recent' as const,
            label: input.labels.recent,
            entries: recentEntries,
          },
        ]
      : []),
  ]
  const groups = [...discoveryGroups, ...canonicalGroups].filter(
    (group) => group.entries.length > 0,
  )

  return { categoryCounts, groups, visibleEntryCount }
}

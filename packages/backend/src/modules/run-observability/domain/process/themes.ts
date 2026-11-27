// RFC-616 §9 — text themes. The model only says which items belong together and
// what to do about it; every count, share and excerpt is computed here from the
// items themselves, so a number on the page can never be a model's guess and an
// excerpt is always a person's own words.

import {
  PROCESS_INSIGHT_ITEM_CHARS,
  PROCESS_INSIGHT_MAX_BYTES,
  PROCESS_INSIGHT_MAX_ITEMS,
  PROCESS_INSIGHT_MAX_THEMES,
  PROCESS_TEXT_SOURCES,
  ProcessInsightModelOutputSchema,
  type ProcessTextSource,
  type ProcessThemeGroup,
} from '@agent-workflow/shared'

export interface InsightSourceItem {
  readonly source: ProcessTextSource
  readonly unitId: string
  readonly stageKey: string | null
  readonly at: number
  readonly text: string
}

export interface PreparedInsightItem extends InsightSourceItem {
  /** The short id the model cites, e.g. `r12`. */
  readonly id: string
}

export interface PreparedInsight {
  readonly items: readonly PreparedInsightItem[]
  /** Sources that had more text than one analysis takes. */
  readonly truncated: ReadonlySet<ProcessTextSource>
  /** Time of the newest item, to tell later whether new text has appeared. */
  readonly newestAt: number | null
}

const ID_PREFIX: Readonly<Record<ProcessTextSource, string>> = {
  review: 'r',
  clarify: 'c',
  'workgroup-message': 'm',
  'workgroup-rejection': 'j',
  'employee-feedback': 'f',
}

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8')

/**
 * Pick what one analysis reads: the newest items first, up to the item and
 * byte limits, each cut to a fixed length. Blank items are dropped.
 */
export function prepareInsightItems(items: readonly InsightSourceItem[]): PreparedInsight {
  const usable = items
    .map((item) => ({ ...item, text: item.text.trim() }))
    .filter((item) => item.text.length > 0)
    .sort((a, b) => b.at - a.at)
  const taken: InsightSourceItem[] = []
  const truncated = new Set<ProcessTextSource>()
  let bytes = 0
  for (const item of usable) {
    const text =
      item.text.length > PROCESS_INSIGHT_ITEM_CHARS
        ? item.text.slice(0, PROCESS_INSIGHT_ITEM_CHARS)
        : item.text
    const size = byteLength(text)
    if (taken.length >= PROCESS_INSIGHT_MAX_ITEMS || bytes + size > PROCESS_INSIGHT_MAX_BYTES) {
      truncated.add(item.source)
      continue
    }
    bytes += size
    taken.push({ ...item, text })
  }
  // Ids are numbered per source in reading order, so the prompt stays stable for the same input.
  const counters = new Map<ProcessTextSource, number>()
  const prepared = taken
    .sort((a, b) => a.at - b.at)
    .map((item): PreparedInsightItem => {
      const next = (counters.get(item.source) ?? 0) + 1
      counters.set(item.source, next)
      return { ...item, id: `${ID_PREFIX[item.source]}${next}` }
    })
  return { items: prepared, truncated, newestAt: usable[0]?.at ?? null }
}

/** The instruction given to the model. */
export function buildInsightPrompt(prepared: PreparedInsight, subjectName: string): string {
  const sections = PROCESS_TEXT_SOURCES.filter((source) =>
    prepared.items.some((item) => item.source === source),
  ).map((source) => {
    const lines = prepared.items
      .filter((item) => item.source === source)
      .map((item) => `[${item.id}] ${item.text.replace(/\s+/g, ' ')}`)
    return `## source: ${source}\n${lines.join('\n')}`
  })
  return [
    `You are analysing text people wrote while working with "${subjectName}": review comments,`,
    'answers to clarifying questions, messages to a working group, feedback on merge requests.',
    'For each source below, find the themes that recur across several items.',
    '',
    'Rules:',
    `- At most ${PROCESS_INSIGHT_MAX_THEMES} themes per source; a theme needs at least two items.`,
    '- Put an item id under one theme only. Leave out items that fit no recurring theme.',
    '- Cite items by their id exactly as given in square brackets. Never invent an id.',
    '- `name`: a short noun phrase. `advice`: one or two sentences on what to change in the',
    '  prompts, agents, skills or workflow so this theme stops recurring.',
    '- Write `name` and `advice` in the language most of the items are written in.',
    '- Do not count anything and do not quote anything: only group the ids.',
    '',
    'Answer with one JSON object and nothing else, in this shape:',
    '{"groups":[{"source":"<source>","themes":[{"name":"…","itemIds":["r1","r2"],"advice":"…"}]}]}',
    '',
    ...sections,
  ].join('\n')
}

/** The first balanced-looking JSON object in a model answer, or null. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}

const NAME_CHARS = 80
const ADVICE_CHARS = 400
const QUOTES_PER_THEME = 2
const STAGES_PER_THEME = 3

/**
 * Turn the model's grouping into theme groups. Returns null when the answer is
 * not the requested document at all (the caller asks once more, then fails).
 *
 * - an id the input does not contain is ignored;
 * - an item belongs to the first theme of its source that cites it;
 * - a theme left without items is dropped;
 * - the themes with the most items are kept, the rest count as "other".
 */
export function groupThemes(answer: string, prepared: PreparedInsight): ProcessThemeGroup[] | null {
  const parsed = ProcessInsightModelOutputSchema.safeParse(extractJsonObject(answer))
  if (!parsed.success) return null
  const groups: ProcessThemeGroup[] = []
  for (const source of PROCESS_TEXT_SOURCES) {
    const items = prepared.items.filter((item) => item.source === source)
    if (items.length === 0) continue
    const byId = new Map(items.map((item) => [item.id, item]))
    const claimed = new Set<string>()
    const themes = parsed.data.groups
      .filter((group) => group.source === source)
      .flatMap((group) => group.themes)
      .map((theme) => {
        const own: PreparedInsightItem[] = []
        for (const id of theme.itemIds) {
          const item = byId.get(id)
          if (item === undefined || claimed.has(id)) continue
          claimed.add(id)
          own.push(item)
        }
        return { name: theme.name, advice: theme.advice, own }
      })
      .filter((theme) => theme.own.length > 0)
      .sort((a, b) => b.own.length - a.own.length)
      .slice(0, PROCESS_INSIGHT_MAX_THEMES)
    const kept = themes.reduce((count, theme) => count + theme.own.length, 0)
    groups.push({
      source,
      items: items.length,
      truncated: prepared.truncated.has(source),
      otherItems: items.length - kept,
      themes: themes.map((theme) => {
        const stageCounts = new Map<string, number>()
        for (const item of theme.own) {
          if (item.stageKey === null) continue
          stageCounts.set(item.stageKey, (stageCounts.get(item.stageKey) ?? 0) + 1)
        }
        return {
          name: theme.name.trim().slice(0, NAME_CHARS),
          items: theme.own.length,
          share: theme.own.length / items.length,
          stages: [...stageCounts]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, STAGES_PER_THEME)
            .map(([stageKey]) => stageKey),
          // The shortest items make the most readable excerpts and are the least likely to be cut.
          quotes: [...theme.own]
            .sort((a, b) => a.text.length - b.text.length || a.id.localeCompare(b.id))
            .slice(0, QUOTES_PER_THEME)
            .map((item) => ({ text: item.text, unitId: item.unitId })),
          advice: theme.advice.trim().slice(0, ADVICE_CHARS),
        }
      }),
    })
  }
  return groups
}

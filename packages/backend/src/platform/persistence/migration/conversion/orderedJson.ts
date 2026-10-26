import type { JsonValue } from './types'

/** Top-level occurrences retain source order, including duplicate and integer-like keys. */
export function scanJsonObjectEntries(
  text: string,
): readonly { key: string; value: JsonValue; rawValue: string; ordinal: number }[] {
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('v2-json-object-required')
  let offset = text.indexOf('{') + 1
  const whitespace = () => {
    while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++
  }
  const stringEnd = (start: number): number => {
    let index = start + 1
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2
        continue
      }
      if (text[index] === '"') return index + 1
      index++
    }
    throw new Error('v2-json-string-unclosed')
  }
  const entries: { key: string; value: JsonValue; rawValue: string; ordinal: number }[] = []
  for (;;) {
    whitespace()
    if (text[offset] === '}') return entries
    const end = stringEnd(offset)
    const key = JSON.parse(text.slice(offset, end)) as string
    offset = end
    whitespace()
    offset++
    whitespace()
    const start = offset
    let depth = 0
    while (offset < text.length) {
      const character = text[offset]
      if (character === '"') {
        offset = stringEnd(offset)
        continue
      }
      if ((character === ',' || character === '}') && depth === 0) break
      if (character === '{' || character === '[') depth++
      if (character === '}' || character === ']') depth--
      offset++
    }
    const rawValue = text.slice(start, offset).trimEnd()
    entries.push({
      key,
      value: JSON.parse(rawValue) as JsonValue,
      rawValue,
      ordinal: entries.length,
    })
    if (text[offset] === ',') offset++
  }
}
export function scanJsonObjectKeys(text: string): readonly string[] {
  return scanJsonObjectEntries(text).map((entry) => entry.key)
}

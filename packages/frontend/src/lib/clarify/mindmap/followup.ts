/** Quote and editable direction share the existing instruction budget. Never silently truncate. */
export function composeMindmapFollowup(quote: string, instruction: string): string {
  return quote ? `Quoted passage: ${JSON.stringify(quote)}\n\n${instruction}` : instruction
}
export function mindmapFollowupLimit(
  quote: string,
  instruction: string,
): 'quote' | 'instruction' | null {
  if (quote.length > 500) return 'quote'
  return composeMindmapFollowup(quote, instruction).length > 2000 ? 'instruction' : null
}

/** Decode only our exact wrapper; arbitrary user text remains untouched. */
export function restoreMindmapFollowup(value: string): { quote: string; instruction: string } {
  const prefix = 'Quoted passage: '
  const end = value.indexOf('\n\n')
  if (value.startsWith(prefix) && end > prefix.length) {
    try {
      const quote: unknown = JSON.parse(value.slice(prefix.length, end))
      const instruction = value.slice(end + 2)
      if (
        typeof quote === 'string' &&
        quote.length <= 500 &&
        composeMindmapFollowup(quote, instruction) === value
      )
        return { quote, instruction }
    } catch {
      /* Not our quote wrapper. */
    }
  }
  return { quote: '', instruction: value }
}

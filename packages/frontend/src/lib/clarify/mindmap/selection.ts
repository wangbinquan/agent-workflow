/** Where the "ask about this passage" control sits. It is placed in the reader's
 *  scrolling content, just under the selected words, so it stays beside them. */
export interface SelectionBox {
  left: number
  top: number
  bottom: number
}
export interface SelectionReader {
  left: number
  top: number
  scrollLeft: number
  scrollTop: number
  clientWidth: number
}
export const SELECTION_CONTROL = { width: 200, gap: 8, margin: 12 }

export function placeSelectionControl(
  selection: SelectionBox,
  reader: SelectionReader,
): { top: number; left: number } {
  const { width, gap, margin } = SELECTION_CONTROL
  const rightmost = Math.max(margin, reader.clientWidth - width - margin)
  return {
    top: Math.max(0, selection.bottom - reader.top + reader.scrollTop + gap),
    left: Math.min(rightmost, Math.max(margin, selection.left - reader.left + reader.scrollLeft)),
  }
}

/** In the mindmap reader an option's description and recommendation reason are
 *  reading text: they can be selected and quoted, so a click on them (including
 *  the first click of a double or triple click) never chooses the option. The
 *  radio / checkbox, the option's title row and the card padding still choose it,
 *  unless that click is the end of a text selection inside the same option. */
export function optionClickIsReading(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target instanceof HTMLInputElement) return false
  const option = target.closest('.clarify-option')
  if (!option) return false
  if (target.closest('.clarify-option__description, .clarify-option__reason')) return true
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false
  return option.contains(selection.anchorNode) || option.contains(selection.focusNode)
}

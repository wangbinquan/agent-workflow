/**
 * A debounced preview is pending before React Query starts the network request.
 * Treat that debounce window as pending too, otherwise Save can briefly enable
 * against stale validation and lose a click when the button disables mid-press.
 */
export function isRepoGroupPreviewPending(
  currentWireKey: string,
  previewWireKey: string,
  isFetching: boolean,
): boolean {
  return currentWireKey !== previewWireKey || isFetching
}

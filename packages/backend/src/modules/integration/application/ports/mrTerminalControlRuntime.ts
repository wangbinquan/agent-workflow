import type { MrTerminalControl } from '../../public/mrTerminalControl'

/** Actual owner lifetime used only by a fully paired host execution selection. */
export interface MrTerminalControlRuntime extends MrTerminalControl {
  /** Synchronously stop new claims and dispatch; do not abort launch owners. */
  quiesceAuthorityLoss(): void
  /** Await the exact admitted attempt and its durable receipt intake. */
  drainAuthorityLoss(): Promise<void>
}

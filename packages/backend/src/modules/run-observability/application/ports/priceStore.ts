import type { PriceVersion } from '../../domain/pricing'

export interface PriceStore {
  /** Every version of one (runtime, model) line, oldest first. */
  line(runtimeId: string, model: string): Promise<readonly PriceVersion[]>
  /** Every version of every line (small: one row per saved price). */
  all(): Promise<readonly PriceVersion[]>
  /** Appends when the line's newest version is still `expectedLatestId`. */
  append(version: PriceVersion, expectedLatestId: string | null): Promise<'appended' | 'conflict'>
}

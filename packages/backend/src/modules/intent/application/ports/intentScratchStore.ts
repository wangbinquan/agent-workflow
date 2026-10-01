/** Scratch effects only. Intent keeps retention, running-turn fences and the
 * persisted swept marker in its maintenance application. */
export interface IntentScratchStore {
  staleTurnIds(cutoff: number): readonly string[] | Promise<readonly string[]>
  remove(turnId: string): void | Promise<void>
}

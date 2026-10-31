import type { InjectedMemorySnapshot } from '@agent-workflow/shared'

export interface TaskMemorySnapshotPort {
  renderSnapshot(
    snapshot: readonly InjectedMemorySnapshot[] | null,
    nonce: string | null | undefined,
  ): string | null
  parseSnapshotJson(raw: string | null): InjectedMemorySnapshot[] | null
}

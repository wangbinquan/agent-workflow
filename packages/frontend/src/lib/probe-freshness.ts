// RFC-169 (T15) — is an MCP probe result still describing the CURRENT config?
//
// Saving an MCP updates its config + `updatedAt` but the persisted probe is not
// cleared, so a green result for the old command/URL could masquerade as the
// current status. The probe schema has no config hash, only timestamps. We use
// a start-time strict compare: the result is fresh iff it STARTED after the
// last config save (`startedAt > updatedAt`). Milliseconds-equal is treated as
// stale (fail-closed). The backend captures `startedAt` before reading the
// config snapshot (RFC-169 backend small-piece ②), so `startedAt > updatedAt`
// reliably implies the snapshot was read after the save.
//
// Pure — unit-tested in tests/probe-freshness.test.ts.

export function probeFreshness(
  probe: { startedAt: number } | null | undefined,
  mcpUpdatedAt: number,
): boolean {
  if (probe === null || probe === undefined) return false
  return probe.startedAt > mcpUpdatedAt
}

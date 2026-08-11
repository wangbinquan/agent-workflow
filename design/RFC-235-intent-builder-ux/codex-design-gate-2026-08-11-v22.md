# RFC-235 v22 Codex design gate — 2026-08-11

Verdict: **APPROVED — P0=0, P1=0, P2=0（in-session source-backed gate）**

## Scope

- Snapshot: `82d79ad6` plus the finding fixes recorded below.
- Normative scope: `proposal.md §0`, `design.md §0A`, `plan.md §0`.
- Source cross-check: current `main` shared/backend/frontend Intent implementation, RFC-271 consumer
  boundary, RFC-276 runtime-hardening deprecation.
- Historical v21 artifact/recovery text was intentionally excluded because v22 marks it superseded.

The configured external `codex exec` companion was attempted from a detached worktree with a real
`bun install --frozen-lockfile` and a passing frontend Intent test. Execution was blocked by the host
privacy policy because it would transmit internal repository content to an external model service
without separate user authorization. No bypass was attempted. The primary Codex session therefore
performed the adversarial gate against the same detached snapshot and records that limitation here.

## Closed findings

### DG22-01 — P1 — user turn could become durable without a generation state

Concrete sequence: `POST /messages` commits the user turn; `fireTurn` then awaits runtime resolution;
runtime lookup fails or a second tab posts before `runIntentTurn` mints its row. The first request has
already succeeded, but detail contains neither `inFlight` nor an agent error, and two accepted user
turns may race for one slot. The proposed canonical journey would falsely fall back to Goal/previous
Review.

Resolution: `design.md §0A.1a` now requires create/message/answers to atomically write the user turn
and exact agent `running` reservation, retry to reserve in one transaction, budget rejection before
user history writes, and every post-reservation failure to settle that row. Existing columns suffice;
no migration or generic ledger was added.

### DG22-02 — P1 — mount approval could apply a stale suggestion or partially mount

Concrete sequence: tab A reads agent request R; tab B sends another message/rebases; tab A posts the
old concrete ref. The v22 draft body carried no source/context fence. The existing route also calls
`addIntentMount` once per item, so candidate 1 can commit before candidate 2 loses ACL, leaving a
partial batch and an approval history that never lands.

Resolution: `design.md §0A.2` now defines sourceTurnId + expected turn/context fences, exactly one
decision per source request, exact-name candidate binding, owner-first hydration,
`canViewResourceInTx`, and a single manifest/context/turn transaction with a strict receipt.

### DG22-03 — P2 — pagination overpromised concurrency and broke legacy clients

Concrete sequence: page 1 ends at `(updatedAt=100,id=B)`; before page 2, session C moves from 90 to
110. A keyset read cannot provide snapshot isolation from the mutable sort key, so the original “no
missing” statement was false. Replacing the top-level array would also break existing token/CLI
scripts even though the embedded frontend is same-binary.

Resolution: `design.md §0A.1` makes pagination additive under `page=1`, preserves the legacy array,
limits the stability claim to an unchanged result set, and requires WS invalidation to reset pages
plus id-based defensive dedupe.

## Checked-safe areas

- RFC-271 explicitly leaves Intent on `applyIntentChangeset`; v22 does not create a second bundle
  engine migration.
- RFC-276 removed the v21 containment/artifact/restore scope; v22 does not reintroduce its code,
  config, schema or UI surfaces.
- Existing owner/admin read boundary, creator-only writes, draft OCC/hash, secret slots, apply journal
  idempotency, provenance and shared Session renderer remain authoritative rather than reimplemented.
- Mobile panels remain mounted; single selected op limits rich preview cost without changing the
  changeset or workflow canvas contract.
- Commit retry reuses one client mutation id and never includes secret values in its review summary.

No open P0/P1/P2 remains in the v22 design scope.

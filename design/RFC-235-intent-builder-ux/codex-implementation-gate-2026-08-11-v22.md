# RFC-235 v22 Codex implementation gate — 2026-08-11

Verdict: **APPROVED — P0=0, P1=0, P2=0（in-session source-backed gate）**

## Scope

- Base: `4de2475d` on `main`, plus the RFC-235 v22 candidate paths listed by
  `git diff --name-only` at this gate.
- Normative scope: `proposal.md §0`, `design.md §0A`, `plan.md §0` and
  `codex-design-gate-2026-08-11-v22.md`.
- Reviewed surfaces: strict shared wire schemas; Intent routes, journey projection, reservation and
  resource catalog services; list/create/detail/commit frontend; Intent unit, integration and
  Playwright coverage.
- Historical v21 artifact broker, containment, backup/restore and worktree reconstruction clauses
  were excluded because v22 and RFC-276 mark them superseded.

The configured external `codex exec` companion was attempted earlier from an isolated checkout. The
host privacy policy blocked transmission of internal repository content without separate explicit
authorization. No bypass was attempted. This implementation gate was therefore performed by the
primary Codex session against the checked-out candidate, with direct source inspection, focused
counterexample tests, full local gates and real browser verification.

## Closed findings

### IG22-01 — P1 — frontend-derived stages admitted impossible task states

The old list and detail views independently inferred progress from turn and revision counters. That
allowed the same session to appear at different steps, and malformed combinations such as an
applied session whose current step was still Generate were not rejected at the boundary.

Resolution: `packages/shared/src/schemas/intentSession.ts` defines one strict journey DTO with
cross-field tuple validation, while `packages/backend/src/services/intent/journey.ts` is the sole
projector. Both list and detail render that DTO; the generic “running” badge is no longer a competing
fifth status. Goal / Generate / Review / Apply is the only task-state rail.

### IG22-02 — P1 — accepted user actions could exist without a durable running turn

Previously a user turn could commit before runtime resolution created the agent turn. Runtime lookup
failure, cancellation in that interval, or two tabs posting together could leave accepted input with
no visible execution state or could race the same generation slot.

Resolution: create, message, answers and retry reserve the exact agent `running` turn in the same
transaction as their accepted mutation. `turnEngine.ts` consumes that reservation and settles every
post-reservation resolution or launch failure into a durable terminal turn; cancellation also covers
the pre-`AbortController` reservation window. Route and engine tests lock the failure and concurrency
sequences.

### IG22-03 — P1 — mount approval was stale, partial and identity-unsafe

An old tab could approve a superseded suggestion; per-item writes could mount a prefix before a later
candidate lost ACL; internal handles were also usable as primary labels in the UI.

Resolution: mount decisions are source-turn, sequence and context bound; the backend rechecks every
candidate under the current actor and commits manifest, context and semantic receipt together or not
at all. Initial create mounts are checked in the same transaction. `resourceCatalog.ts` exposes only
actor-visible typed display names, and the timeline renders semantic approve/reject receipts instead
of raw JSON.

### IG22-04 — P1 — archive and audit controls could imply authority they did not have

Archive/reopen previously depended on stale route reads and could interleave with an unsettled apply.
An archived owner or system administrator could also be shown controls that the backend would reject.

Resolution: archive/reopen uses a fresh owner/in-flight/unsettled-apply transaction gate. Archived
owners retain only Reopen and read-only evidence; system administrators receive full audit history
but no owner mutations, mount decisions or commit controls. Mutation failures surface inline instead
of disappearing after refetch.

### IG22-05 — P1 — commit confirmation could outlive the draft it described

A second tab could replace the current draft while Strategy / Details / Review remained open, letting
the visible decisions describe draft A while the action targeted draft B after a background refetch.

Resolution: the dialog is bound to the opening draft identity and closes on identity change. Each
dialog lifetime owns one ULID reused for response-loss retries; closing creates a new id. Pending
dismissal and navigation are locked, required slots and waivers are step-local, secrets never enter
the review summary, and focus moves to the active step heading.

### IG22-06 — P2 — large changesets and workflow previews did not preserve review ownership

Rendering every rich operation made 64-op drafts unwieldy, and the workflow canvas could collapse
inside a narrow nested card. On mobile, replacing Build with Review by unmounting content also lost
local state and made stage changes jump unpredictably.

Resolution: the review uses a keyboard-selectable operation outline and exactly one rich preview.
Workflow operations reuse the read-only `WorkflowCanvas` at the full review width. Build and Review
remain mounted behind true tabs, with a stage-aware initial selection that is stable across refreshes;
desktop remains two-column and 390px uses one controlled scroll boundary with a sticky current CTA.

### IG22-07 — P2 — list scale and reconnect behavior were underspecified

The legacy list was unbounded, while naïvely appending WebSocket-invalidated pages could duplicate or
reorder sessions under a mutable `updatedAt` sort key.

Resolution: `page=1` adds a bounded keyset response without breaking legacy array callers. The client
deduplicates by id, resets to page one on locator events and reconnect, and renders distinct first-load,
load-more, error, empty and archived states.

## Checked-safe areas

- RFC-234 owner-only mutation, OCC/draft hash, secret slots, immutable changesets, apply journal,
  all-or-nothing resource writes and provenance remain authoritative.
- Intent remains on `applyIntentChangeset`; this change does not silently migrate it to RFC-271
  `BundleApply` or recreate the runtime-hardening surfaces removed by RFC-276.
- The existing `SessionConversationPanel` / `ConversationFlow` renderer remains the execution-process
  renderer for Intent turns; this change adds no parallel Session UI.
- Legacy list consumers keep the top-level array contract unless they explicitly request `page=1`.
- Malformed source turns and impossible journey tuples fail closed at backend/shared boundaries.

## Verification

- Focused backend Intent suites: 39/39.
- Focused shared RFC-235 wire suite: 4/4.
- Focused frontend Intent/invariant suites: 41/41; Intent-only component bundle: 32/32.
- Flake attribution: the unrelated BatchImport WebSocket test passed 16/16 three consecutive times;
  the unrelated scheduler clarify-mid-batch file passed 2/2 three consecutive times after a single
  contended full-gate timeout; the unrelated RFC-098 process-governance file passed 5/5 three
  consecutive times after a four-shard run missed its helper PID-file timing window.
- Rebuilt production/E2E binary and version smoke: pass.
- Intent Playwright against the rebuilt binary: 5/5, covering create-to-apply, modify, workflow canvas,
  desktop/390px, light/dark, keyboard/touch and axe.
- Real browser inspection: desktop and 390px layouts, workflow review width, mounted tabs, four-step
  rail, semantic timeline, sticky CTA and commit stepper checked in light and dark themes.
- Final workspace gate: `AW_LOCAL_BACKEND_SHARDS=2 bun run gate:local` passed in 11m28s without
  reducing the test set: backend 9,357 pass / 30 skip / 0 fail, shared 1,976/1,976, frontend
  6,271/6,271, plus typecheck, lint, format and dependency rules.

No open P0/P1/P2 remains in the RFC-235 v22 implementation scope.

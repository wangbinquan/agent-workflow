# RFC-056 patch 2026-05-25 — questioner cascade must not skip a clarify-only row + audit all rerun mint sites for cci inheritance

Status: **In Progress → Done after merge**.
Owner: RFC-056 implementer follow-up (fourth patch under RFC-056).
Scope: bug-fix patch. Per `CLAUDE.md` RFC workflow §6 exception,
documented as an RFC-056 patch rather than a new RFC.

Pairs with:

- [`patch-2026-05-22-downstream-cascade.md`](./patch-2026-05-22-downstream-cascade.md)
- [`patch-2026-05-23-designer-retry-index.md`](./patch-2026-05-23-designer-retry-index.md)
- [`patch-2026-05-24-retry-preserves-cross-clarify-iteration.md`](./patch-2026-05-24-retry-preserves-cross-clarify-iteration.md)

## 1. Symptom (live task 01KS86DPCSERV7S41GQA5Y81RN)

Task fails with:

> review node rev_cbkatx: upstream 'agent_b48d63' did not emit port 'docpath'

`agent_b48d63` is a cross-clarify **questioner** whose latest `done` row
emitted only a `<workflow-clarify>` envelope (cross-clarify session
HWDACF) — i.e. the questioner asked questions, parked, was answered, and
expected to be re-run after the designer integrates the answers. But it
never was. Downstream review `rev_cbkatx` dispatched against the
clarify-only `done` row, found no `docpath` in `node_run_outputs`, and
failed the whole task.

DB evidence (selected rows; full audit in plan
`/Users/wangbinquan/.claude/plans/tender-inventing-sphinx.md`):

| node_run | node | ri | cci | status | outputs |
|----------|------|----|----|--------|---------|
| 6C2GCE | agent_b48d63 (questioner) | 3 | 1 | done | (empty) ← rev_cbkatx read this |
| Y36Y1D | cross_clarify_6c910f | 0 | 1 | done | HWDACF continue @ 01:48:02 |
| DDTRYA | agent_m7p3n1 (designer) | 10 | 1 | interrupted | (empty) |
| YZSFYD | agent_m7p3n1 (designer) | 11 | **0** | done | (empty) ← cci regressed |
| S1MSHW | agent_m7p3n1 (designer) | 12 | 0 | done | docpath=26 ← latest designer done |

`rev_5h9xpz` (the OTHER review, on the designer's output) finished fine
at NXA731 cci=0 — the failure is isolated to the questioner branch.

## 2. Three independent root causes

### 2.1 `cascadeDownstreamFromDesigner` idempotency too permissive

`packages/backend/src/services/crossClarify.ts:795-801`:

```ts
if (topLevel.some((r) => r.crossClarifyIteration >= newCrossClarifyIteration)) {
  continue
}
```

The cascade BFS-walks downstream from the designer after `continue` and
mints a fresh pending row at the bumped `crossClarifyIteration` for every
reachable node. The idempotency guard skips any node whose latest row
already sits at the target iteration — meant to make the cascade safe to
invoke twice.

For a questioner whose latest row IS the clarify-only `done`
(`6C2GCE` cci=1), this guard fires falsely: the row "carries" the target
iteration but represents the inverse semantic — it's the row that
generated the cross-clarify session, *not* a row that consumed the
answers. Cascade skips → questioner stays `completed` in the scope set
→ review dispatches against a `done` row that has no requested port → fail.

Patch: keep the idempotency intent (don't double-mint when a real
"consumed-the-answers" row already exists), but **only** skip when at
least one row at the target iteration has produced a non-clarify output
port (i.e. `node_run_outputs.port_name NOT IN ('__clarify__')` exists for
that node_run). A clarify-only row no longer counts as "already cascaded".

### 2.2 `triggerDesignerRerun` newCci assumes designer is the only iteration source

`packages/backend/src/services/crossClarify.ts:672`:

```ts
crossClarifyIteration: (lastDesigner.crossClarifyIteration ?? 0) + 1,
```

`lastDesigner` comes from `designerRows[0]` ordered by
`desc(startedAt)`. SQLite DESC orders `startedAt IS NULL` last, so
`BFP8SC` (a pending-then-interrupted designer row at cci=1, never
dispatched) is silently dropped from the picker. With ZZ8D0W (cci=0)
chosen as `lastDesigner`, `newCci = 0 + 1 = 1` — equal to the questioner
`6C2GCE` cci=1, which is exactly the value §2.1 then trips on for the
skip.

The semantic invariant is: after a `continue`, the new designer
iteration must be **strictly greater than every prior participant
(designer rows AND questioner rows AND prior cross-clarify session
iteration)**. Patch: `newCci = max(lastDesigner.cci, max(questioner.cci
across participants of this cross-clarify node), lastSession.iteration)
+ 1`. Same expression feeds `cascadeDownstreamFromDesigner.newCrossClarifyIteration`
so the cascade and the designer mint stay in lockstep.

### 2.3 Three node_runs insert sites silently drop cross_clarify_iteration

Audit of every `db.insert(nodeRuns)` callsite for paths that mint a new
attempt of an existing run:

| File:line | Path | Inherits cci? |
|-----------|------|---------------|
| crossClarify.ts:199 | createCrossClarifySession (cross-clarify node itself) | ✓ (explicit) |
| crossClarify.ts:661 | triggerDesignerRerun designer mint | ✓ (§2.2 patches the source value) |
| crossClarify.ts:821 | cascadeDownstreamFromDesigner | ✓ |
| crossClarify.ts:895 | triggerQuestionerStopRerun | ✓ |
| scheduler.ts:688 | Layer B freshness invariant | ✓ |
| scheduler.ts:1074 | scheduleAgentNode fresh-mint | ✓ (patch-2026-05-24) |
| scheduler.ts:1157 | scheduleAgentNode RFC-042 retry | ✓ (patch-2026-05-24) |
| scheduler.ts:2251 | multi-process fan-out child | n/a (parent owns cci) |
| scheduler.ts:2498 | insertNodeRun helper | ✓ |
| **review.ts:451** | initial review awaiting_review row | **✗ defaults to 0** |
| **review.ts:1335** | review-iterate placeholder mint | **✗ defaults to 0** |
| **clarify.ts:169** | clarify session awaiting_human row | **✗ defaults to 0** |
| **clarify.ts:406** | clarify-rerun mint at source agent | **✗ defaults to 0** |
| **task.ts:690** | single-node retry / retry-from-interrupt placeholder | **✗ defaults to 0** |

The five rows marked ✗ silently default `crossClarifyIteration` to the
schema default (0). For a live cross-clarify task, any of these paths
firing AFTER the questioner already advanced to cci ≥ 1 produces a row
at cci=0, which then gets picked as `latestExisting` by
`scheduleAgentNode`'s `inheritedCrossClarifyIteration` lookup (the
fresh-mint path inherits from the FRESHEST row by `isFresherNodeRun`,
which is keyed on `(clarifyIteration, retryIndex, id)` — NOT `cci`).
Result: a chain of zero-cci rows shadows the cross-clarify iteration the
designer rerun bumped.

For the live task, `YZSFYD` cci=0 was the regression that broke the
Layer B freshness invariant's ability to detect the inconsistency: with
designer latest cci=0 and questioner latest cci=1, the invariant
(scheduler.ts:655-663) only checks `upstreamMaxIter > myIter`, never the
inverse — so it doesn't demote the questioner. The questioner stays
`completed` in scope, review fires, port-missing failure.

Patch: every one of the five sites adds `crossClarifyIteration:
<inherited>` to the insert. For `task.ts:690`, `clarify.ts:406`,
`review.ts:1335` the `inherit` source row already exists in scope — pull
its cci. For `clarify.ts:169` and `review.ts:451`, the row is the
clarify/review *node* itself (not the source agent), but for consistency
we still carry the cci from the source agent run that triggered the
session so the cross-clarify scope walker (`upstreamsOf` chain in Layer
B) sees a continuous iteration.

## 3. Affected files

- `packages/backend/src/services/crossClarify.ts`
  - §2.1 — idempotency guard at `:795-801` (also mirrored to Layer B at
    `scheduler.ts:676` for symmetry).
  - §2.2 — `newCci` computation at `:672` and `:711` (cascade arg).
- `packages/backend/src/services/scheduler.ts`
  - §2.1 mirror — Layer B idempotency guard at `:676` (apply same
    clarify-only exception so the defense-in-depth layer doesn't shadow
    Layer A's fix).
- `packages/backend/src/services/task.ts`
  - §2.3 — `:690` retry-from-interrupt placeholder must inherit cci.
- `packages/backend/src/services/clarify.ts`
  - §2.3 — `:169` clarify-session create, `:406` clarify-rerun mint.
- `packages/backend/src/services/review.ts`
  - §2.3 — `:451` initial review row, `:1335` review-iterate placeholder.

## 4. Tests

New file `packages/backend/tests/cross-clarify-questioner-cascade-no-skip.test.ts`:

1. **§2.1 lock — cascade must mint when questioner's existing row is
   clarify-only**: fixture mirrors the production graph
   `in → designer → rev1 → questioner → rev2 → out + cross-clarify`.
   Seed: designer done@cci=0, questioner done@cci=1 with `node_run_outputs`
   empty (clarify-only). Call `submitCrossClarifyAnswers(directive='continue')`.
   Assert: a new `pending` row for the questioner exists at `retryIndex =
   max+1`. Without the patch, cascade skips → 0 new questioner rows minted.

2. **§2.2 lock — designer rerun newCci jumps past questioner**: same
   fixture. Seed: designer done@cci=0, questioner done@cci=1 (clarify-only).
   Submit continue. Assert: the newly-minted designer row has cci ≥ 2.
   Without the patch, designer cci = 1.

3. **§2.3 lock — task.ts retry-from-interrupt preserves cci**: seed
   a designer row at cci=1, interrupt it, call `retryNode`. Assert: the
   newly-minted placeholder row carries cci=1.

4. **§2.3 lock — clarify-rerun mint preserves cci**: seed an agent row
   at cci=1 with an open clarify session. Submit clarify answers. Assert:
   the rerun mint at `clarify.ts:406` has cci=1.

5. **§2.3 lock — review-iterate mint preserves cci**: seed an agent at
   cci=1 with a review row in awaiting_review state. Approve with
   request-changes. Assert: the agent's new placeholder row has cci=1.

6. **Source-text guards**: grep
   `packages/backend/src/services/{task,clarify,review}.ts` to assert
   `crossClarifyIteration:` appears in every `db.insert(nodeRuns).values({…})`
   block enumerated in §2.3. Locks against future regressions where a
   refactor reintroduces the silent default.

7. **§2.1 / Layer B mirror**: extend
   `scheduler-cross-clarify-freshness-invariant.test.ts` with the same
   clarify-only scenario as §2.1 — the Layer B invariant must also
   demote on the next pass even if Layer A failed.

## 5. Out of scope

- Layer B inverse-asymmetry fix (demote when `myIter > upstreamMaxIter`
  and my latest output is clarify-only). Deferred: Fix A + B + C
  collapse the failure into "designer cci can never regress below
  questioner cci"; Layer B's existing direction is sufficient once the
  three fixes ship.
- Recovery of task 01KS86DPCSERV7S41GQA5Y81RN itself — handled by
  manual DB surgery (cancel/delete 6C2GCE → resumeTask) after this
  patch lands and CI is green. The new cascade path will mint a fresh
  questioner pending row when the task resumes.

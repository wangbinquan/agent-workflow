# RFC-056 patch 2026-05-24 — RFC-042 in-attempt retry preserves crossClarifyIteration

Status: **In Progress → Done after merge**.
Owner: RFC-056 implementer follow-up (third patch under RFC-056).
Scope: bug-fix patch. Per `CLAUDE.md` RFC workflow §6 exception, documented
as an RFC-056 patch rather than a new RFC.

Pairs with:

- [`patch-2026-05-22-downstream-cascade.md`](./patch-2026-05-22-downstream-cascade.md)
- [`patch-2026-05-23-designer-retry-index.md`](./patch-2026-05-23-designer-retry-index.md)

## 1. Symptom

User report (verbatim):

> 在跨节点反问的时候，如果设计节点运行失败，重新执行的时候，跨节点反问的内容
> 就不在提示词里了

Concretely: after the user submits a cross-clarify with `directive=continue`,
the framework triggers a designer rerun (RFC-056 §5.2). If that designer
attempt fails for any reason RFC-042 retries handle (process crash /
timeout / envelope error / port validation), the rebuilt prompt on the
retry attempt is **missing the entire cross-clarify stack**:

- `## External Feedback`
- `## Prior Output (to be updated)`
- `## Update Directive`

…and on the questioner side (when a questioner-side retry fires), the
`## Clarify Q&A` section disappears too. The designer silently falls back
to white-board regenerate mode, defeating RFC-056 §6 update mode the same
way the patch-2026-05-23 family did — but along the retry axis rather than
the freshness-comparator axis.

## 2. Root cause

`packages/backend/src/services/scheduler.ts:1147-1152` (pre-patch) — the
RFC-042 in-attempt process-retry mint:

```ts
nodeRunId = await insertNodeRun(db, taskId, node.id, 'pending', attempt, iteration, {
  clarifyIteration: inheritedClarifyIteration,
  reviewIteration: inheritedReviewIteration,
  shardKey: inheritedShardKey,
  parentNodeRunId: inheritedParentNodeRunId,
})
```

`crossClarifyIteration` is conspicuously absent. Worse, the helper itself
(`insertNodeRun`, scheduler.ts:2466 pre-patch) didn't accept the field in
its `inherit` typedef:

```ts
inherit?: {
  clarifyIteration?: number
  reviewIteration?: number
  shardKey?: string | null
  parentNodeRunId?: string | null
},
```

So `crossClarifyIteration` on every fresh retry row dropped to the schema
default 0 (`schema.ts:386`
`integer('cross_clarify_iteration').notNull().default(0)`).

Downstream chain (scheduler.ts line numbers pre-patch):

1. Next outer scheduler pass at `:1222` re-reads `currentRunRow` from DB.
2. `:1306` `const currentCrossClarifyIteration = currentRunRow?.crossClarifyIteration ?? 0` → **0**.
3. `:1307-1308` `isCrossClarifyTriggeredRerun = hasExternalFeedbackChannel && currentCrossClarifyIteration > 0` → **false**.
4. Branch at `:1310-1330` skipped → `priorDoneDesigner` stays `undefined` → block at `:1462-1479` never composes `priorOutputBlock`.
5. `:1448-1457` `buildExternalFeedbackContext({ ..., designerCrossClarifyIteration: 0 })` hits the `args.designerCrossClarifyIteration <= 0` guard at `crossClarify.ts:1038` → returns `undefined`. No External Feedback block.
6. `:1411-1412` `isQuestionerCrossClarifyRerun = clarifyMode === 'cross' && currentCrossClarifyIteration > 0` → **false** → `buildQuestionerCrossClarifyContext` never called. No `## Clarify Q&A` for questioner.

Result: every cross-clarify prompt block silently vanishes from the retry's
prompt — exactly the user's symptom.

The pre-existing comment at scheduler.ts:1300 already _assumed_ the fix
was in place:

> An in-attempt RFC-042 retry inherits crossClarifyIteration from the
> row it retries, so it simply won't find a strictly-lesser
> priorDoneDesigner…

The author's invariant was correct — the code just didn't enforce it.

## 3. Why patch-2026-05-23 unmasked this

Pre-patch-2026-05-23, the designer's new pending row was always at
`retry_index=0`, so the design's old gate `retryIndex === 0` "happened to
fire" for both the fresh cross-clarify rerun AND its in-attempt retries
(both inherited `retry_index=0`). The retry-row's `crossClarifyIteration=0`
default was harmless because the gate above it already short-circuited on
retry_index.

Patch-2026-05-23 dropped the `retryIndex === 0` sub-gate and made
`crossClarifyIteration` the sole signal — at which point the retry-row's
`crossClarifyIteration=0` default became load-bearing and the symptom
surfaced. The fix is to inherit `crossClarifyIteration` explicitly, the same
way `clarifyIteration` / `reviewIteration` / `shardKey` /
`parentNodeRunId` already are.

## 4. The fix

Four touch points in `scheduler.ts`:

### 4.1. `insertNodeRun` accepts `crossClarifyIteration`

`scheduler.ts:2466-2497` — append the field to the `inherit` typedef and
the `db.insert(nodeRuns).values({...})` block:

```ts
inherit?: {
  clarifyIteration?: number
  reviewIteration?: number
  crossClarifyIteration?: number   // ← new
  shardKey?: string | null
  parentNodeRunId?: string | null
},
// …
crossClarifyIteration: inherit?.crossClarifyIteration ?? 0,
```

### 4.2. Derive `inheritedCrossClarifyIteration` off `latestExisting`

`scheduler.ts:1052` (next to `inheritedClarifyIteration` /
`inheritedReviewIteration`):

```ts
const inheritedCrossClarifyIteration = latestExisting?.crossClarifyIteration ?? 0
```

`latestExisting` is the freshest top-level row selected by `isFresherNodeRun`
— same source the existing inheritance reads from. Covers:

- `triggerDesignerRerun`-minted pending row (`crossClarifyIteration+1`,
  `retry_index=max+1`).
- `cascadeDownstreamFromDesigner`-minted downstream pending rows (same
  contract).
- Plain self-clarify / review-iterate / interrupted-resume paths
  (`crossClarifyIteration` unchanged from prior row).

### 4.3. Pass it at both `insertNodeRun` callsites inside `scheduleAgentNode`

- `:1065` — initial mint (no pending exists).
- `:1147` — RFC-042 in-attempt retry mint. **This is the bug's core site.**

Both gain `crossClarifyIteration: inheritedCrossClarifyIteration` in the
inherit map.

### 4.4. Refresh the explanatory comment at `:1296-1305`

The pre-existing comment "an in-attempt RFC-042 retry inherits
crossClarifyIteration from the row it retries" was aspirational; the
post-patch comment now points at `inheritedCrossClarifyIteration` and
back-references this patch md so the next reader knows why the inheritance
is explicit.

## 5. Tests

| test file                                                                       | what it locks                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/backend/tests/cross-clarify-retry-preserves-iteration.test.ts` (new)  | (a) inheritance derivation reads `latestExisting.crossClarifyIteration`; (b) empty-history mint stays 0; (c) fan-out children are skipped; (d) `buildExternalFeedbackContext` populates against the post-inheritance value; (e) questioner-side mirror; (f) 4 source-text guards |
| `packages/backend/tests/cross-clarify-update-mode-injection.test.ts` (existing) | continues to pass — the §6 update-mode injection contract that family patch chain protects                                                                                                                                                                                       |
| `packages/backend/tests/cross-clarify-designer-retry-index.test.ts` (existing)  | continues to pass — the freshness shield patch-2026-05-23 enforces                                                                                                                                                                                                               |

The new file's header explicitly cites the user's symptom verbatim so any
future refactor that turns the test red has a clear trail back to the
incident.

### 5.1. Source-text guards (third line of defence)

The behavioural tests above all run against synthetic DB state. They do
NOT exercise `scheduleAgentNode` end-to-end (booting the scheduler in a
unit test would require opencode + worktree fixtures heavier than the
patch warrants). A drift that removes `crossClarifyIteration` from one of
the inherit call-sites would therefore be silent — the helpers all keep
returning the right thing on their own.

To prevent silent re-introduction, the new test file greps `scheduler.ts`
directly:

1. `insertNodeRun`'s `inherit?: { … }` typedef contains `crossClarifyIteration?: number`.
2. `insertNodeRun`'s `db.insert(nodeRuns).values({…})` writes
   `crossClarifyIteration: inherit?.crossClarifyIteration ?? 0`.
3. The `inheritedCrossClarifyIteration` const is computed off
   `latestExisting?.crossClarifyIteration ?? 0`.
4. Both `insertNodeRun(db, taskId, node.id, 'pending', …, iteration, {…})`
   calls inside `scheduleAgentNode` include `crossClarifyIteration:
inheritedCrossClarifyIteration` in their inherit map.

Pairs with the source-text guards already in
`cross-clarify-update-mode-injection.test.ts` (which lock the absence of
`retryIndex === 0` from the gates).

## 6. Out of scope

- Generalising `cross_clarify_iteration` into `isFresherNodeRun` (so the
  freshness comparator itself enforces the invariant). Long-term
  direction; touches a hot comparator used across the scheduler and
  warrants its own RFC. Same rationale as patch-2026-05-23 §6.
- Auditing every OTHER `insertNodeRun` call in the file (the
  process-error path mints rows too — those rows mark `failed`/`canceled`
  for housekeeping and never feed back into the cross-clarify gate;
  leaving them at default 0 is correct).
- Threading `crossClarifyIteration` through the clarify-rerun mint path
  inside `clarify.ts` / `submitClarifyAnswers`. That path's contract is
  separate (RFC-023) and not implicated in this symptom; will be
  revisited if a similar inheritance gap surfaces.

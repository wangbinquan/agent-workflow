# RFC-343 实施计划 — Intent Apply 恢复正确性

状态：In Progress（2026-08-29；本地候选完成，发布/hosted CI 未执行）。

## 1. 任务

### T0 — live diagnosis（Done）

- [x] 对照 RFC-294 P0-B 与 Intent apply/converger/current tests；
- [x] 复现/定位 lock identity、compensation terminality、lossy artifact 与 stale roll-forward 四类问题；
- [x] 与 RFC-341/W3 协调源码及 canonical generator 临界区。

### T1 — lock correctness（Done）

- [x] map 保存/比较同一 actual chain；
- [x] test-only lock count/reset seam；
- [x] last-chain 与 high-cardinality residue mutation tests 已写。

### T2 — artifact codec（Done）

- [x] 新增 explicit V1 envelope；
- [x] 保存完整 nested `StagedSkillVersion`；
- [x] 无损 legacy compatibility 与 lossy legacy fail-closed；
- [x] roundtrip、字段 mutation、unknown/corrupt tests 已写。

### T3 — compensation / convergence（Done）

- [x] durable artifact 成为恢复 oracle；
- [x] compensation 任一失败保留 retryable state/error；
- [x] committed fact 之后只 roll forward，不做补偿；
- [x] 完整 skill-version tail publish、CAS 与重复 convergence；
- [x] stale audit row 与 corrupt artifact mutation tests 已写。

### T4 — lightweight validation（Done）

- [x] exact P0-B Prettier；
- [x] exact P0-B ESLint `--max-warnings 0`；
- [x] backend typecheck（RFC-341 收口其在制诊断后全绿）；
- [x] 按项目约定不跑本地 Bun test/gate，以最终 exact-SHA hosted CI 为准。

### T5 — publication / hosted closeout（Pending）

- [ ] 与 RFC-341 协调 canonical generator 和 publication critical section；
- [ ] fetch/sync，确认 shared index 与 exact allowlist；
- [ ] 用户授权后才可 exact-stage/commit/push；
- [ ] 核验 remote ancestry 与 exact-SHA required CI；
- [ ] hosted backend tests 成功后更新 RFC-294 P0-B 为 Done。

## 2. 当前 candidate allowlist

- `packages/backend/src/services/intent/applyChangeset.ts`
- `packages/backend/src/services/intent/journalArtifacts.ts`
- `packages/backend/tests/rfc234-apply-changeset.test.ts`
- `packages/backend/tests/rfc271-intent-skill-plugin-update.test.ts`
- `packages/backend/tests/rfc343-intent-apply-correctness.test.ts`
- 本 RFC 三件套、`design/plan.md`、`STATE.md` 与 RFC-294 successor note

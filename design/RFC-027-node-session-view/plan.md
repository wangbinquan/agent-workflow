# RFC-027 — 任务分解

> 配套文件：[proposal.md](./proposal.md) / [design.md](./design.md)

## 子任务清单

| ID | 任务 | 依赖 | 说明 |
|----|------|------|------|
| RFC-027-T1 | shared 层 SessionTree 类型 + zod schema + `parseSessionTree` 纯函数 | — | `packages/shared/src/sessionView.ts` + `packages/shared/src/schemas/sessionView.ts` + `tests/session-view-parse.test.ts` ≥ 12 case + `tests/session-view-schema.test.ts` 4 case |
| RFC-027-T2 | DB migration 0010 + drizzle schema 加 sessionId / parentSessionId | T1 | `db/migrations/0010_rfc027_node_run_events_session.sql` + `db/schema.ts` `nodeRunEvents` 加两列 + 索引；同步 `meta/0010_snapshot.json` 与 `_journal.json`（手动校 prevId 链，沿用 RFC-024 0008 修法）；`tests/migration-0010-events-session-id.test.ts` 4 case |
| RFC-027-T3 | runner 后置读 opencode SQLite 捕获子 session | T2 | `services/sessionCapture.ts`：`resolveOpencodeDbPath()`（走 xdg-basedir，与 opencode `Global.Path.data` 对齐；`OPENCODE_TEST_HOME` 优先）+ `captureChildSessions()`（readonly Database + BFS session.parent_id + transcode → batch insert）+ `transcodeOpencodeRowsToEvents()` 纯函数；runner.ts step 9 与 step 10 之间挂调用，所有失败 catch 落 `subagent-capture-failed` marker。**测试**：`tests/session-capture-sqlite.test.ts` 6 case（fixture sqlite 含三层嵌套 / DB 缺失 / readonly 不写 / 根 sessionId 未知 skip / BFS 顺序稳定 / 老行 NULL 兼容）+ `tests/transcode-opencode-rows.test.ts` 5 case（assistant text / tool / step / 不识别丢弃 / 排序 tiebreaker）+ `tests/runner-session-id-persist.test.ts` 2 case（stdout 路径 events.session_id 落根 / parent_session_id=null） |
| RFC-027-T4 | backend REST 端点 `GET /api/tasks/:taskId/node-runs/:nodeRunId/session` + WS invalidation 映射 | T1, T2 | `routes/sessionView.ts` + `server.ts` 注册 + `tests/routes-session.test.ts` 5 case |
| RFC-027-T5 | 前端 Session tab + ConversationFlow + SubagentBlock + i18n + 样式 | T1, T4 | `components/node-session/SessionTab.tsx` + `ConversationFlow.tsx` + `SubagentBlock.tsx` + `MessageBlock.tsx` + `NodeDetailDrawer.tsx` tab 改名；i18n 中英 +10 key；`styles.css` ~80 行；测试 5 + 4 + 5 + 4 = 18 case |
| RFC-027-T6 | e2e | T3, T5 | `e2e/main.spec.ts` 新增 1 case：跑一个含 subagent 的 fixture workflow → 等 done → 选节点 → Session tab → 展开 Subagent → 看到子 session 文本 |
| RFC-027-T7 | RFC 落档收尾 | 全部上 | `design/plan.md` RFC-027 索引 Draft→Done；`STATE.md` 顶部"进行中 RFC"行删除 + 已完成 RFC 列表插入 RFC-027 行；commit + push + 等 CI 全绿 ([feedback_post_commit_ci_check]) |

## PR 拆分建议

**默认按单 PR 走**（CLAUDE.md RFC 流程默认要求）。

opencode 1.15.0 在 `run` 模式不开 TCP 端口（`packages/opencode/src/cli/cmd/run.ts:806/838` 走 in-process fetch），因此**不再走 SSE 订阅路径**；改为 child.exited 后只读打开 opencode SQLite (`~/.local/share/opencode/opencode.db` 等 xdg path) BFS `session.parent_id` 拉子 session。该路径同步、零额外 spawn、无并发风险，T3 不再需要 spike，直接实现 + 单测覆盖。

如果开发中发现 opencode DB schema 在 1.15.x 内发生 break change 或路径机制不稳，允许临时拆为：

- PR-A：T1 + T2 + T4 + T5（**全 stdout 路径**，子 session 永远 capture missing；UI 完整可用，走 AC-10 兜底）
- PR-B：T3 + T6（补 SQLite 后置读 + e2e）

PR-A 单独上时，proposal.md AC-5 / AC-6 需在 PR-A commit message 与 STATE.md 中明确标注"子 session 兜底渲染"以提示用户。

## 验收清单（合并前必跑）

- [ ] `bun run typecheck` 干净
- [ ] `bun run lint` 干净
- [ ] `bun run format:check` 干净
- [ ] `bun run test` 在 shared / backend / frontend / scheduler 子套件中均全绿
- [ ] Playwright e2e 全部 case 通过（含新增 RFC-027 case）
- [ ] manual smoke：用一个真实带 subagent 的 workflow 在 dev server 上跑通：
  - [ ] Session tab 默认选中
  - [ ] 第一条消息是 user prompt
  - [ ] tool call 卡片渲染正确
  - [ ] 至少一层 subagent 折叠/展开
  - [ ] 三层嵌套 subagent 在子 fixture 下显示无错位
  - [ ] opencode 不暴露 SSE 端口时，子 session 走兜底文案，不抛错
- [ ] CI 全 6 job 绿（macos+ubuntu × lint+test / build smoke / playwright）
- [ ] 多人协作：不删除并发 RFC-026 / 他人 untracked 文件；commit 仅 `git add` 自身改动路径
- [ ] STATE.md / design/plan.md 同步更新
- [ ] commit message 前缀：`feat(rfc-027): node session view + subagent nesting`

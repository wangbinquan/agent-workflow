# RFC-223 完成交接（HANDOFF）

## 状态（2026-07-23）

**Done。PR-1～PR-9、T1–T17、AC1–AC20 全部交付。** 本文件所在提交是 RFC-223 的本地完成态；本次未获授权推送，因此不得表述为已进入 `origin/main` 或远端 CI 已绿。

## 已交付契约

- 六类租户资源内部均以 stable id 为规范身份；agents / skills / mcps / workgroups 的 URL、REST 与写侧已改为 id，plugins / workflows 延续既有 id 寻址。
- agents / skills / mcps / plugins / workgroups 五类名称唯一性已收敛为 `(owner_user_id,name)`；workflows 保持 name 非唯一，runtimes 保持机器级全局唯一。
- 活引用、冻结快照、动态 workflow token、fusion provenance、scheduled target 与反向依赖均按 id 解析；冻结历史身份无法可信回填时 fail-closed，不按当前 name 猜测。
- skill 文件系统、版本与恢复链按 id；migration barrier、crash recovery、forward-restore 与 boot verify 已闭环。
- agent / workflow 导入 mapping 与 OCC、skill ZIP 的 owner 作用域 + stable `skillId` + owner / OCC、owner transfer 409 均已交付。
- ordinary reference 写入、删除与 scheduled target 已用同事务 fence 封闭 check-to-write 竞态；反向依赖只按 stable id 披露。
- opencode / Claude Code 注入仍在外部边界使用 name，但只发生在 id hydration 后；同一 managed 闭包内不同 id 同名会以 `duplicate-name-in-closure` 硬失败。
- AC16 已有两 owner 同名动态成员的真实 generate→approve→execute 证明，不会按 name 误选 runtime profile。
- T15 exact AST 指纹多重集护栏已完成真实 mutation red→restore green 实证。

## 关键收口提交

- 地基与迁移：`8f1f13ae`、`27b7a9b8`、`d8c0c432`、`726512b1`、`0fe04bec`、`0bc7d558`、`562a368d`。
- canonical URL / wire / 前端与唯一性翻转：`e6f9bfa7`～`03f9cf86`、`d2f367b9`～`b2653ffb`。
- 审计与竞态 fence：`53af6b94`、`b280d6b0`、`86532afc`、`b2a5a8d5`、`cc1a5bc8`、`1fe7de4a`。
- 结构守卫与最终验收：`cb42f148`、`c28541ab`、`fe1fba43`、`25b7dd02`、`5221b066`、`39e72632`、`4eacb2a7`。

## 验证

- `bun run test`：backend `6946 pass / 23 skip / 0 fail`、shared `1435/1435`、frontend `5249/5249`。
- `bun run e2e`：142 passed / 31 environment-gated skipped / 0 failed。
- RFC-223 critical suite：84/84。
- T15 structural guard：还原态 8/8；真实非法 production sink 注入时按预期变红。
- `bun run typecheck`、`bun run lint`、`bun run format:check`、`bun run build:binary` 与 `git diff --check` 全绿。

## 范围边界

- [RFC-224](../RFC-224-opencode-execution-identity/proposal.md) 独立承担 opencode 最终 resolved-config 执行身份完整性，不阻塞 RFC-223 完成，也不应回记为 RFC-223 欠账。
- RFC-223 当前无剩余实现债；本次完成态仅在本地提交并集成，不含远端推送。

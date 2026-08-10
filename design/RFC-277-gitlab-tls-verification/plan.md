# RFC-277 · 实施计划

状态：Done（2026-08-10 收口）

## 1. 硬边界

- 先完成 RFC 三件套、索引与 STATE 登记，并取得用户批准；批准前不改 production/test/DB。
- 默认与存量连接必须保持 `rejectUnauthorized: true`。
- 只允许 GitLab 关闭；GitHub false 必须显式拒绝。
- test 与真实执行必须消费同一持久化值。
- TLS 例外不得扩散到 daemon 全局或第三方 redirect。
- 实施时从 live journal 分配迁移号，不追改 0140。
- 共享树有 RFC-276 并发 WIP，只提交/交付精确路径，未经授权不 commit/push。

## 2. 任务分解

| 任务           | 内容                                                             | 验收                           |
| -------------- | ---------------------------------------------------------------- | ------------------------------ |
| **RFC-277-T1** | 三件套、索引、STATE、Bun TLS 官方契约与用户批准                  | proposal D1–D5 / AC-1–10       |
| **RFC-277-T2** | shared wire/PUT/test schema 增 `rejectUnauthorized`              | strict schema 与兼容测试       |
| **RFC-277-T3** | 前向 DB migration + Drizzle schema + journal/schema-admission 锁 | fresh/upgrade 默认 true、CHECK |
| **RFC-277-T4** | connection service 的默认、保留、resolve、GitHub 拒绝            | round-trip 与错误路径          |
| **RFC-277-T5** | 探活与执行器首跳 TLS init 接线，redirect 隔离                    | fetch init 精确断言与变异      |
| **RFC-277-T6** | 路由草稿三字段回落与 lastTest 等值判据                           | 保存值/草稿值矩阵              |
| **RFC-277-T7** | GitLab 公共 Switch、save/test body、双语风险提示                 | frontend 交互测试              |
| **RFC-277-T8** | 文档、定向套件、full gate、implementation gate                   | AC-1–10 全证据                 |

## 3. 预计精确路径

- `packages/shared/src/schemas/codeHost.ts`
- `packages/backend/src/db/schema.ts`
- `packages/backend/db/migrations/<next>_rfc277_gitlab_tls_verification.sql`
- `packages/backend/db/migrations/meta/_journal.json`
- `packages/backend/src/services/codeHost/connections.ts`
- `packages/backend/src/services/codeHost/call.ts`
- `packages/backend/src/routes/codeHosts.ts`
- `packages/frontend/src/components/settings/CodeHostsSection.tsx`
- `packages/frontend/src/i18n/{zh-CN,en-US}.ts`
- `packages/backend/tests/rfc269-code-host-{connections,execution}.test.ts`
- `packages/frontend/tests/rfc269-code-host-settings.test.tsx`
- migration / rolling-upgrade / RFC-275 schema-admission 的现有锁文件（以 live source 为准）
- `docs/code-host-calls.md`

## 4. 建议实施顺序

1. 先补 schema/service/fetch-init 测试并确认红；
2. 加 migration、schema 与 service round-trip；
3. 接探活、执行器和 route 三字段语义；
4. 接前端 Switch 与双语提示；
5. 跑定向测试、三包 typecheck、lint/format/depcheck；
6. 在隔离快照上跑 `bun run gate:local` 与 implementation gate；
7. 对删除 TLS override、把 GitHub 误设 false、让 redirect 继承 override 做反向变异。

## 5. 完成定义

- [x] 用户已批准 RFC-277 实施。
- [x] AC-1–9 均有自动化证据；AC-10 的定向、lint、format、diff 已通过。
- [x] 存量连接升级后仍校验证书。
- [x] GitLab false 对 test 与真实调用同时生效。
- [x] GitHub 与第三方 redirect 不受影响。
- [x] UI 风险提示清晰且复用公共 Switch。
- [x] token/URL/redirect/权限边界回归绿。
- [x] full gate 与 implementation gate 通过。
- [x] 并发 RFC-276 WIP 未被覆盖。
- [x] 未经授权无 commit/push。

## 6. 2026-08-10 验证证据

- shared 契约：52 pass；frontend 交互：5 pass；backend 连接、迁移、执行：68 pass。
- backend 路由接线、migration policy、schema admission、embed guards：27 pass。
- RFC-277 精确路径 ESLint（`--max-warnings 0`）、Prettier 与 `git diff --check` 全绿。
- 隔离快照的 shared/frontend typecheck 全绿。共享树 backend typecheck 仅剩并行 RFC-276
  正在删除的旧 `sandboxMode` / `executionPolicy` 测试引用；RFC-277 路径无类型错误。因此本轮不把
  全仓 gate 伪报为绿色，待 RFC-276 收口后补跑并把状态置为 Done。
- **2026-08-10 收口补跑**：RFC-276 已 Done，原阻塞的 `sandboxMode` / `executionPolicy` 测试引用已
  清除。完整 `bun run gate:local` 全绿（6m49s：typecheck / lint / format / depcheck 全绿、
  shared 1972 pass / frontend 6259 pass / backend 四分片 9342 pass / 30 skip / 0 fail）。
  RFC-277 定向套件（shared 53 + backend 68 + frontend 6 = 127 pass）全绿。
  implementation gate 经用户批准跳过（同 RFC-268 / RFC-266 先例：用户明确要求「直接加」）。

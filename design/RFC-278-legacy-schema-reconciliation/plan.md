# RFC-278 · 实施计划

状态：In Progress（用户已批准；实施按 live schema 精简方向调整）

## 1. 边界

- 本 RFC 是 RFC-275 检出真实漂移后的 forward repair，并恢复 RFC-276 自然 runtime 的可启动性。
- 不恢复任何 runtime hardening；不修改历史 SQL/receipt；不提供 admission bypass。
- production/test 可按批准方案实施；真实 DB 只在代码、测试、备份均通过后切换。
- shared main 并发工作保留；新增 migration 编号在开工时再次核对 live journal。

## 2. 任务

| 任务   | 内容                                                         | 验收                                                             |
| ------ | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| **T1** | 冻结现场证据、8 个 full hash、物理 diff 与 row-validity 聚合 | 不读取/记录业务行内容                                            |
| **T2** | 先写 legacy fixture 与 alias polarity 红测试                 | 8 pass + mutation/wrong-tag/wrong-when red                       |
| **T3** | `assertMigrationHistory` 接 exact alias matcher              | RFC-275 任意编辑测试仍红                                         |
| **T4** | 新增 0145 + journal append                                   | recovery 逐列无损收敛、receipt 清空重建、两张 retired table 删除 |
| **T5** | 0141→HEAD production `openDb` 升级集成                       | physical manifest canonical；reopen 幂等                         |
| **T6** | alias/DDL/新 receipt 约束 mutation                           | 通配放行、缺对象或约束退化时必红                                 |
| **T7** | focused → backend/shared/frontend → full gate                | 全绿，三平台 CI 终态                                             |
| **T8** | 更新 RFC/STATE/docs，exact-path commit/push                  | containing SHA 与 origin/main 可证                               |
| **T9** | 无 active run 时现场优雅切换，验证 UI probe                  | v0.18.2+ daemon + natural OpenCode conforms                      |

## 3. 预计文件

- `packages/backend/src/db/schemaAdmission.ts`
- `packages/backend/db/migrations/0145_rfc278_legacy_schema_reconciliation.sql`
- `packages/backend/db/migrations/meta/_journal.json`
- `packages/backend/tests/rfc278-legacy-schema-reconciliation.test.ts`
- 必要的 migration/upgrade test fixture helper
- `design/RFC-278-legacy-schema-reconciliation/*`
- `design/plan.md`、`STATE.md`、`docs/dev-gotchas.md`（历史 migration 真机 fixture 教训）

## 4. 完成定义

- [x] 用户确认并批准实施，随后明确要求 live schema 该精简则精简。
- [x] 8 个 exact aliases 之外无任何 history 放宽。
- [x] recovery 数据等值、旧 MCP receipt reset、retired tables 删除、最终 physical canonical、second reopen 通过。
- [x] 无 retired runtime launcher/sandbox/identity 入口回流。
- [x] full local gate 与真实 OpenCode probe 成功。
- [ ] exact/containing SHA CI 终态成功。
- [ ] 真实 DB 自动备份后升级；quick/FK/schema admission 与 UI probe 均通过。

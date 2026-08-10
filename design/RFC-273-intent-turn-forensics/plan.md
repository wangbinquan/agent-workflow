# RFC-273 · 实施计划

> 状态：Done（2026-08-10）；全部任务与完成定义已由最终本地门禁验证。

## 1. 任务分解

| 任务           | 内容                                                                      | 验收                               |
| -------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| **RFC-273-T1** | RFC 三件套、索引、STATE；固定 guidance 常量与兼容性清单                   | 用户批准；正式 parser 上限明确不改 |
| **RFC-273-T2** | `SystemAgentOutputEvidence`、饱和计数、driver event/terminal observer     | AC-1、AC-2、AC-6                   |
| **RFC-273-T3** | missing-envelope reason 纯分类、runMeta/content 持久化                    | AC-3…5；stderr 空也有证据          |
| **RFC-273-T4** | Intent 成功 scratch 延迟 disposition、安全 release helper、boot/hourly GC | AC-7、AC-8                         |
| **RFC-273-T5** | `INTENT.md` 8 ops / 6 nodes / 256 KiB 单一源与拆批协议                    | AC-9、AC-10；parser 反向锁         |
| **RFC-273-T6** | DTO + Intent error card zh/en 诊断、保留提示；事件树不变                  | AC-11；legacy 行降级               |
| **RFC-273-T7** | deterministic 13/9/6 形态 fixtures、聚焦/完整门、实现门                   | AC-12；模型真跑不作 CI oracle      |

## 2. 预计文件范围

- `packages/backend/src/services/systemAgentRun.ts`
- `packages/backend/src/services/runtime/{types,opencode/events,claudeCode/events,...}.ts`
- `packages/backend/src/services/intent/{turnEngine,document,maintenance}.ts`
- `packages/backend/src/cli/start.ts`
- `packages/shared/src/schemas/intentSession.ts`
- `packages/frontend/src/routes/intent.detail.tsx`、Intent 诊断 helper/tests、zh-CN/en-US
- backend/shared/frontend 对应 RFC-273 测试与本文档

## 3. 实施纪律

1. 先用现有“超过 cap 静默丢弃”和“ok 后 scratch 已删”写红回归。
2. evidence 先落通用 primitive，再接 Intent；不得只在 turnEngine 猜事件树。
3. scratch 删除必须走路径安全 helper；不把有效业务结果变成 cleanup error。
4. 最后加 UI 与 guidance，跑 parser 上限反向锁。

## 4. 完成定义

- proposal AC-1…12 全有证据；
- 四类 missing-envelope 在 DB/HTTP/UI 一致，metadata 零正文/路径/秘密；
- protocol 失败现场默认可查 24 小时，成功不积目录，running 不被 GC；
- 大合法 changeset 仍能 parse，agent 默认分批协议有 deterministic fixture；
- `bun run gate:local` 与 Codex 实现门全绿；不擅自 commit/push。

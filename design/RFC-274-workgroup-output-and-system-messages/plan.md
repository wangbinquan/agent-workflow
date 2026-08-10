# RFC-274 · 实施计划

> 状态：Done（2026-08-10）；全部任务与完成定义已由最终本地门禁验证。

## 1. 任务分解

| 任务           | 内容                                                                          | 验收                              |
| -------------- | ----------------------------------------------------------------------------- | --------------------------------- |
| **RFC-274-T1** | RFC 三件套、索引/STATE、system callsite reviewed inventory、用户确认 C1–C5    | 范围与 dynamic-original 清单完整  |
| **RFC-274-T2** | outputContract shared/resource/runtime schema、DB migration、唯一 resolver    | AC-1、AC-6；旧默认 files          |
| **RFC-274-T3** | CRUD/copy/resource-package/launch/task-config/prompt/UI round-trip            | AC-4、AC-5；工具权限不变          |
| **RFC-274-T4** | zero-delta files-only gate 与双向回归                                         | AC-2、AC-3；discussion git 调用 0 |
| **RFC-274-T5** | system template insert registry、params schema、fallback、message columns/DTO | AC-7…9；非法组合拒绝              |
| **RFC-274-T6** | 全 backend platform system callsite 迁移 + original allowlist + 源码 guard    | AC-12；无单条孤立翻译             |
| **RFC-274-T7** | viewer renderer、RoomTimeline/reference/search/copy、zh-CN/en-US              | AC-10、AC-11                      |
| **RFC-274-T8** | 迁移/服务/前端/E2E、真浏览器、完整 gate、实现门                               | AC-13；rolling fallback 复验      |

## 2. 预计文件范围

- `packages/shared/src/schemas/{workgroup,workgroupRuntime}.ts` 与 bundle workgroup payload
- `packages/backend/src/db/schema.ts`、下一 migration/meta journal
- `packages/backend/src/services/workgroups.ts`、`services/workgroup/{launch,messages,context,prompts,...}`
- 所有 reviewed platform system message callsite
- `packages/frontend/src/components/workgroup/{WorkgroupForm,WorkgroupTaskConfigDialog,...}`
- `packages/frontend/src/components/workgroup/room/RoomTimeline.tsx`、room helpers、zh/en i18n
- shared/backend/frontend/e2e 对应 RFC-274 测试与文档

## 3. 批次顺序

1. 先 schema + migration + output contract round-trip，确保旧默认与包格式不丢字段。
2. 单独落 zero-delta 双向测试，避免 i18n 大 diff 掩盖行为修复。
3. 建 registry/constructor，再机械迁移 callsite；不先散落 key 字符串。
4. 最后 viewer localization 与浏览器验收，rolling fallback 和 agent prompt 各自对拍。

## 4. 完成定义

- proposal AC-1…13 全有 oracle；
- discussion 零误报、files 防护不退化，配置所有持久化/导入导出面一致；
- 平台系统消息全量 registry 化，动态原文有显式分类，旧/未知 key 永远 fallback；
- 同一消息按 viewer locale 正确渲染，agent/旧客户端仍得完整 fallback；
- migration rolling-upgrade、`bun run gate:local`、Codex 实现门全绿；不擅自 commit/push。

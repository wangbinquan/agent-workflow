# RFC-255 · 受控自定义 OpenAI-compatible Provider 准入 — plan

状态：**Draft**（设计门 + 用户批准前不动代码）

## 任务分解

| 任务 | 内容 | 依赖 |
| --- | --- | --- |
| RFC-255-T1 | shared：`CustomProviderEntry` zod schema + 校验纯函数（正则/唯一/URL/`${`/NUL/清单/掩码串拒收）+ 测试 | — |
| RFC-255-T2 | backend 存储/API：daemon config 新顶层键接入 `loadConfig`/`applyConfigPatch`；GET 掩码 / PUT 保留语义；`config-custom-provider-*` ValidationError 码 + i18n 双语 + 测试（含读-改-写回环 R4、内置 id 冲突校验） | T1 |
| RFC-255-T3 | `customProvider.ts` 单一事实源（查找+全量校验 / 受控段 / auth / 枚举段+投影摘要）；`buildControlledOpencodeConfig` 增 `customProvider?` 入参；`OPENCODE_CONFIG_CONTENT` 无 key 文本断言 + 快照测试 | T1 |
| RFC-255-T4 | `verifiedLauncher.verifySelectedProviderInventory` 增 `admittedCustom?` 追加校验 + 正/反组合测试 + **行为 fixture**（qualified 二进制下 config provider 报告形状，R1 锁） | T3 |
| RFC-255-T5 | `models.ts` 枚举注入 + cacheKey 掺投影摘要 + 测试（含枚举面无 key、禁用消失、缓存失效） | T3 |
| RFC-255-T6 | 三计划面接线（`verifiedPlan` / `verifiedSystemPlan` / `verifiedMcpTestPlan`）：命中分支 + `buildCustomProviderAuth` 凭据分支 + 内置 provider 三通道回归（R6）+ 测试 | T3 |
| RFC-255-T7 | e2e（gated）：`127.0.0.1` OpenAI-compatible stub 网关；全链路绿 / key 轮换 resume 绿 / baseURL 变更 resume 拒 / system 与 MCP-test 冒烟 | T4,T5,T6 |
| RFC-255-T8 | 前端：Settings CRUD（公共组件）+ 掩码回显 + picker 验证 + i18n 中英 + RTL 测试 | T2 |
| RFC-255-T9 | 文档收口：`docs/OPENCODE_CONFIG.md` 契约段；`docs/audit-backlog.md` at-rest 加密未决项；`design/plan.md` / `STATE.md` 状态更新为 Done | T1–T8 |

## PR 拆分

单 PR（trunk 直提，小步 commit）：`feat(runtime): RFC-255 受控自定义 OpenAI-compatible provider 准入`。
T1–T6 为一段连续提交（每步全套门禁绿），T7 gated e2e 与 T8 前端可并行收尾，T9 收口。

## 验收清单

- [ ] AC-1 配置 CRUD 校验全绿（正/反用例）
- [ ] AC-2 掩码语义 + 读-改-写回环不丢 key
- [ ] AC-3 枚举含/去 custom 模型、缓存键失效、枚举面无 key
- [ ] AC-4 业务 / system / MCP-test 三面端到端
- [ ] AC-5 报告面逐字节校验（url/npm/source/模型集）
- [ ] AC-6 key 轮换 resume 绿；端点变更 resume 拒
- [ ] AC-7 禁用/删除失败路径 + i18n hint
- [ ] AC-8 文档两处收口
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；push 后按 exact SHA 查 CI

# RFC-255 · 受控自定义 OpenAI-compatible Provider 准入 — plan

状态：**设计门已过（2026-08-04，`design-gate-2026-08-04.md`，findings 全部折入）；
用户已批准实现（「1、2、3一起，全面审计并把功能修好」）**。
RFC 索引与 STATE.md 登记已于落档 commit `0bd78d53` 完成（设计门 P2-7 注记）。

## 任务分解

| 任务 | 内容 | 依赖 |
| --- | --- | --- |
| RFC-255-T1 | shared：`CustomProviderEntryWire` schema（apiKey optional、掩码合法）+ 校验纯函数（正则/唯一/URL/`${`/NUL/清单/新条目须真 key）+ **静态目录 id 快照集**（`PROVIDER_API_KEY_ENV` 键 ∪ pinned 目录快照）+ 新失败码 `execution-identity-custom-provider-disabled` 入闭集 + 棘轮测试全套同步（taxonomy / i18n-phase-b / rfc203-validation-copy）+ 测试 | — |
| RFC-255-T2 | backend 存储/API：config 新顶层键；apiKey **secretBox 密封**（RFC-036 同一平台密钥）+ `saveConfigRaw` 0600 + 存量 chmod；`maskConfigForOutput` 覆盖 **GET + PUT 响应 + CLI `config get`**；PUT 语义门（按 id 配对保留、改 id 视同新条目、掩码拒收）提取纯函数供 **CLI `config set` 共用**；canary 探针（仅新增/改 id；不可用给可指认错误）；`config-custom-provider-*` 错误码 + i18n 双语；备份面姿态验证（config 是否入备份包、密封值随行）+ 测试（含读-改-写回环、旁路封堵、磁盘无明文断言） | T1 |
| RFC-255-T3 | `customProvider.ts` 单一事实源（`findCustomProvider` 三态 / 运行段无 name 无 key / `buildCustomProviderAuth`（解封+strictApiEntry）/ 枚举段带 name / `admittedCustomFromExpectedConfig` 互逆）；`buildControlledOpencodeConfig` 增 `customProvider?` 入参；`OPENCODE_CONFIG_CONTENT` 无明文 key 文本断言 + 快照测试 | T1 |
| RFC-255-T4 | `verifiedLauncher`：从 `manifest.expectedConfig.provider` 推导准入值 + 追加校验（source/npm/url 逐字节/options.baseURL/模型 ⊆）+ manifest codec 对 expectedConfig 新键兼容验证 + 正/反组合测试 + **行为 fixture**（qualified 二进制 config provider 报告形状，R1 锁；含 canary 阴性断言 R5） | T3 |
| RFC-255-T5 | `models.ts`：枚举注入（enabled 全集、带 name、无 key）+ **两级缓存键**（binary → 投影摘要，逐出随 binary 整体）+ 测试（custom 模型出现/禁用消失/键逐出/枚举 env 无 key） | T3 |
| RFC-255-T6 | 三计划面接线（`verifiedPlan` / `verifiedSystemPlan` / `verifiedMcpTestPlan`）：三态判定（enabled 注入+专属凭据 / disabled 新码 / absent 原路径逐字节不变）+ 内置 provider 回归锁（R6）+ 测试 | T3 |
| RFC-255-T7 | e2e（gated）：`127.0.0.1` OpenAI-compatible stub 网关；全链路绿 / key 轮换 resume 绿 / **改显示名 resume 绿**（D12）/ baseURL 变更 resume 拒 / system 与 MCP-test 冒烟；双 OS（macOS 半边补 R3 的 outer network-allow 实证） | T4,T5,T6 |
| RFC-255-T8 | 前端：Settings CRUD（公共组件 Dialog/Field/TextInput/ChipsInput/Switch/Select）+ 掩码回显与保留提交 + picker 自定义模型 + **unknown provider 渲染兜底 RTL**（删除后存量引用不空白）+ `provider-untrusted`/新码 hint 文案 + i18n 中英 + RTL 测试 | T1,T2 |
| RFC-255-T9 | 文档收口：`docs/OPENCODE_CONFIG.md` 契约段；`docs/dev-gotchas.md` 新增「**密封枚举 ≠ 目录全集**」通用坑（设计门 P0-1 实测首次揭示）；`docs/audit-backlog.md` 增补「mcps.headers 迁移 secretBox」（替代原「统一加密」措辞，P1-4）；`design/plan.md` / `STATE.md` 状态收口 | T1–T8 |

## PR 拆分

单 PR（trunk 直提，小步 commit）：`feat(runtime): RFC-255 受控自定义 OpenAI-compatible provider 准入`。
T1–T6 为连续提交（每步全套门禁绿），T7 gated e2e 与 T8 前端并行收尾，T9 收口。
代码完成后跑**实现门**（Codex 不可用时按 dev-gotchas 止损姿势换同强度独立子代理，记档）。

## 验收清单

- [ ] AC-1 配置 CRUD（含双层 id 冲突校验、掩码语义门、无归一化）正/反全绿
- [ ] AC-2 任何 /api/config 响应与 CLI 输出掩码；secretBox 落盘无明文；回环不丢 key
- [ ] AC-3 枚举含/去 custom 模型、两级缓存键、枚举面无 key
- [ ] AC-4 业务 / system / MCP-test 三面端到端
- [ ] AC-5 报告面逐字节校验 + ⊆ 安全锁
- [ ] AC-6 key 轮换 / 改名 resume 绿；端点与清单变更 resume 拒
- [ ] AC-7 禁用新码 + 删除两分支语义 + 双 hint 补强
- [ ] AC-8 文档四处收口（含 dev-gotchas 新坑 + backlog 改写）
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；push 后按 exact SHA 查 CI

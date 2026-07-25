# RFC-228 Agent 引用资源完整性与启动失败关闭 — plan

状态：Done（2026-07-24；实现提交 `bf1b3e1a` 已推送 `main`）。

## 任务

- [x] **T1 现状定位**：确认 picker raw-id fallback、missing managed Skill 保存缺口、
      Workflow MCP 缺口、Workgroup member closure 缺口和 scheduler silent-drop。
- [x] **T2 完整性 oracle**：实现完整 inventory、Agent closure遍历、固定 issue 与安全错误投影。
- [x] **T3 Agent 保存门**：create/update 校验完整 candidate closure；project Skill保持 repo-local。
- [x] **T4 Workflow/启动门**：Workflow MCP校验、Direct Agent、Workgroup 与 Schedule 接线。
- [x] **T5 Runtime fence**：Skill/MCP/Plugin requested-vs-hydrated exact-set检查。
- [x] **T6 名称与错误 UX**：actor-safe resource status、picker label overlay、类型化 fallback、
      Agent/Workgroup known-invalid Launch gate与中英错误。
- [x] **T7 定向回归**：Agent/Workflow/Workgroup/runtime/picker 与 disabled-MCP兼容测试。
- [x] **T8 收尾门禁**：format、lint、typecheck、相关全量测试与工作树归属复核。
- [x] **T9 文档完成态**：门禁通过后更新 RFC、`STATE.md` 和 `design/plan.md`。

## 不变约束

- id 是持久身份，name 只用于展示。
- ACL-hidden existing ref不判 missing、不泄露名称。
- project Skill不做 DB existence gate。
- disabled MCP保持 RFC-223 “存在但不注入”语义。
- 前端状态只作 advisory；服务端保存/启动/runtime gate是最终权威。
- 不覆盖、不格式化、不 stage共享工作树中的 RFC-224/RFC-225 在途文件；未经用户要求不提交推送。

## 验收

- [x] 可见资源显示名称；unresolved/hidden/missing不显示 raw id。
- [x] Agent save拒绝直接或 closure中的坏引用。
- [x] Workflow direct/closure missing MCP阻止静态校验。
- [x] Workgroup member closure无效时在 host/task副作用前拒绝。
- [x] runtime删除竞态不以减少后的资源集执行。
- [x] project Skill、hidden ref、disabled MCP合同不回归。
- [x] 本 RFC 相关门禁全绿并记录准确结果。

## 交付记录

- `bun run typecheck`、`bun run lint`、`bun run format:check`、`bun run depcheck` 通过；
  `git diff --check` 通过。
- 完整 `bun run test` 退出码为 0：Backend 全量 0 fail、Shared `1438/1438`、Frontend
  `5279/5279`。
- RFC-228 定向覆盖 Agent 保存/闭包、Workflow/Workgroup 启动、schedule、runtime exact
  hydration、actor-safe status 与 ResourcePicker raw-id 不泄露。
- UI 证据为 ResourcePicker DOM 回归与 Frontend 全量测试；未把无法建立产品数据态的空白
  live server 页面冒充为本功能的真实交互验收。
- 实现提交 `bf1b3e1a` 已推送 `main`；远端 CI 按最终发布收尾 SHA 核验。

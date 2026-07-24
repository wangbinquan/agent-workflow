# RFC-227 OpenCode 版本无关与跨平台能力准入 — plan

状态：Done（2026-07-24；本地实现、门禁与实现门完成；用户随后授权提交/推送）。

## 任务

- [x] **RFC-227-T1 回归测试先红**：锁定本机/fixture `1.18.4` 被误报“未找到”、
      old/new/non-semver 被版本门拒绝、macOS 被 OS 名称拒绝、warn 被强制覆盖为
      enforce 四类现状。
- [x] **RFC-227-T2 executable snapshot 重构**：以 admin-selected
      `RuntimeBinaryIdentity` 取代 official build allowlist；保留 resolve/no-symlink/
      exclusive copy/re-hash/launch re-hash，reported version 降为 nullable telemetry。
- [x] **RFC-227-T3 行为 codec**：建立 `opencode-direct-v1` registry 与 non-model
      qualifier；移除 direct schemas/manifest/control 中的版本 literal，安全字段继续
      fail closed，明确允许的 additive 字段才兼容。
- [x] **RFC-227-T4 provenance migration**：使用下一个可用 migration rebuild
      `opencode_session_owners`，把 official/version 身份改为 binary digest +
      protocol codec + nullable reported version；补旧库 backfill 与约束测试。
- [x] **RFC-227-T5 containment provider core**：抽
      `RuntimeContainmentProvider`、capability/receipt、mode admission 真值表与开放
      shared schema；verified core/manifest/recovery 删除 platform/bwrap 必填字段。
- [x] **RFC-227-T6 Linux provider 迁移**：把 bwrap metadata/capability、FFF、
      outer/inner renderer、native supervisor、PGID/PID namespace recovery 移入
      Linux provider，保留全部 real mutation/orphan 证据。
- [x] **RFC-227-T7 macOS provider 交付**：Seatbelt outer appHome/seal policy +
      inner shell/local-MCP no-network profile + env seal + bounded process-group cleanup；
      gated real test 证明基线，receipt 如实标记 descendant lifetime best-effort。
- [x] **RFC-227-T8 warn/off 与 Windows seam**：所有 OpenCode 入口恢复 RFC-205
      mode 语义；注入 future Windows Job Object provider/executable adapter 的 contract
      test，添加 source guard 防 core 回写 POSIX/Linux 假设。
- [x] **RFC-227-T9 session/launcher/recovery 接线**：business/system/distill/smoke
      共用 digest+codec+provider admission；control marker、owner lease、store marker、
      resume 与 boot recovery 全链更新。
- [x] **RFC-227-T10 status/models/UI**：status 七态、protocol receipt cache fence、
      containment capabilities、首页/Settings/Runtime Test 精确文案与中英测试；
      只有 `not-found` 使用“未找到”。
- [x] **RFC-227-T11 当前文档清理**：更新 `CLAUDE.md`、`design/design.md`、
      `design/plan.md`、README、OpenCode/sandbox/troubleshooting 文档；给
      RFC-112/224/226 加 RFC-227 supersession 注记，历史证据不改写。
- [x] **RFC-227-T12 门禁与跨平台实证**：定向 mutation/source tests、macOS Seatbelt
      real integration、Linux provider/real-integration workflow、typecheck、lint、format、
      depcheck、backend/shared/frontend 全量与 compiled binary smoke。Linux real job
      由远端 workflow 承担，本次本地 macOS 会话未运行远端 CI。
- [x] **RFC-227-T13 实现门与交付**：Codex 实现门关闭全部 P0/P1/P2，更新 RFC/STATE；
      只在用户明确要求时提交/推送，并按 exact SHA 报告 CI。

## 依赖与拆分

- 依赖：RFC-112 runtime registry、RFC-143 RuntimeDriver、RFC-205/216 sandbox、
  RFC-224 execution identity、RFC-226 optional startup。
- 单 RFC、单 PR 原子交付；内部按 T2-T4（identity/codec/data）、T5-T8（provider）、
  T9-T11（全入口/UI/docs）、T12-T13（gates）分提交，任何中间 commit 不单独发布。
- 与并发 RFC-225 的生产代码预期无重叠；`STATE.md` / `design/plan.md` 只做追加式协调，
  不触碰现有前端任务页和 visual snapshot 改动。

## 设计门检查清单

- [x] 用户确认“不绑定版本”指行为兼容而非承诺任意版本必然可用。
- [x] 用户确认 binary 来源信任边界改为管理员选择的本机 TCB，SHA 只作冻结。
- [x] 用户确认 macOS 后代生命周期为 best-effort、与 Linux private PID namespace
      不等价，但不再按 OS 名称阻止执行。
- [x] 用户确认 Windows 本 RFC 交付可扩展接口/contract test，不宣称完成整个产品移植。
- [x] 无 hidden version gate、Linux gate、status catch-all 或 recovery pin 残留。

## 验收清单

- [x] OpenCode 版本字符串不参与任何 production admission。
- [x] 兼容 old/new/fork 由实际 direct API 行为决定。
- [x] binary snapshot/digest 与 same-instance identity 保持 fail closed。
- [x] Linux 与 macOS 都有真实 provider 执行路径。
- [x] Windows provider 可在不改 OpenCode core 的情况下注册。
- [x] `enforce/warn/off` 含义在所有入口一致。
- [x] “未找到”只对应 binary 真实缺失。
- [x] legacy session owner 无损 backfill，resume/recovery 不读版本 pin。
- [x] 本地全量门禁、macOS real integration、Linux integration 配置与实现门通过。

# RFC-272 · 实施计划

> 状态：Done（2026-08-10）；全部任务与完成定义已由最终本地门禁验证。

## 1. 依赖与边界

- 复用 RFC-224/227 verified launcher、direct client、control marker、owner identity 与 containment。
- 复用 Claude 路径现有 local-fail/remote-warn 极性，不发明第二套节点失败策略。
- 不恢复 RFC-251 双读 attestation，不新增网络权限，不自动推导 MCP 依赖路径。
- 新 session 走 v3；历史 owner 有明确 legacy resume 分支。

## 2. 任务分解

| 任务           | 内容                                                                                          | 验收                                    |
| -------------- | --------------------------------------------------------------------------------------------- | --------------------------------------- |
| **RFC-272-T1** | 三件套、索引、STATE；重验 OpenCode 支持版本的 `/mcp` 与 tool-list 行为                        | 引用可复跑；C1–C5 获用户确认            |
| **RFC-272-T2** | manifest readiness/frozen-skill 闭 schema；direct client status decoder；纯 comparator        | AC-1、AC-5、AC-6；解码无 error egress   |
| **RFC-272-T3** | launcher 同实例 readiness 顺序、canonical control frame、runner local-fail/remote-warn 与事件 | AC-2…4；local 模型调用数 0；remote 继续 |
| **RFC-272-T4** | skill block root/清单 renderer、精确 read allow、persona wiring                               | AC-9…11；辅助文件可读、seal 外仍拒绝    |
| **RFC-272-T5** | business identity v3 共用 helper、launcher 重算、legacy owner 双路径                          | AC-12、AC-13；resume 失败前零写         |
| **RFC-272-T6** | inventory readiness 同源、运行日志/Session UI 诊断、文档更新                                  | AC-7、AC-8；不再固定 configured；无秘密 |
| **RFC-272-T7** | 平台测试、macOS A/B 真探针、完整 gate、Codex 实现门与 findings 闭环                           | AC-14；零未登记红项                     |

## 3. 预计文件范围

- `packages/backend/src/services/runtime/opencode/{directClient,verifiedLauncher,verifiedManifest,verifiedPlan,verifiedInventory,executionIdentity,controlProtocol,sealedSubprocess}.ts`
- `packages/backend/src/services/runner.ts`
- `packages/backend/src/services/runtime/types.ts`
- `packages/shared/src/inventory.ts`（仅若 UI 需要收窄 status DTO；默认不改 schemaVersion）
- 对应 RFC-224/227/242 与新 RFC-272 backend 测试
- Session/任务诊断前端与中英 i18n（只呈现 readiness，不改 MCP 管理页）
- `docs/skill.md`、运行时/MCP 运维文档、RFC 三件套、索引、STATE

## 4. 实施顺序

1. 先落纯 schema/comparator/renderer 红测试。
2. 接 launcher readiness 与 runner frame，完成 local/remote 双向 oracle。
3. 接 skill 地址/permission，再做 identity v3 + legacy resume；identity 不得边试边补。
4. 最后改 inventory/UI/docs，跑真 containment 探针与完整门。

## 5. 完成定义

- proposal AC-1…14 全有自动化或明确真机证据；
- local MCP 的两个实测 fixture（零依赖/SDK 依赖）一绿一明确失败，绝无 done-without-tool；
- selected skill 的 sibling marker 能由真实 runtime 读到，源树/未选树不可读；
- 新旧 owner resume 兼容矩阵通过，任何 mismatch 在副作用前终止；
- `bun run gate:local`、实现门与安全/秘密扫描全绿；
- 未经用户另行授权不 commit/push。

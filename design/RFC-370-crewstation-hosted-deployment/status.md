# RFC-370 当前状态

> 唯一的进度记录。设计见 [v2 重设计](./redesign-v2-20261014.md)；本目录其余文档是 v1 历史。

| 步骤                                     | 状态                    | 证据             |
| ---------------------------------------- | ----------------------- | ---------------- |
| P1 单机统一                              | 已实现，待确切 SHA CI   | 见下方「P1」     |
| M0 控制面上线                            | 未开始                  | —                |
| M1 远程执行闭环                          | 未开始                  | —                |
| M2 能力等价                              | 未开始                  | —                |
| M3 事件与运维                            | 未开始                  | —                |
| CS 侧 RFC（业务 Agent 原生配置叠加材料） | 未立项                  | —                |

## P1 单机统一

范围按 v2 §3.2 与 §5（执行端口重塑移到 M1 开头）：

- 新增执行权端口 `system-operations/application/ports/executionAuthority.ts` 与单机实现（启动即 active、epoch 1、永不丢失），两个 daemon 根在 bootstrap 处传入；`GET /api/execution/status` 返回 `{ mode, state, reason }`；声明了 `executionGroup` 的路由在实例非 active 时返回 503 `execution-standby`，HTTP 与 MCP 绑定调用同一道门。前端 `useExecutionAvailability` 只在 `crewstation` 且非 active 时禁用执行入口，并显示待机 / 冻结横幅。
- 删除 v1 的 host 执行平行路径与“原执行恢复”机制（清单见 v2 §3.2「P1 实际删除范围」），恢复相关端点与前端按钮一并删除；SQLite `0257` / PostgreSQL `0033` 删除 `system_host_execution_write_contexts` 与 `memory_distill_execution_receipts` 两张表。
- 做法：按提交历史逐文件判定，只被 H7 提交改过的文件整文件回到 H7 之前的版本，与 RFC-371 v2 / RFC-372 等交织的文件逐段三方回退；只验证平行路径的测试删除，依赖 RFC-370 逆变换链的根源码 oracle 退役。

本地集中验证与提交 SHA、CI 结论在提交后补记。

## 环境

- 本机 CS：docker-desktop kind 集群，命名空间 `crewstation-system` 运行中；本机 GitLab `aw-local-gitlab`（127.0.0.1:8929）运行中（2026-10-14 只读核对）。
- 已知限制：本机 CS 的 Claude Code 停在登录态；OpenCode 有可用算力档位。

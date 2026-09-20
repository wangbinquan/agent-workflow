# RFC-364 实施计划

状态：In Progress（2026-09-20 已获实现与发布批准）；按下列依赖推进。

| 任务 | 交付物                                                                         | 依赖                                        |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| T1   | 七 route、service methods、RM/config/root consumers、限额/错误及 exact debt 账 | RFC-360 已完成；冻结当前 oracle             |
| T2   | domain/application、窄 public commands/queries、effects ports                  | T1；复用现 persistence/lease，不新增 schema |
| T3   | process/stream/workspace adapters 与恢复/配置失效接线                          | T2；真实双库与 process oracle               |
| T4   | 三 root 唯一实例、cold disposal/provider fence、RM/config 窄 participant       | T3；与 RFC-363 根变更串行                   |
| T5   | 七 HTTP bindings 切到 RC use cases，删除 route 内编排                          | T2–T4；原 wire、coordinator 同实例          |
| T6   | 删除旧 service/lease 转发和 WeakMap，canonical 出账、最终 AC                   | T5；provider=1、真实 consumer、Main CI      |

T2/T3 在 RC 模块内可与 RFC-363 开发独立推进；T4/T5 root 及共用索引/canonical 变更只在短发布段串行，不设置永久集成 owner。共享 main 上只提交本项 allowlist，保留所有其他 WIP，不建分支/worktree。

建议分批：T1/T2 内部 application + oracle；T3/T4 effects/roots；T5/T6 transport/删除收口。中间兼容转发必须标精确 owner/removeWave，并在 T6 为零；不能把转发文件当最终架构交付。

## 完成检查

- [ ] AC-1～7 逐项 evidence，七 HTTP 操作行为不变。
- [ ] session/turn 单写、真实双库并发、capture 和 cleanup 完整。
- [ ] RM profile participant 同事务；RM/config 无 legacy MCP service 依赖。
- [ ] 三 root 共享一实例；未启动 dispose、provider pause/resume、shutdown 顺序均通过。
- [ ] 本域旧 imports/facades/WeakMap 为零，reconcile timer 明确留 W9。
- [ ] 最终 SHA Main CI success，原生进程测试按触及范围取证。
- [ ] 只关闭 E6 与该域 B/D，RFC-294 其余波次保持开放。

## AC 证据与范围转交

逐项映射见 [acceptance.md](./acceptance.md)。最终 Main CI 未终态前保留 In Progress；历史各批局部成功不能替代当前源码验收。

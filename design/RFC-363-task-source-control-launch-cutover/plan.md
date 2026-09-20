# RFC-363 实施计划

状态：In Progress（2026-09-20 已获实现与发布批准）；按下列依赖推进，尚无完成信用。

| 任务 | 交付物                                                                                   | 依赖 / 判据                                              |
| ---- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| T1   | 当前入口/54 字段/两 lane/读接口/回滚 oracle 和 exact debt allowlist                      | 源码基线复核；不得弱化原断言                             |
| T2   | source、snapshot、operation、Task preparation journal 的 expand schema 与双库 repository | T1；新格式 reader 先于 writer；无 migration 号抢占       |
| T3   | live tx factory、sealed source 与 group/revision 完整 provider                           | T2；同事务失败、group 改动、重启测试                     |
| T4   | SC materializer/effect receipt；接入 repository preparation/retry/cancel                 | T3；真实 Git；原 Task ownership；同步入口时序不变        |
| T5   | multipart/call/fusion 等 pre-materialized adapters 与补偿                                | T3/T4；prepare/applyUploads 在建 Task 前                 |
| T6   | TaskWorkspaceReadPort 与 SC reader；HTTP 原 wire 投影                                    | T3；分页/字节/回收与旧测试                               |
| T7   | production roots、逐入口切换、移除本域旧 consumer/facade                                 | T4–T6；默认无 optional fallback，实例/字段 liveness 对拍 |
| T8   | 完整 AC、canonical 精确出账、剩余 E1/W5 转交、最终托管 CI                                | T7；不以合同存在代替上线                                 |

建议小批提交：T1/T2 兼容读与 schema；T3/T4 单入口纵切；T5/T6 其余 lane/reader；T7/T8 收口。每批 publish 后跟踪 exact SHA。仅在既有 primary main 上工作，不建分支/worktree/替代 index；短发布段 exact-stage、检查共享 index 与路径，不修改其他会话 WIP。

T6 可在 T3 合同固定后独立开发。RFC-364 模块内工作无直接依赖，但 `server.ts`、`cli/start.ts`、`cli/postgresqlDaemonApplication.ts` 与索引/canonical 的写入和发布须短暂串行。RFC-365 Task provider 在本 RFC launch seam 稳定后接线；不与 T4/T5 同时重写 launch kernel。schema/migration 也串行分配。

## 完成检查

- [ ] proposal AC-1～8 逐项有实现和 evidence，不仅代码存在。
- [ ] repository/group/上传 journal 的 crash/replay 真双库；Git/FS 无 transaction 内运行。
- [ ] 旧任务可恢复；新格式回滚下限和 cleanup 已验证。
- [ ] `node_runs` INSERT 仍唯一；runtime per-NodeRun freeze 未改变。
- [ ] 所有 claimed public/required seam 有真实调用，owned 旧 consumer 为零；残债带 owner/removeWave。
- [ ] 最终 Main CI terminal success；若触及原生 Windows 行为，相关托管任务有同源码证据。
- [ ] 文档、STATE、索引只按验收范围标记；RFC-294 整体、完整 W5 不记 Done。

本 Draft 批次仅文档，不运行本地 Bun 测试或服务。实施时新增测试随实现提交，由 GitHub Actions 取证。

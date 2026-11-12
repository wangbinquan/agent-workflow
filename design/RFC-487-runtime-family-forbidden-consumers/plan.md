# RFC-487 实施计划

**前置**：RFC-486（Done，`b69dfabe8`，修复 `6452036ac`，Done 文档 `f74014135`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。
全部实现与用例完成后集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                      | 依据      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-487-T1 | memory：删除蒸馏运行时解析器；装配改收 `runtimeProfiles` 端口，bootstrap 用 runtime-management 的 `resolveInternalAgentRuntime` 绑定；用例与 helper 改用同一绑定；表归属债销这一条                        | design §2 |
| RFC-487-T2 | system-operations：端口增 `DoctorRuntimeBinaryProbe`，本机 doctor 改调注入的探测；runtime-management 增默认二进制探测（infrastructure + composition）；bootstrap 的 doctor 工厂与 standalone 软探测改用它 | design §2 |
| RFC-487-T3 | source-control：`resolveBoundaryMounts` 迁入 domain、经 `public/queries` 交出；本机工作区内容与 task-execution 的本机运行入口改取；一族删去原函数                                                         | design §2 |
| RFC-487-T4 | resource-catalog：`SkillSource`、`ResolvedSkill`、`RuntimePlugin` 迁入 domain、经 `public/types` 交出；一族原位置改为类型转出；材料引用改取自己的类型                                                     | design §2 |
| RFC-487-T5 | 新增 RFC-487 用例并登记 guard-manifest；既有用例与账本按新位置改指；`counts.json` 收紧                                                                                                                    | design §4 |
| RFC-487-T6 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、架构报告对账、全仓旧路径扫描）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾                       | design §5 |

## 验收清单

- [ ] AC-1 memory、resource-catalog、source-control、system-operations 的生产文件不 import 运行时驱动一族；memory 不读 `runtimes`，
      解析器删除，表归属债销这一条
- [ ] AC-2 memory 蒸馏的运行时解析、doctor 探测、挂载列表与原生内容记录在同样输入下与此前一致
- [ ] AC-3 越 DAG 的值边与 offered 文件对不升；public surface 只增本 RFC 声明的 4 个符号；减速带不升、触及的收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

（实施后补。）

## 实现门（本会话自审，只审功能）

（实施后补。）

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同时补 RFC-486 Done 文档提交的 CI）；实现与验证后再提交
`refactor(backend): RFC-487 运行时驱动一族的 DAG 外使用方改经各自的端口（RFC-294 §4.7 运行时驱动一族第一步）`。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。删除或搬迁文件后按 `git ls-files` 扫全仓的旧路径（RFC-486 教训）。

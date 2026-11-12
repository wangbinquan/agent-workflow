# RFC-489 实施计划

**前置**：RFC-488（Done，`9ff1274b0`，Done 文档 `ca08a9365`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。
全部实现与用例完成后集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                                                                                          | 依据              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| RFC-489-T1 | runtime-management：composition 增本机与托管的运行时管理装配（迁自 task-execution 的两个根，探测族经效果自有的探测端口注入）；材料定义以 `evidence(scope)`、`materialReference(plan)` 取代 `evidenceHooks`                                                                    | design D1、D4     |
| RFC-489-T2 | task-execution：本机探测族改用材料定义的协议与运行证据，删 `NativeProtocolBinding`；本机调用改收 `evidence` 与 `materialReference`；只供契约用例的本机任务运行收材料定义                                                                                                      | design D2、D4     |
| RFC-489-T3 | task-execution：系统代理（本机、托管）、任务代理（本机）与探测（本机、托管）的根改为「输入 + 提供者」，不再 import 其他模块的 composition 与 infrastructure；`composeLocalTaskRunSelection` 收任务代理族的提供者；`crewstationExecution` 不再产出运行时管理与系统代理族的选择 | design D1、D3     |
| RFC-489-T4 | bootstrap：运行族的提供者绑定（一个文件）；standalone 与 CrewStation 的选择改取它；部署档案的选择签名在 bootstrap 声明；一族的两个运行器改用一族自己的包装                                                                                                                    | design D1、D3、D4 |
| RFC-489-T5 | 新增 RFC-489 用例并登记 guard-manifest；三份精确账本销去 21 对、`counts.json` 收紧；既有用例按新装配改指                                                                                                                                                                      | design §3、§4     |
| RFC-489-T6 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、按 CI 跑法的批次、架构报告对账、全仓旧路径扫描）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾                                                                         | design §5         |

## 验收清单

- [ ] AC-1 task-execution 的生产文件对 runtime-management 只取 `public/`；21 个跨 context 内部文件对销账；运行族的提供者与运行时管理的
      装配由 bootstrap 绑定
- [ ] AC-2 同样输入下行为一致（运行时管理装配与探测回执钩子、探测族的协议与运行证据、各运行族的提供者、本机调用的材料引用与运行证据、
      夹具）
- [ ] AC-3 跨 context 内部文件对 43 → 22；越 DAG 的值边与 offered 文件对不升；public surface 不增；减速带不升、触及的收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

（实施后补。）

## 实现门（本会话自审，只审功能）

（实施后补。）

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-489 task-execution 的运行族不再取 runtime-management 内部（RFC-294 §4.7 运行时驱动一族第三步）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。按 CI 的跑法（两种 provider 同进程、默认 5 秒）跑一遍受影响
用例；删除或搬迁文件后按 `git ls-files` 扫全仓的旧路径（含 workflow 的 `paths:` 过滤与账本锚点）。

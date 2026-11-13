# RFC-491 实施计划

**前置**：RFC-489（Done，`3c9da0a0c`，Done 文档 `87cd1228f`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。
全部实现与用例完成后集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                                    | 依据              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| RFC-491-T1 | runtime-management：`public/queries` 交出三个静态事实查询；启动清单读取与插件加载失败识别迁入 `infrastructure/local/` 并经 composition 交出；交出本机驱动的选择；材料定义的材料引用增来源计划；探测夹具缝改用自己的类型 | design D2、D4～D6 |
| RFC-491-T2 | shared：声明清单的四个纯构造迁入 `declaredInjection.ts`；一族、runtime-management、task-execution 与用例的导入改指 shared                                                                                               | design D3         |
| RFC-491-T3 | task-execution：类型改取 owner 的出处，本机计划改用自有类型；节点运行持久化、续会话判据、诊断读端与托管准备改取 public 查询；本机任务代理族收插件加载失败识别；启动清单读取的 composition 转出删除                      | design D1、D2、D4 |
| RFC-491-T4 | task-execution：`services/systemAgentRun.ts` 迁为 `infrastructure/local/nativeSystemAgentRun.ts`，驱动、材料工作区与材料定义作为提供者交入；MCP 诊断的本机执行体收同一组提供者                                          | design D5         |
| RFC-491-T5 | bootstrap：本机系统代理运行的提供者与 MCP 诊断的选择、插件加载失败识别与启动清单读取的绑定；`services/runtimeSmoke.ts` 与两个只供契约用例的本机任务运行文件迁入 `tests/helpers/`                                        | design D4～D6     |
| RFC-491-T6 | 新增 RFC-491 用例并登记 guard-manifest；三份精确账本、`commons-debt.json`、不可达清单、`counts.json`、design §3.1 与 `rfc294Target.ts`、`architectureReport.ts` 的目标表、两份 workflow 路径过滤随之更新；既有用例改指  | design §3、§4     |
| RFC-491-T7 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、按 CI 跑法的批次、架构报告对账、全仓旧路径扫描）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾                   | design §5         |

## 验收清单

- [ ] AC-1 task-execution 的生产文件不 import 一族；一族不 import task-execution；两个一族运行器与两个本机任务运行文件不在生产树里
- [ ] AC-2 同样输入下行为一致（三个静态事实、声明清单的构造、启动清单读取、插件加载失败识别、本机系统代理运行与 MCP 诊断的本机执行体、
      探测夹具缝）
- [ ] AC-3 跨 context 内部文件对 22 → 21；R1 18 → 9；不可达生产文件 18 → 16；越 DAG 的值边与 offered 文件对不升；public 类型污染不升；
      减速带不升、触及的收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-491 task-execution 与运行时驱动一族互不 import（RFC-294 §4.7 运行时驱动一族第四步）`。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。按 CI 的跑法（两种 provider 同进程、默认 5 秒）跑一遍受影响用例；
删除或搬迁文件后按 `git ls-files` 扫全仓旧路径（含 workflow 的 `paths:` 过滤与账本锚点）。

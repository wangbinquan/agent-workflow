# RFC-492 实施计划

依赖：RFC-491（Done，`18189b794`）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态
自查。

## 任务

- **RFC-492-T1 搬迁**：`services/runtime/**` → `modules/runtime-management/infrastructure/drivers/**`（结构不变）；
  `services/execution/{agentInjection,workspaceBoundary}.ts` → `drivers/`；插件入口改取 `@/embed.generated`；一族取本模块的 import 改为
  模块内相对路径、取声明处（design D1、D2）。
- **RFC-492-T2 public 撤下 14 个只供一族的出口**（design D2）。
- **RFC-492-T3 runtime-management 的 16 个使用方改取模块内路径**。
- **RFC-492-T4 bootstrap**：`composition/runtimeDrivers.ts`；`daemonApplication.ts` 的启动自检；资源策略束迁为
  `bootstrap/taskExecutionResourceDependencies.ts`，`daemonModules/taskExecution.ts` 改取（design D3）。
- **RFC-492-T5 驱动租约夹具**迁入 `tests/helpers/`，RFC-108 的四个用例改取（design D4）。
- **RFC-492-T6 守卫与配置**：eslint 围栏、`scripts/build-binary.ts` 的插件目录、三份 workflow 的路径过滤、`commons-debt.json`、
  `commons-manifest.json`、`counts.json`、`guard-manifest.json`；两份现行契约文档与描述现行位置的源码注释（design D5）。
- **RFC-492-T7 用例**：91 个测试文件的 import 说明符；43 个带路径字面量的逐条改指（发布账本夹具不改）；RFC-213 启动根逆变换；新增
  RFC-492 用例（design §4）。
- **RFC-492-T8 集中验证**：backend 与 shared `tsc`、eslint；RFC-492 与受影响用例；全量 SQLite 与 PostgreSQL lane（与 HEAD 同时 A/B）；
  按 CI 的跑法跑相关文件；架构报告对照；单二进制构建核对嵌入表；全仓旧路径扫描。
- **RFC-492-T9 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 `services/runtime/`、`services/execution/` 不再有文件，`services/driverLease.ts` 不在生产树；一族在 runtime-management 的
      `infrastructure/drivers/`；生产代码只有 runtime-management 自己 import 它，bootstrap 经 composition
- [ ] AC-2 同样输入下行为一致（插件嵌入、启动自检、资源策略束、按运行时围栏、workflow 触发）
- [ ] AC-3 legacy 服务实现 46 → 6；legacy 横向文件 165 → 125；不可达生产文件 16 → 15；inbound 边 9 → 0；跨 context 内部文件对、越 DAG 的
      值边与 offered 文件对不升；public surface 不增；减速带不升、触及的收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-492 运行时驱动一族整族迁入 runtime-management infrastructure（RFC-294 §4.7 运行时驱动一族第五步）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。删除或搬迁文件后按 `git ls-files` 扫全仓旧路径（含
workflow 的 `paths:` 过滤、构建脚本与账本锚点）。

# RFC-454 `services/` 一跳转出清仓（RFC-294 W9-D 第一步）

- **状态**：In Progress（2026-11-05）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（facade 清仓）
- **前序**：[RFC-453](../RFC-453-workspace-insight-module/proposal.md)（W4 B / D 退出门达成：入站适配器不再取 `services/`）。
- **落位**：各转出的声明处（collaboration / task-execution / system-operations / resource-catalog 的模块内部）；task-execution 与
  resource-catalog 的 `domain`、resource-catalog 的 `public/queries` / `public/types`；`platform/execution/local`；shared 的
  `schemas/workgroup`、`workflow-yaml`、`resourceReferences`。

## 1. 背景

RFC-453 之后 `routes/`、`mcp/`、`ws/` 都不再 import `services/`，`services/` 还剩 153 个文件，其中 36 个是一跳转出（文件里只有
`export … from`，架构计数 `legacy-thin-facades`）。它们是早先迁移留下的兼容地址：实现早已在模块或平台里，消费方却仍经 `services/`
取。转出本身有两层代价：

- **藏边**：边界普查把「转出 → 模块内部」记成一条 legacy 债（`R1`），看不见真正的消费方。实测 6 个转出背后是目标 DAG 不给的依赖
  ——task-execution 取 collaboration 的澄清判定、event-center 取 task-execution 的脚本解释器、collaboration 取 resource-catalog 的
  workgroup 常量、resource-catalog 取 task-execution 的调用闭包编解码、platform 取 resource-catalog 的 YAML 序列化、intent / memory
  取 runtime-management 的会话事件类型；还有 1 个把 application 对本模块 infrastructure 的取用藏了起来（task-execution 的
  子任务启动端口经 `services/execution/closure` 取 infrastructure 里的冻结 workgroup 类型）。
- **多一跳**：模块经 `services/` 回取自己的内部（collaboration 6 个、system-operations 1 个、resource-catalog 1 个、task-execution 1 个），
  生产与 300 多处用例都经这一跳。

## 2. 目标

- **G1 删除 30 个转出**：消费方（生产与用例）改取声明处；跨模块的取用只经 owner 的 public 合同或下沉后的纯函数，不新增
  目标 DAG 之外的边、不新增 public surface 偏差、不新增 application → infrastructure 的取用。
- **G2 藏边归位**：被转出藏起来的纯函数 / 常量 / 类型按归属下沉——澄清判定与澄清节点查找进 task-execution `domain`（只有它用），
  调用闭包编解码与启动输入校验进 resource-catalog `domain`（经 public 给 task-execution），脚本解释器解析进 `platform/execution/local`
  （task-execution 与 event-center 共用的宿主机制），workgroup 宿主节点 id 改用 shared 已有的常量（补上澄清节点 id），workgroup
  澄清提问者键进 collaboration `domain`（只有它用），工作流 YAML 序列化与工作流的代理引用提取进 shared（shared 函数的薄包装）。
- **G3 行为不变**：只换位置与 import；函数体原样。两处例外都对一切输入同解：`computeRemaining` 迁入 task-execution 后改经
  RFC-339 的包装成员读者 `directNodeIdsOf` 取循环成员；`FrozenWorkgroupRef.group` 进 public 后由 `unknown` 收为生产冻结写入的
  闭合类型（design §2.1 / §2.2）。
- **G4 余下 6 个转出写明去处**：`sessionEventSink`（随运行时驱动 / 系统代理运行归位）、`workflow` / `workgroups`（需要
  resource-catalog 的执行期查询端口）、`workflow.validator`（只剩 legacy 消费方，随 E1 的 `task.ts` 退役）、`skillBootVerify` /
  `skillIdentityPaths`（需要 resource-catalog 给 task-execution 的技能注入端口）。

## 3. 非目标

- 上面 6 个转出（各自另立 RFC）；`services/` 里的实现文件；安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：30 个转出文件不存在，`src/` 与用例零引用；余下 6 个转出的消费方不增加。
- **AC-2**：架构计数按实测：`legacy-thin-facades` 36 → 6、`services/` 153 → 123；`R1` / `R2` 按实测下降（账本逐条相等）；
  off-DAG 值边 0、值环 0、平台 → 模块 0、跨 context 内部文件对与 public surface 偏差不升、`module-layer-violations` 不升。
- **AC-3**：迁移所涉功能的既有用例全部通过（澄清 / 提问派发 / 复审、脚本节点与自定义观察者、调用闭包与子任务启动、备份恢复、
  插件安装、工作流导出 YAML、意图转储）；新增 RFC-454 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **藏边下沉到「唯一使用者」或更低层，而不是加 DAG 边**：目标 DAG 是 RFC-294 的核心约束；这 6 处背后都是纯函数或常量，按真实使用者
   落位即可消掉反向依赖，不需要新增 offered / required 边。
2. **不为转出新增带数据库句柄的 public 导出**：`getWorkflow(db, …)` 一类函数直接从 public 导出会成为新的 public surface 偏差，
   这几个留到 resource-catalog 的执行期查询端口里一起设计（G4）。
3. **词表用 shared 已有的单一事实源**：workgroup 宿主节点 id 是落库的线上词表，shared 早有 `WORKGROUP_TURN_LEADER_NODE_ID` /
   `WORKGROUP_TURN_MEMBER_NODE_ID`，resource-catalog legacy 目录里那份是重复；task-execution 与 collaboration 还有三处本地副本。
   本 RFC 一律改取 shared（补 `WORKGROUP_TURN_CLARIFY_NODE_ID`），零使用的 `WG_RERUN_CAUSE` 随文件删除。
4. **因转出删除而变为生产不可达的 3 个文件登记为保留**：task-execution 的 `legacyCallClosure`（RFC-349 冻结遍历的行为 oracle）、
   它读的 `services/workgroups`、resource-catalog 的 `legacy/workflow.yaml`（用例在用的 YAML 预览与选择器投影）。它们只是此前被转出的
   再导出链算作可达；搬进用例目录或删除都要改写既有的历史用例，不属本 RFC。与已在 RFC-376 不可达清单里的注入 oracle 同样登记保留，
   继任 RFC-294 W9-D 的 resource-catalog 执行期查询端口（design §4 末）。

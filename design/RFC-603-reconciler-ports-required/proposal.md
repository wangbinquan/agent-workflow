# RFC-603 development-automation 的 reconciler 端口必填（RFC-294 W4-E8：application 一侧按用例的必填端口）

- **状态**：Done（2026-11-26，落地 `0f2ded0db`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  本会话自行裁定落位与 RFC-359 P0 `p0-9-launchers` 的去留（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §3 的 development-automation 一行（可选袋拆为按用例、非可选的
  required 端口）；接 [RFC-597](../RFC-597-development-automation-required-providers/proposal.md)（装配边界）与
  [RFC-601](../RFC-601-employee-compositions-required-providers/proposal.md)。

## 1. 背景

`ReconcilerPorts` 的 25 个成员都是可选的。RFC-597 / 598 之后，唯一的生产装配 `composeDevelopmentAutomation` 在编译期就必须拿到全部 provider，并把
25 个成员全部构造出来。可选性只剩一个用处：用例可以只给一部分端口。application 里因此留着三类“端口没给”的分支，生产上都走不到：

1. **typed block**：`*-not-wired`（两个启动器、动作工作区、基线、模板、工作区校验、候选、冲突合并、需求物化、上传放置、子任务、审批网关、两个事实
   采集）与 `*-port-missing:*`（交付、流水线、MR 照看）。
2. **命令的失败结果**：交接的 `attach` 与 cutover 接管在没有 MR 效果时报 `mr-observe-unavailable`，reopen 在没有 MR 事实采集时得到
   `collector-not-wired:mr`。
3. **静默跳过**：
   - 没有 playbook 台账时，不算 saga 摘要，整段 playbook 编排不运行，步骤失败详情为空。
   - 没有上传计划读取时，按“无计划”处理。
   - 没有需求物化时，用 mission id 当标题，也不搬运需求证据。
   - 没有上传发布回执端口时，不记回执。
   - 答案换代或交接时，没有 Agent 启动器就不取消在途执行。

第三类最隐蔽。用例只给部分端口时，mission 走的是生产上不存在的路径：例如带 playbook 的员工在用例里根本不进 playbook 编排。这类用例通过，并不说明生产
路径正确。

## 2. 目标

- **G1**：`ReconcilerPorts` 的 25 个成员都必填，漏给就是编译错误（生产装配本来就给全）。
- **G2**：按用例的端口。命令与发布链只声明自己读的端口（`Pick<ReconcilerPorts, …>`，必填）：
  - 答案提交与在途动作失效：只要 Agent 启动器。
  - 交接：Agent 启动器与 MR 效果。
  - reopen：MR 事实采集与需求物化。
  - cutover 接管：MR 效果。
  - 四条发布链（交付、流水线证据、MR 照看、冲突修复）：共用它们读的 12 个。
  - reconcile 本身（含动作编排与 playbook 编排）：读全部 25 个。
- **G3**：删去上述三类分支；生产行为不变。
- **G4**：RFC-359 P0 的 `p0-9-launchers` 退役（理由见 design §0）；P0-9 的另一半 `p0-9-terminal-observer` 保留。
- **G5**：用例给全端口。新的测试 helper 按装配的做法给出 5 个数据库支撑的端口：playbook 台账、上传计划读取、上传发布回执、动作模板内容与校验配置
  内容。其余给调用即抛错的替身。断言“端口没给”的用例删去，由 RFC-603 用例在编译期与源码上锁住。
- **G6**：架构计数都不升。

## 3. 非目标

- launch / admission 的可选依赖（`uploadAdmission`、`resolveBaseline`）与需求物化器的 `source`。它们不在 `ReconcilerPorts` 里，另立。
- 名字相近、但不是端口缺席的运行期结果，照旧：
  - `mr-care-not-wired`：policy 的 wait 原因。
  - `arm-not-wired:<kind>`：未知 arm。
  - `baseline-reader-not-wired`：git 基线读取在缓存仓库缺失时给出。
  - `mr-observe-unavailable`：真实 observe 失败时给出。
- 任何用户可见行为。

## 4. 能力影响清单

无。生产装配一直给全 25 个端口，删去的分支只在用例里走得到。RFC-597 之前漏接 provider 的部署留下的 blocked mission，仍按原 block code 显示与处理
（block code 是自由字符串，没有枚举）。

## 5. 用户可见变化

端口必填本身没有用户可见变化。集中验证查出一处既有缺陷，一并修复（design §2.1）：

- 缺陷：带流水线 provider 的员工发起的 mission，流水线采集、触发与重跑一律被 `pipeline-adapter-unbound` 挡下。
- 原因：员工内容按 schema 把适配器存成版本化引用，发布链却只认字符串。
- 修复后：这三个 arm 照常经适配器执行。

## 6. 验收标准

- **AC-1**：`ReconcilerPorts` 没有 `?` 成员；各命令与发布链的 deps 只声明自己读的端口，且必填；生产装配不变。
- **AC-2**：application 里不再判断 `ReconcilerPorts` 成员是否为 `undefined`，也不对它们用 `?.` 或 `!`；上述 block code 与失败结果不再因端口缺席产生。
- **AC-3**：P0 `p0-9-launchers` 退役（阶段表、预载与判定用例同步），`p0-9-terminal-observer` 保留。
- **AC-4**：用例给全端口，行为与生产一致；架构计数都不升；新增 RFC-603 用例并登记。
- **AC-5**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
- **AC-6**：流水线发布链按员工内容的版本化引用得出适配器绑定（`id@revision`）；用例以 schema 合法的员工内容走通采集、触发与重跑。

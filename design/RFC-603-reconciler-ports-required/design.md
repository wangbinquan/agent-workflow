# RFC-603 技术设计

记号：`S/` = `packages/backend/src/`，`DA/` = `S/modules/development-automation/`，`T/` = `packages/backend/tests/`。数字取 HEAD `bed0c7f0d`。
生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **bounded context / 层**：development-automation 的 application：端口合同 `DA/application/ports/reconcilerPorts.ts`，以及读这些端口的 use case
  （reconcile、动作编排、playbook 编排、四条发布链、五个命令）。装配 `DA/composition.ts` 只改注释：它本来就构造全部 25 个成员。
- **按用例的端口用 `Pick`**：25 个端口接口已经各自独立，用例的边界是“读哪几个成员”。每个命令与发布链的 deps 写成必填 `ReconcilerPorts` 的 `Pick`，
  每个端口仍只有一份定义，编译器逐个用例核对。cutover 接管早已这样写（`Pick<ReconcilerPorts, 'mrEffects'>`）。RFC-294 所说的 exact provider adapter
  即 RFC-597 收好的装配边界。reconcile 本身经各条子链读到全部 25 个，它的 deps 就是整份 `ReconcilerPorts`。
- **RFC-359 P0 `p0-9-launchers` 退役**：
  - 这个阶段复现 `01e4b1b7b` 修复的事故：PostgreSQL daemon 装配时漏给了两个启动器。它证明今天的用例认得出这次回归，判据是
    `*-launcher-not-wired` 的 block。
  - RFC-597 起装配入参要求两个启动器；本 RFC 起 `ReconcilerPorts` 也要求。这样的部署通不过类型检查，而 CI 的 typecheck 就是门。
  - 要在运行期复现，只能靠预载里的一次类型断言，生产调用方做不到。本 RFC 删去 `*-launcher-not-wired` 分支后，这样伪造的运行会在编排调用缺席的启动器时
    抛 `TypeError`。P0 判定恰恰把 `TypeError: Cannot read properties of undefined` 当作“与回归无关的异常”拒绝
    （`T/rfc359-w14-p0-mutation-verdict.test.ts` 对 `p0-9-launchers` 的同名用例）。
  - 改按这个 `TypeError` 重定基线，钉住的是 JS 引擎的报错文案，不是回归；为了这个阶段保留分支，又与 G1 矛盾。
  - 所以这个阶段退役，防线换成编译器：RFC-597 与 RFC-603 用例里的编译期必填断言，以及 daemon 装配本身的类型检查。
  - P0-9 的另一半 `p0-9-terminal-observer` 复现的是“漏了一次调用”，仍然表达得出来，保留。
- **偏离项**：无。

## 1. 改动

### 1.1 端口合同

`ReconcilerPorts` 的 25 个成员去掉 `?`；文件头注释改写：“没接上必须可见”由编译期保证，不再靠运行期 block。

### 1.2 按用例的 deps

| deps                                                                     | 端口                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReconcileDeps`（reconcile、动作编排、playbook 编排、`confirmNoChange`） | 全部 25 个（类型不变，成员变必填）                                                                                                                                                                                                          |
| `DeliveryChainDeps`（交付、流水线证据、MR 照看、冲突修复）               | `attemptContext`、`uploadPlanReader`、`candidateDelivery`、`verificationProfiles`、`verificationExecution`、`requirementMaterialize`、`repoRemote`、`uploadPublication`、`mrEffects`、`pipelineEvidence`、`pipelineImport`、`conflictMerge` |
| `loadPipelineManifest`                                                   | `attemptContext`                                                                                                                                                                                                                            |
| `InvalidateActionDeps`、`SubmitAnswersDeps`                              | `agentLauncher`（必填，原为可选的整份）                                                                                                                                                                                                     |
| `MissionHandoverDeps`                                                    | `agentLauncher`、`mrEffects`（必填，原为可选的整份）                                                                                                                                                                                        |
| `ReopenDeps`                                                             | `mergeRequestFacts`、`requirementMaterialize`                                                                                                                                                                                               |
| `adoptActiveMr`                                                          | `mrEffects`（原已是 `Pick`，成员变必填）                                                                                                                                                                                                    |

### 1.3 删去的分支

- **reconcile**（`missionReconciler.ts`）：
  - block 分支：`collector-not-wired:repository`、`collector-not-wired:merge-request`、`placement-not-wired`、3 处 `requirement-port-not-wired`、
    `child-mission-port-not-wired`、2 处 `approval-gateway-not-wired`。
  - 静默分支：saga 摘要的有无判断、步骤失败详情在没有台账时取空、流水线清单在没有 attempt context 时取空、no-change gate 的上传计划 `?.`。
- **动作编排**（`agentActionOrchestrator.ts`）：
  - 删去 `requiredPortsMissing` 与它的 6 个 code（`action-baseline` / `action-workspace` / `attempt-context` / `action-templates` /
    `workspace-validation` / `change-candidate-not-wired`）。
  - 删去 `agent-launcher-not-wired`、`script-launcher-not-wired`、`conflict-merge-not-wired`、`conflict-merge-discard-not-wired`。
  - 去掉 playbook 台账的有无判断，以及端口上全部的 `?.` 与 `!`。
- **playbook 编排**（`playbookStepCoordinator.ts`）：
  - 去掉台账、子任务、审批网关的有无判断：没有台账时整段编排返回 `null`，子任务与审批的处理在端口缺席时返回 `'blocked'`。
  - 去掉台账上的 `!` 与模板内容的 `?.`。
- **发布链**：
  - 交付：`delivery-port-missing:attemptContext` / `verification` / `candidateDelivery` / `repoRemote` / `mrEffects`，需求标题的 `?.`，上传发布
    回执的有无判断。
  - 流水线：`pipeline-port-missing:evidence` ×3、`pipeline-port-missing:mrEffects`。
  - MR 照看：`mr-care-port-missing:mrEffects`。
  - 冲突修复：`conflict-merge-not-wired`、`conflict-delivery-not-wired`。
- **命令**：
  - 交接：`attach` 在没有端口时的 `mr-observe-unavailable`，`handoff` 转交端口时的有无判断。
  - reopen：`collector-not-wired:mr` 与需求证据搬运的 `?.`。
  - cutover 接管：`mr-observe-unavailable`（端口缺席那一条）。
  - 在途动作失效：启动器的有无判断与 `!`。
  - `confirmNoChange`：上传计划的 `?.`。

真实 observe 失败时的 `mr-observe-unavailable`、`mr-care-not-wired`（wait 原因）、`arm-not-wired:<kind>` 都不是端口缺席，原样保留（proposal §3）。

### 1.4 装配

`DA/composition.ts` 的 `ports: ReconcilerPorts` 本来就是全量对象，不改；`DevelopmentAutomationProviders` 注释里“`ReconcilerPorts` itself stays
optional until it is split by use case”改为指向本 RFC。

## 2. 用例

- **`T/helpers/developmentAutomation.ts`** 新增 `reconcilerPortsFor(db, overrides)`，给全 25 个成员：
  - 按装配的做法给 5 个数据库支撑的端口：playbook 台账 `createPlaybookSagaPersistence(db)`、上传计划读取 `readUploadPlan`、上传发布回执
    `recordUploadPublicationReceipt`，以及动作模板与校验配置的内容读取。
  - 其余 20 个给调用即抛出 `<member>.<method> is not used by this test` 的替身。
  - `overrides` 覆盖任一成员。
- **夹具**：`rfc310Pr2Fixture` 与 `rfc310Pr3Fixture` 的 `deps(…)` 收部分端口，经这个 helper 补全；`fakeAgentActionPorts` 的返回类型写成它给出的那些成员
  （`Pick`），不再是 `Partial<ReconcilerPorts>`。
- **直接构造端口的用例**：改成经 helper 或夹具补全。断言“端口没给”的用例删去，它们断言的状态已无法表达。
  - `rfc310-pr2-reconciler`：只摘掉 Agent 启动器。
  - `rfc310-pr3-requirement-materialize`：需求物化端口缺席，以及 repository 采集缺席时停在 `collector-not-wired:repository`。
  - `rfc310-pr4-orchestrator`：工作区校验缺席。
  - `rfc310-pr5-delivery-chain`：MR 事实采集缺席与 `candidateDelivery` 缺席。
  - `rfc310-pr7b-handover`：MR 效果缺席时 `attach` 报 409。
  - 同一用例里其余断言不动。
- **行为对照**：
  - 生产上台账、上传计划读取与需求物化一直在场，用例改为与生产一致。
  - 此前没给台账的用例从此会计算 saga 摘要，带 playbook 的员工会进入 playbook 编排；没有 playbook 的员工，编排对它返回 `null`，与此前相同。
  - 集中验证时逐个对照这些用例的断言。

### 2.1 集中验证查出的静默依赖与一处既有缺陷

调用即抛错的替身与真实的 playbook 台账，让几处用例此前对“端口缺席”的依赖现了形。它们都改成了生产上会走的路径：

- **靠 block 停住的**：
  - `rfc310-pr2-reconciler` 的 readiness 用例原靠启动器缺席停住，改为基线不可解析。
  - `rfc310-pr2-recovery` 的唤醒用例原靠 repository 采集缺席停住，改为给出采集与动作端口，驱动到动作启动这个异步边界。
  - `rfc310-pr5-no-change` 的上传用例原靠放置端口缺席停住，改为给出放置。
- **钉住旧写法的**：`rfc370-attempt-context-root-wiring` 与 `rfc370-evidence-artifact-root-bindings` 钉的是 `?.` / `!` 的旧表达式，随之改写。
- **既有缺陷（RFC-310 PR-6 起）**：
  - `pipelineEvidenceChain.ts` 的 `pipelineAdapterBindingRef` 只认字符串形式的 `adapterRef`；而员工内容的 schema（PR-1B）要求它是版本化引用
    `{ id, revision }`。schema 合法的内容因此得到 `null`，采集、触发与重跑三个 arm 一律以 `pipeline-adapter-unbound` 停下。
  - `rfc310-pr6-pipeline-chain` 一直用字符串夹具，此前又因没有 playbook 台账而从不解析员工内容，所以没有暴露。
  - 现在按 domain 的 `pipelineProviderBindingSchema` 解析首个 provider，绑定写成 `id@revision`，与审批网关、需求源的绑定写法一致。用例改用 schema 合法的
    员工内容（`{ id: 'adapter-x', revision: 1 }`，绑定仍是 `adapter-x@1`）。

## 3. RFC-359 P0

- `scripts/rfc359-p0-mutations.ts` 的阶段表去掉 `p0-9-launchers`。
- `T/fixtures/rfc359-p0-mutations.ts` 去掉 `restoreMissingLegacyMissionLaunchers` 与它的 `case`。
- `T/rfc359-w14-p0-mutation-verdict.test.ts` 去掉它的样本日志与三处对它的断言（`rejects each wrong assertion…` 的两条改动、
  `rejects timeout or unrelated exception…` 的列表项）。
- `p0-9-terminal-observer` 与其余阶段不变。RFC-359 plan 中描述 P0-9 两阶段的那一行，加注退役与本 RFC 的链接。

## 4. 门与文档

- 新增 `T/rfc603-reconciler-ports-required-boundary.test.ts`，登记 guard-manifest：
  1. **编译期**：`ReconcilerPorts` 没有可选键；第 1.2 节各 deps 的 `ports` 必填，且它们的端口没有可选键（判据带负对照）。
  2. **源码**：`ReconcilerPorts` 声明 25 个成员、都没有 `?`。
  3. **扫描**：扫 `DA/application/**/*.ts`。
     - 不判断任何端口成员是否为 `undefined`，也不对端口成员用 `?.` 或 `!`。
     - 第 1.3 节删去的 code 不再作为字面量出现。
     - 判据带负对照，扫描文件数有下限。
  4. **helper**：`reconcilerPortsFor` 给全 25 个键，其中 20 个替身被调用即抛出带名字的错误。
- 计数：预计都不变。

## 5. 失败模式

- **有人把端口改回可选，或某个 deps 退回整份可选**：`tsc` 报错，RFC-603 用例 ① 红。
- **有人重新加回“端口没给”的分支**：RFC-603 用例 ③ 红。
- **用例走到它没给的端口**：替身抛出带名字的错误，用例按真实错误失败，而不是静默停在某个 block。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：端口由装配显式构造，provider 由 bootstrap 交入（RFC-597）。
- **C12**：RFC-603 用例 ②③ 读源码，① 在编译期断言，调用方由 `tsc` 全量核对。
- **C13**：计数不升。

## 7. 留下的

- launch / admission 的可选依赖（`uploadAdmission`、`resolveBaseline`）与需求物化器的 `source`，另立。
- `mr-care-not-wired` 是 policy 的 wait 原因，`arm-not-wired:<kind>` 是尚未实现的 arm，都与端口无关，不在 W4-E8 的范围。

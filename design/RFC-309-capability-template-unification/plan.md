# RFC-309 · 任务分解

> 产品视角见 [proposal.md](./proposal.md)，技术设计见 [design.md](./design.md)。

## 1. 拆分原则

**三个 PR，顺序不可调换**，因为后两个都建在合并后的表上：

- **PR-1「一套模板」** —— 合并表 + 迁移 + 权限归一 + CRUD 归一 + 配置包兼容。
  这是唯一含破坏性迁移的一批，独立成 PR 便于单独回看与回滚判断。
- **PR-2「模板即流程」** —— 模板详情 = 流程图 + T64 四态接线 + 删掉独立流程页签。
- **PR-3「从模板起跑」** —— `POST /api/code/rounds` + 四种能力输入 + 发起界面。

> PR-3 依赖 PR-1（要选一份模板）但不依赖 PR-2；若想更早拿到起跑能力，可把 PR-3 提到
> PR-2 之前，入口暂挂在模板列表行上。**默认按 1→2→3**，因为详情页正是发起按钮最自然的家。

## 2. 任务表

### PR-1：一套模板

| 编号 | 任务                                                                                                                                              | 依赖  | 状态 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---- |
| T1   | `capability_templates` 表 + 迁移 `0165`：N 绑定 → N 模板（**模板 id 延用绑定 id**）、零绑定框架保留、`upstream_id` 指向原框架、`base_digest` 计算 | —     | ✅   |
| T2   | `repo_capability_config.binding_id` → `template_id`（**只改名不改值**）                                                                           | T1    | ✅   |
| T3   | 迁移用例：N→N 且脚本各自继承；零绑定框架保留；**矩阵指针前后指向同一份配置**；旧表已 DROP                                                         | T1,T2 | ✅   |
| T4   | `anchorKind` 放宽加 `'platform'`（`codeWorkItems` + `codeFindings` 同批）                                                                         | T1    | ✅   |
| T5   | 权限目录：8 点 → `capability-templates:{read,create,update,delete}` 4 点 + 新增 `code-rounds:launch`；闭集断言 81 → 78；四角色预设更新；双语目录  | —     | ✅   |
| T6   | 迁移删除指向已删权限点的存量 grant（**D5 用户裁决**，迁移注释写明是有意为之）                                                                     | T5    | ✅   |
| T7   | 模板 CRUD 路由归一（list/get/create/update/delete/copy），`api-contract-coverage` 同步                                                            | T1,T5 | ✅   |
| T8   | **字段级权限**：body 改动 `scripts`/`hooks` 且无 `scripts:author` ⇒ 整个请求 403（不静默忽略字段）                                                | T7    | ✅   |
| T9   | 权限用例**两条分支都写**：有权可改脚本；无权 403 且 agent/prompt 仍可改（**AC-6**）                                                               | T8    | ✅   |
| T10  | 配置包：导出只产 `capability-template-create`；导入三种 op 都认，旧两种按同一规则合成（**AC-12**）                                                | T1    | ✅   |
| T11  | `services/demoSeed.ts` 改播一份合并后的模板                                                                                                       | T1    | ✅   |

### PR-2：模板即流程

| 编号 | 任务                                                                              | 依赖    | 状态 |
| ---- | --------------------------------------------------------------------------------- | ------- | ---- |
| T12  | 新增嵌套路由 `/code/templates/:id`（`/code` 现为单层）                            | T7      | ✅   |
| T13  | 详情页 = `CapabilityFlow`（组件零改动复用）+ 去掉「选绑定」下拉，模板从路由参数取 | T12     | ✅   |
| T14  | 模板列表行 → 详情；删除独立「流程」页签                                           | T13     | ✅   |
| T15  | 能力级只读流程移到**能力目录** + 新建模板向导（**AC-5**：没有任何模板时仍可看）   | T14     | ✅   |
| T16  | **T64 接线**：四态徽标 + 三方差异预览 + 「只合并未被覆盖的字段」（**AC-11**）     | T13     | ✅   |
| T17  | i18n 两语言；前端用例：详情渲染、无权限置灰、四态呈现                             | T13–T16 | ✅   |

### PR-3：从模板起跑

| 编号 | 任务                                                                                                              | 依赖    | 状态 |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ------- | ---- |
| T18  | `domain/launchInput.ts`：四种能力的判别联合 + 校验（**编译期**拒绝张冠李戴的 input）                              | T4      | ✅   |
| T19  | `application/launchRoundCommand.ts`：§4.2 六条校验 + `ensureWorkItem` + `openRound` + 标 `ClarifyOrigin.platform` | T18     | ✅   |
| T20  | `public/commands.ts` 加 `LaunchRoundCommand`（跨模块只走 exact 合同）                                             | T19     | ✅   |
| T21  | `POST /api/code/rounds`（权限 `code-rounds:launch`）+ 201 回执；`api-contract-coverage` 登记（**AC-9**）          | T20     | ✅   |
| T22  | 命令用例：六条校验各一条；**矩阵未启用时仍能发起**（**AC-8** 正面）；同一需求两次发起 = 两件工作项                | T19     | ✅   |
| T23  | 发起界面：详情页「用这份模板发起一次」→ 选仓库 + 按能力切换输入 → 直达该轮                                        | T21,T13 | ✅   |
| T24  | 平台发起的澄清落平台、**不回写任何 issue** 的用例（**AC-10**）                                                    | T19     | ✅   |
| T25  | e2e：全新库 → 复制 demo 模板 → 改 agent → 选仓库发起 requirement → 出现在活动页 → 澄清落平台                      | T23     | ✅   |

### 收尾

| 编号 | 任务                                                                   | 依赖 | 状态 |
| ---- | ---------------------------------------------------------------------- | ---- | ---- |
| T26  | `docs/dev-gotchas.md` 补录本轮通用坑                                   | 全部 | ✅   |
| T27  | RFC-304 的 T46b / T64 两笔转出账**在其 plan.md 里标为由 RFC-309 结清** | 全部 | ✅   |
| T28  | `design/plan.md` 索引 + `STATE.md` 同步；关闭时零待办、逐项写明归宿    | 全部 | ✅   |

## 3. 验收清单（对齐 proposal §7）

逐条写明**验收依据**（哪条用例锁的），而不是只打勾。

- [x] **AC-1** 只剩一个模板列表，新建/复制/导出/删除各一条路径（T7,T14）
      —— `code-page-inline.test.tsx`「every template is in ONE list」+ e2e
      `rfc309-template-launch`「there is ONE templates tab」（同时断言 `code-frameworks`
      / `code-bindings` 两个 testid 已不存在）
- [x] **AC-2** 迁移：N 绑定 → N 模板并继承脚本，`upstream_id` 指向原框架（T1,T3）
      —— `rfc309-template-merge-migration.test.ts`（真行迁移 + 变异实证）
- [x] **AC-3** 矩阵单元格迁移后指向同一份配置（T2,T3）
      —— 同上文件「THE MATRIX POINTER IS UNCHANGED」；模板 id 延用绑定 id 使该失败模式
      **不存在**而非「被测住」
- [x] **AC-4** 打开模板即流程图，点某步就地配置并写回（T13）
      —— `code-template-detail.test.tsx`「opening a template shows the steps it runs」+ e2e「an edit on the flow is saved to THAT template and survives a reload」
- [x] **AC-5** 没有任何模板时仍能看能力级流程（**RFC-307 AC-1 不得回归**）（T15）
      —— `code-page-inline.test.tsx`「the wizard draws the capability's steps」（`templates: []`）
- [x] **AC-6** 脚本字段权限门两条分支均有测试（T8,T9）
      —— `rfc304-capability-templates.test.ts`（有权可改 / 无权 403 且 agent、prompt 仍可改）；
      合并路径同门槛见 `rfc309-template-upstream-wiring.test.ts`「without scripts:author」
- [x] **AC-7** 四条能力都能从模板发起（T18,T21,T23）
      —— `rfc309-launch-round.test.ts`（判别联合四条锚点）+ `code-template-detail.test.tsx`
      （表单按能力切换输入）
- [x] **AC-8** 不要求矩阵启用；各拒绝有专属 code 与可读消息（T19,T22）
      —— `rfc309-launch-round.test.ts`「a round opens WITHOUT the matrix cell being enabled」+ 每个 code 各一条路由用例（含实现期新增的 `code-launch-round-in-flight`）
- [x] **AC-9** 发起有回执，界面可直达该轮（T21,T23）
      —— 回执含 `taskId`；「the route really starts the round's task」用一个克隆不了的仓库
      证明**确实尝试了启动**（拿到 201 = 接线断了）
- [x] **AC-10** 平台发起的澄清走平台，不回写 issue（T24）
      —— `rfc309-platform-launch-execution.test.ts`（platform → platform；**默认仍是 refuse**
      的反向断言同样锁住，防止把 issue 入口一起放开）
- [x] **AC-11** T64 四态 + 三方差异接上界面（T16）
      —— `rfc309-template-upstream-wiring.test.ts`（四态 + 三方 + 部分合并不静默了结冲突 +
      无基线一律 conflict）+ `code-template-detail.test.tsx`（四态呈现与合并按钮的有无）
- [x] **AC-12** 旧配置包仍能导入（T10）
      —— `rfc304-capability-package-roundtrip.test.ts`

## 4. 风险与前置

| 风险                                             | 处置                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| **迁移是本 RFC 唯一不可逆的一步**                | 单事务；模板 id 延用绑定 id 使矩阵指针零漂移；T3 三条断言各自独立        |
| 权限闭集 81→78 牵动 RFC-305 刚锁的断言与角色预设 | T5 一次改齐；存量 grant 按 **D5** 直接删除并在迁移注释写明是裁决         |
| 「部门改一次脚本、各组自动生效」被移除           | proposal §5 已作为 breaking change 逐项呈报；换成 T64 显式合并           |
| RFC-307 AC-1 回归（没模板就看不到流程）          | T15 专门保它，验收清单单列                                               |
| 多人并发树上动 `schema.ts` / `permission.ts`     | 二者都是高频共享文件；按仓规精确 `git add`，动前先 `git ls-files` 查引用 |

## 4bis. 实现期新增的风险（起草时没看见的）

| 风险                                           | 处置                                                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 「开单」被误当成「在跑」——本 RFC 自己踩了一次  | 补 `StartRoundTask` 端口 + 回执带 `taskId`；用例用**克隆不了的仓库**证明确实尝试了启动（拿到 201 = 接线断了）。定式已进 `docs/dev-gotchas.md` |
| 手动发起与 webhook 发起在同一 MR 上互不去重    | 已知取舍，`design.md §12` 逐条写明后果（重复劳动而非数据损坏）与替代方案为何更差                                                              |
| 三方合并的新基线方向写反，**第二次**读才暴露   | 基线只往上游走、冲突字段保留旧基线；用例「合并 → 再读一次」是唯一能抓到它的形状                                                               |
| 调度器改动落在 `scheduler.ts`（本仓最大文件）  | 只加两个**可选**入参与一个读函数，默认值一字未改；`rfc309-platform-launch-execution.test.ts` 同时锁正向（platform）与**默认仍 refuse** 的反向 |
| 删 Flow 页签会连带删掉 RFC-307 AC-1 的唯一入口 | 移入新建模板向导并单测（`templates: []`）；顺带补上「该能力没有序列」的如实告知，否则选到 `mr-monitor` 会看到一片空白                         |

## 5. 不在本 RFC 范围

- 结构可编辑（增删步骤、重连边）—— 仍是 RFC-304 D3。
- `mr-monitor` 手动发起 —— 它是常驻循环，不是轮次。
- 上游脚本改动自动传播 —— D1 的直接结果，显式合并是刻意选择。
- 部门 / 小组的组织建模 —— 用户明确「不需要区分」。

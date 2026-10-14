# RFC-372 审视后优化（2026-10-14）

> 状态：Done（2026-10-14）。用户批准实施，无需设计门与实现门；O1～O7 已实现并本地集中验证，O8 按建议暂缓；用户确认当前没有现网存量环境，O4 不保留 v1 兼容。PostgreSQL 与 e2e 以确切 SHA 的 hosted CI 为准。

## 1. 背景

[RFC-370/371/372 审视](../rfc370-372-review-2026-10-14.md) §2 列出了 RFC-372 的若干问题。用户要求按其中的建议优化 RFC-372。本文件是这批优化的设计与计划；原 v6 合同（L01～L16）继续有效，本批只做下列增量，不改变脑图模式的产品范围。

### 1.1 复核更正

写本设计时重新核对了代码，发现审视里有两处说法不准确：

- **“初始视口没有显示完整脑图”撤回。**
  - 现有 `readableMindmapCamera` 的规则是：适配全图后缩放不低于 0.8 时就直接适配全图；否则停在 0.85 的可读比例。见 `packages/frontend/src/lib/clarify/mindmap/geometry.ts:40-48`。
  - 截图中的裁切，来自那张图在可读比例下放不下，属于有意取舍，不改。
- **“未配置时返回 400”更正为 422。** 实际状态码是 `ValidationError` 映射出的 422，回归测试见 `packages/backend/tests/rfc372-light-clarify.test.ts:52-94`。

审视文档已同步更正。

## 2. 范围

| 编号 | 优化                                                                    | 性质               |
| ---- | ----------------------------------------------------------------------- | ------------------ |
| O1   | 分支追问附带原任务背景：任务启动输入 + 发起节点的提示词模板，长度有上限 | 行为增强（提示词） |
| O2   | 追问生成器的查表和运行时解析，从装配层下沉到 task-execution 基础设施层  | 结构调整，行为不变 |
| O3   | “在途追问”合并为一份进程内登记，由端口注入；`seal.ts` 不再引用应用层    | 结构调整，行为不变 |
| O4   | 内容键规范化（v2：对象键排序后哈希），直接替换 v1                       | 稳健性改进         |
| O5   | 追问生成未配置时返回 503（原 422）                                      | 错误码语义调整     |
| O6   | 分类弹窗：能补问时标题为“补充提问方向”，否则显示节点名称                | 界面               |
| O7   | 触控设备显示触控操作提示；画布宽度 ≤ 480px 时隐藏小地图                 | 界面               |
| O8   | （可选，建议暂缓）追问改为异步：提交即返回，生成状态随轮次详情查询      | 接口与交互变更     |

**不在本批**：

- collaboration 直读 `tasks` 表、依赖 legacy `@/services/taskWriteLocks`：属存量写法，随 collaboration 后续 RFC 收口。
- 迁移按 RFC 分开生成：流程约定，不是代码改动。

## 3. 能力影响

没有收缩或关闭任何既有能力：

- **O4**：用户确认当前没有现网存量环境，因此直接替换为 v2，不保留 v1 兼容。代价只落在部署瞬间仍处于“待回答”的脑图轮次：它们的已确认标记需要重新确认，旧页面需刷新后再提交。
- **O5**：只改错误码（422 → 503）和对应断言，错误代码 `clarify-followup-unavailable` 与文案不变。
- **O7**：窄画布上隐藏的只是小地图这一个快捷导航；平移、双指缩放、“适应全图”、键盘导航都不受影响。
- **O8（若做）**：`POST /api/clarify/:nodeRunId/followup` 的语义从“生成完才返回”改为“受理即返回”。生成失败和取消从 HTTP 409/422 改为在轮次状态里报告。前端随之改；目前没有其他 HTTP 或 MCP 消费方。

## 4. 设计

### 4.1 架构落位（对齐 RFC-294）

- **生成端口**：仍归 collaboration `application/ports`。task-execution 的适配器实现它，类型兼容由装配检查，task-execution 不反向导入 collaboration。
- **O2**：生成器从 composition 下沉到 `task-execution/infrastructure/clarifyFollowupGeneration.ts`。它只读 task-execution 自己拥有的 `node_runs` 和 `tasks`。系统 Agent 运行家族由 composition 构造后注入，基础设施层不引用应用层内部实现。
  - `composeClarifyFollowupGenerator(input)` 的名字与参数不变，两个 daemon 根的装配文本也不变，只剩接线。
- **O3**：
  - 在途登记的接口放在 `collaboration/application/ports/clarifyFollowup.ts`；
  - 唯一实现放在 `collaboration/infrastructure/clarifyFollowupActivity.ts`；
  - 应用层通过参数注入使用它，`seal.ts` 在基础设施层内直接引用；
  - 删除 `application/clarifyFollowupActivity.ts`。
- **本批承担的演进**：去掉装配层里的业务逻辑，去掉 infrastructure → application 的反向引用；同一状态只保留一份。
- **留下的债**：collaboration 直读 `tasks` 表（见 §2“不在本批”）。

### 4.2 O1 原任务背景

端口增加一个可选方法（测试替身可不实现）：

```ts
interface ClarifyFollowupTaskContext {
  inputs: { key: string; label: string; value: string }[]
  instruction: string | null
  truncated: boolean
}
// ClarifyFollowupGenerator 增加：
context?(input: { askingNodeRunId: string; taskId: string }): Promise<ClarifyFollowupTaskContext | null>
```

task-execution 适配器的取数规则：

- **启动输入**：从 `tasks.inputs` 取启动表单的值，按冻结工作流 `inputs[]` 的顺序配上 `label`。
  - 只收字符串、数字、布尔值和字符串数组；上传等对象值跳过。
  - 每项最多 4,000 字，合计最多 8,000 字，超出时截断并置 `truncated`。
- **节点指引**：用发起运行的 `node_runs.node_id` 在冻结快照里找到节点，取它的 `promptTemplate`，最多 4,000 字。
  - 模板保持原样，`{{port}}` 引用不展开。
  - 模板正是作者写给该 Agent 的业务指令，不含框架追加的协议段。
- 节点没有模板，或读取失败时，返回 `null`。

应用层的处理：

- 每次追加只取一次背景，放进提示词 JSON 的 `taskContext` 字段。
- 提示词增加一句：taskContext 是原任务输入与发起 Agent 的指令，只作背景，已经在其中明确的事项不要再问。
- 取背景失败不阻塞追问：适配器读取失败时记录日志并返回 `null`，应用层对任何异常都按“无背景”照常生成。
- 背景在同一轮内不变，不进入 `basis`。
- 原有的 128K 上下文上限仍然生效。

### 4.3 O4 内容键 v2

`packages/shared/src/clarifyMindmap.ts` 的改动：

- 新增 `canonicalClarifyJson`：对象键递归排序，数组保持顺序，`undefined` 字段与 `JSON.stringify` 一样省略。
- `clarifyContentKey` 改为 `v2:` + 四路 32 位哈希，算在规范化后的 JSON 上。确认依据、问题集合摘要、追问依据与请求依据都经由它产生，比较点（`isClarifyAnswerConfirmed`、`seal.ts` 的问题集合核对、追问的依据与重放核对、前端改答案时清除失效确认）全部沿用原来的相等比较，无需改动。
- 不保留 v1：当前没有现网存量（用户 2026-10-14 确认）。

### 4.4 O5 503

`routes/clarify.ts` 中，生成器未装配时抛 `DomainError('clarify-followup-unavailable', …, 503)`。错误代码与文案不变。

### 4.5 O6 分类弹窗标题

`MindmapWorkspace` 的弹窗标题规则：

| 选中节点 | 条件     | 标题                         |
| -------- | -------- | ---------------------------- |
| 问题     | —        | 仍为“回答与确认 · Qn”        |
| 分类或根 | 可以补问 | “补充提问方向”               |
| 分类或根 | 不能补问 | 节点标题（分类名或本轮主题） |

“可以补问”指未禁用、且该分支仍有未封存的问题，与正文是否显示补问表单的判定相同。

### 4.6 O7 触控提示与小地图

- 画布帮助文字拆成两段：
  - 鼠标/键盘段：沿用 `canvasHelp`；
  - 触控段：新文案 `canvasHelpTouch`，内容为“单指拖动平移 · 双指缩放 · 点按选择 · 点‘适应全图’查看全貌”。
- 用 `@media (pointer: coarse)` 决定显示哪一段，被隐藏的一段不进入无障碍描述。
- `@container mindmap-stage (max-width: 480px)` 时隐藏小地图按钮。

### 4.7 O8 异步追问（可选，建议暂缓）

若批准，按下面实现：

- **应用层**：新增 `start()`。
  - 同步完成前置校验：读取轮次、识别重放、判断是否已取消或已关闭、核对依据。
  - 已受理过的请求直接返回 `{state:'done', questionIds}`；否则登记在途，后台生成，返回 `{state:'running'}`。
  - 生成失败或取消，记入同一份在途登记的“最近一次失败”，保留 10 分钟，下次开始时清除。
  - `append()` 保留，等于 `start()` 加等待完成，供内部调用和现有测试使用。
- **路由**：POST 返回 202（运行中）或 200（已完成）。`GET /api/clarify/:nodeRunId` 的响应增加可选字段 `followup: {requestId, state:'running'|'failed', target, startedAt, error?}`。不新增接口。
- **前端**：
  - `useClarifyFollowup.start` 受理后，每 1.5 秒查一次轮次详情，直到该请求不再运行。失败时抛出原错误代码，界面沿用现有的错误展示。
  - 刷新页面后，从 `followup.state==='running'` 恢复“生成中”和取消入口。
- **e2e**：`rfc372-mindmap-journey`、`rfc372-recorded-mindmap`、`rfc372-recorded-directions` 三个用例中按同步 409/422/完成后立即读轮次断言的步骤，改为等待轮次里的追问状态。
- **代价与收益**：
  - 收益：刷新页面不丢“生成中”，协作者能看到生成状态，不再长时间占用 HTTP 连接（为 RFC-370 托管网关做准备）。
  - 代价：改动面约占本批一半，还要改写三份 e2e 录制用例的等待逻辑。
  - 当前单机经 vite 代理时，长请求本身可用。
  - 因此建议在 RFC-370 阶段 B 接入网关时一起做；本批默认不做，由用户决定。

## 5. 测试策略

| 编号 | 用例                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1   | 后端：生成器收到的提示词含 `taskContext`（启动输入的标签与值、发起节点模板）；超长值被截断并置 `truncated`；读取失败时仍能生成；双数据库读取发起节点与启动输入 |
| O2   | 后端：`clarifyFollowupGenerator.ts` 不再引用 `@/db/schema` 与 `drizzle-orm`（源码断言）；适配器按冻结运行时解析；两个根的装配文本不变（复用现有 root 断言）    |
| O3   | 后端：`seal.ts` 不引用 `../application/`；在途追问期间整轮提交与逐题封存都被拒绝（复用原用例，改为注入共享登记）；取消、重放、忙碌语义不变                     |
| O4   | 共享：属性顺序不同的同一对象键相等、数组顺序与取值变化仍改变键、确认在答案变化后失效；后端：用属性顺序不同的问题对象算出的键能完成整轮提交；e2e：提交载荷为 v2 |
| O5   | 后端：未装配生成器时 503 + `clarify-followup-unavailable`                                                                                                      |
| O6   | 前端：可补问的分类弹窗标题为“补充提问方向”；已提交轮次中分类弹窗标题为分类名                                                                                   |
| O7   | 前端：帮助文字同时渲染两段并带各自的类名；CSS 源码断言含 `pointer: coarse` 切换与 `max-width: 480px` 隐藏小地图                                                |
| O8   | （若做）后端：202/200 语义、详情 `followup` 状态、失败保留与清除、取消；前端：轮询、刷新恢复、失败展示；三个 e2e 用例按新状态等待                              |

## 6. 实施与验证顺序

遵循 `CLAUDE.md` 硬规则 1：

1. 用户批准后，一次写完 O1～O7（以及选定的 O8）的全部生产代码和测试用例。开发期间只做语法与格式自查。
2. 集中验证：
   - shared / backend（rfc372 及受影响用例）/ frontend 的相关测试；
   - 涉及包的类型检查、lint、prettier；
   - 若做 O8，再跑三个 e2e 用例。
3. 实现门：只审功能。
4. 按路径提交源码。用该提交的源码（`--source-ref`）重算 `architecture/*.json` 配套；计数增长时按 T17 登记一次性增长声明，作为第二笔提交。
5. 推送后跟踪这两笔的确切 SHA CI，失败先归因。
6. 更新本文件、`plan.md`、RFC 索引与 `STATE.md` 的状态。

## 7. 验收清单

- [x] O1～O7 全部实现，§5 用例全部编写并通过集中验证（shared 13、backend SQLite 79、frontend 全量 7441；三包 tsc、depcheck、lint/prettier）
- [x] O8：暂缓（建议与 RFC-370 阶段 B 网关接入一起做）
- [x] 实现门：用户豁免
- [ ] 源码与架构配套按路径提交并推送，确切 SHA 的 CI 结果如实记录

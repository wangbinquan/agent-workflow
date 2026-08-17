# RFC-307 · 技术设计

> 产品视角见 [proposal.md](./proposal.md)，任务分解见 [plan.md](./plan.md)。

## 0. 一句话

把 RFC-304 **已经存在**的两样东西接起来：阶段合同里的 `requires`/`produces`（一张没被画
出来的 DAG）与两层模板里的可配项（一堆没跟位置绑定的 JSON），中间用既有的
`WorkflowCanvas` 只读模式渲染。**零执行面改动、零 schema 变更、零新权限点。**

## 1. 事实基线（写码前按源码核实，`file:line` 可复跑）

| 事实                                                      | 位置                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 阶段合同带 `requires` / `produces`，即 DAG 的边           | `domain/stageContract.ts:80,83`（`StageBase`）                                       |
| 四种阶段 kind                                             | `program` / `script`(`scriptSlot`) / `ai`(`agentSlot`) / `invoke`(`capability`+区间) |
| **四**条能力共 **44** 步：program 32 · ai **6** · script 4 · invoke 2 | 由 `projectStageGraph` 对合同实投影所得（先前 grep 出的「45 步 / 7 个 ai」多数了第 7 处 `kind: 'ai'`——那是 `capabilityRegistry.ts:6` 的一句注释） |
| **`mr-monitor` 没有阶段合同**——它是监视器主循环，不是序列 | `capabilityRegistry.ts` 只导出四个 `*_CONTRACT`；`lookupStageContract('mr-monitor')` 返回 `undefined` |
| 钩子挂在**每个阶段边界**，回传受 `injectable` 白名单约束  | `stageContract.ts:73,86`                                                             |
| 画布已支持只读与状态叠加                                  | `WorkflowCanvas.tsx:246 readOnly` / `:249 nodeStatuses` / `:262 inactiveEdgeIds`     |
| 运行态每步状态已落库                                      | `code_round_stages`（status / error / startedAt / endedAt）                          |
| 两层模板写回端点齐全                                      | `routes/capabilityTemplates.ts:66,87,102,126,232,252`                                |
| 幂等播种先例                                              | `services/fusion.ts` 的 `seedFusionResources`，`cli/start.ts:5e` 调用                |
| 「删掉不重播」先例                                        | RFC-153 运行时行：seed 在非空表上 no-op                                              |

## 2. 图从哪来：合同的**投影**，不是第二份定义

### 2.1 单一事实源

渲染用的图**必须**由 `CODE_CAPABILITY_CONTRACTS` 投影而来，不允许前端或文档另抄一份。
理由是本仓反复踩过的坑（`docs/dev-gotchas.md`）：手抄清单会漂，而漂了没人发现。

```
domain/stageGraph.ts          ← 新增，纯函数，零 IO
  projectStageGraph(contract) → { nodes, edges }
```

- **节点**：每步一个，`{ id: stageName, kind, agentSlot?, scriptSlot?, requires, produces, parallel?, injectable? }`
- **边**：对每个 `produces: A` 的步 S 与每个 `requires: A` 的下游步 T，连一条 `S → T`，
  边上带 artifact 名。同一 artifact 被多步消费就是扇出，多个产出汇入一步就是扇入——
  这与 `wrapper-fanout` / 汇合在画布上的既有画法一致。
- **`parallel: true`** 的步（分片审）在图上标为并行段，与合同注释一致（钩子对整段触发
  一次而非每片一次）。
- **`invoke`** 步渲染为可展开的子序列引用（指向另一条能力的 `[from, to]` 区间），
  语义与 `call-workflow` 节点在画布上的画法对齐。

**图的正确性由测试锁死**：对每条能力，`produces` 未被任何下游 `requires` 消费的
artifact、以及 `requires` 找不到上游产出的 artifact，都必须为空（`invoke` 注入的除外）——
这条断言同时是**合同自身的健全性检查**，比只画出来更有价值。

### 2.2 为什么不复用 `workflow_definitions`

RFC-304 的 **D3** 已裁决：阶段序列不落工作流表，否则用户的工作流列表里会出现一堆不可
编辑的系统行，且校验规则互相污染。本 RFC **不推翻 D3**——投影只在读侧存在，不落库、
不进 `workflows` 表、不占用 `NODE_KIND`。

代价：画布组件吃的是 `CanvasNodeData`，而投影出来的不是工作流节点。设计上取
**适配而非改造**：新增一个薄适配层把 `StageGraph` 映射成画布要的形状（见 §4.1），
画布本身零改动。

## 3. 接口

### 3.1 读：能力流程图

```
GET /api/code/capabilities/:capability/graph
→ { capability, stageContractVer, nodes: StageGraphNode[], edges: StageGraphEdge[] }
```

- 权限：`repos:read`（与 `/api/code/capabilities` 一致，不新增权限点）
- 纯静态投影，不查库，不依赖任何仓或轮次 ⇒ **AC-1「未开启任何能力也能看」**
- 带 `stageContractVer`：合同版本变了，前端缓存要失效
- **`mr-monitor` 返回 `no-stage-contract`（200 而非 404）**：它是平台真实提供的能力，
  只是没有阶段序列——404 会让人以为名字打错了。界面据此显示「这条能力是常驻监视循环，
  不由阶段序列驱动」，把「没有图」这件事**说出来**而不是画一张空图。

### 3.2 读：运行态叠加

不新增端点。`GET /api/code/work-items` 已返回每轮的 `stages[]`（含 status/error），
前端把它按 `stageName` 与图节点对齐即可 ⇒ **AC-3**。

> 落差与处置：一轮的 `stages` 只包含**已经开始过**的步。未开始的步在图上按 `pending`
> 渲染，而不是缺节点——「图是完整的，状态是部分的」，这样用户看到的始终是全貌。

### 3.3 写：图上改配置

**不新增写端点**，全部复用既有的：

| 图上的动作           | 落到哪                                                             | 端点                                 |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| 换 agent / 改 prompt | `capability_bindings.agent_by_slot_json` / `prompt_by_slot_json`   | `PUT /api/capability-bindings/:id`   |
| 编辑脚本             | `capability_frameworks.scripts_json`                               | `PUT /api/capability-frameworks/:id` |
| 调参数               | `capability_bindings.params_json`（按框架 `paramSchema` 生成表单） | `PUT /api/capability-bindings/:id`   |
| 挂钩子               | `capability_frameworks.hooks_json`                                 | `PUT /api/capability-frameworks/:id` |

**权限自动如实**：这些端点已经带 `capability-bindings:update` / `capability-frameworks:update`
（+ 框架脚本的 `scripts:author`），前端按 `usePermission` 置灰 ⇒ **AC-7**，零新权限点。

## 4. 前端

### 4.1 一个组件，三种用法

```
components/code/CapabilityFlow.tsx
  props: { capability, statuses?: Record<stageName, StageStatus>, onPickStage?, readOnly }
```

- **模板面**：`statuses` 缺省 ⇒ 纯结构图（US-1）
- **活动面**：传入该轮 `stages` 映射 ⇒ 状态叠色（US-2），复用画布 `nodeStatuses`
- **配置态**：`onPickStage` 打开右侧抽屉（US-3/4）

节点视觉按 kind 区分（AI / 程序 / 脚本 / 子序列），沿用既有 `StatusChip` 与画布样式，
**不新写 chrome**（§Frontend UI consistency）。

### 4.2 槽位是一等公民（Q-A 的默认取向）

点某个 AI 步 → 抽屉标题是**槽位**（如 `reviewer`），并把**所有共用该槽位的步骤**在图上
高亮。抽屉里明写「此槽位被 N 步使用：review-shard、review-global」，避免用户以为只改了
一步 ⇒ **AC-4**。

### 4.3 钩子的插入点

图上每条边的中点显示「＋」。点开后：

- 选 `pre`（下游步之前）或 `post`（上游步之后）；
- 按该步 `injectable` 白名单显示「此处钩子可回传：`promptSuffix` / `extraContext`」，
  未声明则显示「此处钩子不能回传数据，只能读工作树或中止」——把合同里的约束**变成界面
  上的事实**，而不是让用户写完才发现被拒 ⇒ **AC-6**。

## 5. Demo 数据（AC-8 / AC-9）

沿用 `seedFusionResources` 的形状，新增 `services/demoSeed.ts`，在 `cli/start.ts` 现有
seeder 段调用：

| 播种物           | 内容                                                                 | 幂等策略                |
| ---------------- | -------------------------------------------------------------------- | ----------------------- |
| demo 框架        | 一条 `mr-review` 框架，含一个可读的示例 `collect` 脚本与一条示例钩子 | 固定 id，存在即跳过     |
| demo 绑定        | 指向 demo 框架，`agentBySlot` 指向内置 demo agent                    | 同上                    |
| demo agent       | 一个只读 reviewer                                                    | 同上（`builtin: true`） |
| demo 工作流 ×2–3 | 与能力流程可对照的简化版（见 Q-C）                                   | 同上                    |
| demo 轮次        | 一条 `settled` 的工作项 + 一轮 + 全套 `code_round_stages` 行         | 同上                    |

**四条硬约束**：

1. **删掉不重播** —— seed 在「该固定 id 已存在过」时 no-op；删除后不复活（RFC-153 先例）。
   实现上不能只判「表空」，因为用户可能只删 demo 而保留自己的数据。
2. **明确标注** —— 名称带 `[demo]` 前缀 + `description` 写明「示例数据，可安全删除」。
3. **零外部依赖** —— 不连 code host、不起子进程、不发网络请求 ⇒ **AC-9**。
   demo 轮次是**播种的历史行**，不是真跑出来的（Q-B）。
4. **不污染真实统计** —— demo 轮次要能被 `/code` 指标面识别并排除，或明确计入但标注。
   ⚠️ **待确认项**：默认取「计入但在 UI 上标注」，因为排除需要给 `code_work_items` 加列
   （schema 变更，与本 RFC「零 schema 变更」冲突）。若你要求排除，需接受加一列。

## 6. 落位（RFC-294）

| 新增                                     | 层                       | 理由                                                            |
| ---------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| `domain/stageGraph.ts`                   | `code-capability/domain` | 纯函数，零 IO，合同 → 图                                        |
| `public/queries.ts` 加 `StageGraph` 类型 | `code-capability/public` | 跨模块只走 exact 合同                                           |
| `routes/code.ts` 加一条 GET              | routes                   | 与既有 `/api/code/*` 同族                                       |
| `services/demoSeed.ts`                   | services                 | 要同时碰 agents / workflows / 能力模板三域，与 `fusion.ts` 同理 |
| `components/code/CapabilityFlow.tsx`     | frontend                 | 复用 `WorkflowCanvas`，不新写画布                               |

**无偏离项**：不新增 bounded context、不新增 execution kind、不动 `NODE_KIND`、
不新增权限点、不新增迁移。

## 7. 失败模式

| 场景                                     | 行为                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 合同里出现孤立 artifact（产出无人消费）  | **测试红**（§2.1 的健全性断言），而不是画出一个孤儿节点                                         |
| 一轮的 `stages` 里有图上没有的 stageName | 说明合同版本与该轮的 `stage_contract_ver` 不同 ⇒ 图上按「此轮使用的是旧版合同」提示，不静默丢弃 |
| 用户无 `capability-bindings:update`      | 图可看，抽屉只读，保存按钮置灰（不是隐藏——隐藏会让人以为功能不存在）                            |
| demo 数据被删                            | 不复活；`/code` 空态文案改为「示例已删除」而非「什么都没有」                                    |
| 框架脚本编辑后语法错                     | 保存时按既有 `scripts:author` 校验路径拒绝，错误显示在抽屉里                                    |

## 8. 测试策略

| 层     | 必写                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain | `projectStageGraph` 对五条能力各一条：节点数 = 合同步数；边由 requires/produces 推导正确；**健全性断言**（无孤立产出 / 无悬空依赖）；`parallel` 与 `invoke` 标记正确 |
| 路由   | `GET /graph` 200 + 未知能力 404 + 无权限 401/403；`api-contract-coverage` 登记新端点                                                                                 |
| 前端   | 结构图渲染（节点数、kind 区分）；状态叠加（done/failed 着色 + error 文案）；同槽位高亮；无权限置灰；钩子抽屉按 `injectable` 显示允许键                               |
| 播种   | 幂等（跑两次只有一份）；删掉不重播；零网络（用例断言未发起 code-host 调用）                                                                                          |
| e2e    | 全新库启动 → `/code` 能看到 demo 模板与 demo 轮次 → 打开流程图 → 改一个 prompt 并保存 → 重开仍在                                                                     |

## 9. 呈用户确认

- **Q-A** 槽位 vs 阶段：默认**槽位为一等公民**（改动小、语义不变）。
- **Q-B** demo 轮次：默认**播种历史行**（零外部依赖）。
- **Q-C** demo 工作流主题：默认「与能力流程可对照的简化版」2–3 条。
- **Q-D**（本文档新增）demo 是否计入 `/code` 指标：默认**计入但 UI 标注**，因为排除要加列。

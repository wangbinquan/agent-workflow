# RFC-302：Intent 新建工作流自动布局

状态：**Done（2026-08-14；D1-D6 与 AC-1～AC-9 已实现并验收）**
日期：2026-08-14

## 1. 背景

Intent Builder 已经能生成 workflow changeset，并在复核区用只读 `WorkflowCanvas` 同时提供内嵌与放大预览。
但当前画布只做 `fitView`：节点坐标完全来自模型输出或 legacy index fallback，不会调用编辑器已有的
wrapper-aware `planWorkflowLayout`。因此模型省略坐标、给出重叠坐标或按 JSON 顺序随意排点时，复核画布和提交后的
工作流都会显得凌乱；用户还要进入编辑器再手动点一次“自动整理”。

现有链路的关键事实：

- `packages/frontend/src/lib/workflow-layout.ts` 已有确定性的 left-to-right、wrapper-aware Dagre 规划器；
- `WorkflowCanvas` 只在可编辑 surface 的显式按钮动作中调用它，只读 Intent surface 不调用；
- `turnEngine.ts` 当前把模型 changeset 的 canonical JSON 原样写入 `intent_drafts.changeset_json`，并对同一串计算
  `draft_hash`；
- apply 阶段从这份已确认草稿解析 workflow definition 后直接创建资源。

因此只在前端预览重排会形成“审核看到 A、提交保存 B”；只在 apply 时重排则会让最终资源包含未进入草稿哈希的
变化。自动布局必须在草稿落库与哈希之前完成。

## 2. 目标

1. Intent 新生成的 `action:create + resourceType:workflow` 草稿自动得到确定性的 left-to-right 布局。
2. 复核区内嵌画布、放大画布、raw JSON、确认哈希和最终创建的 workflow 使用同一份已布局 definition。
3. 复用编辑器唯一布局规划器；不能在 backend 另写一个简化拓扑排版，也不能靠 prompt 要求模型自行摆坐标。
4. 自动布局保持 wrapper membership、edge、port、节点业务字段和引用句柄不变；nested wrapper 与合法 cycle 可用。
5. 旧待提交草稿、Intent update、update→copy 和普通编辑器现有行为不发生静默重排。

## 3. 非目标

- 不给 Intent 增加“布局方向/间距/算法”设置。
- 不自动重排 `action:update` workflow；更新应保留既有作者布局。用户把 update 选择为 copy 时也保留该已审核布局。
- 不修改 task/workgroup/dynamic preview 的只读画布，不让 `readOnly` 隐式等于“自动布局”。
- 不回填或改写已经持久化的 `intent_drafts`，不重算旧 `draftHash`。
- 不改变 workflow definition schema、Intent API wire、数据库 schema、权限或 apply 生命周期。
- 不用浏览器实测 DOM 尺寸决定服务端草稿坐标；服务端只使用同一规划器的版本化默认尺寸与 definition 中的显式尺寸。

## 4. 产品裁决

### D1：只覆盖模型显式新建的 workflow

触发条件严格为：

```text
op.action === 'create' && op.resourceType === 'workflow'
```

同一 changeset 中的 agent/skill/MCP/plugin/workgroup 不变；workflow update 与由 update 决策派生的 copy 不变。

### D2：布局发生在草稿 canonicalization 阶段

顺序固定为：

```text
parse model changeset
  → normalize create-workflow geometry
  → canonical JSON + post-layout byte limit
  → draft validation
  → persist changeset_json + draft_hash
  → review
  → apply the exact persisted definition
```

布局后的 `position` 以及 planner 必需时更新的 wrapper `size` 都进入 canonical JSON 和 `draftHash`。客户端不能在
review/apply 之间重新跑一次布局。

### D3：固定 Intent 起点，编辑器默认行为不变

共享 planner 增加可选 root anchor。Intent new-workflow 使用固定 `{x:80,y:80}`，从而不让模型随意给出的绝对坐标影响
最终画布位置；编辑器手动“自动整理”不传该选项，继续以当前 selection/全图 bbox 为锚并优先使用 xyflow 实测尺寸。

布局方向、rank/spacing、cycle back-edge 选择、wrapper 递归与 size lock 语义全部沿用 RFC-199 的现有实现。

### D4：预览不再做第二份展示专用布局

Intent DTO 继续返回 persisted changeset。`IntentOpPreview` 只负责把 `agentRef` 映射成可读标签并把同一 definition 交给
两个 `WorkflowCanvas`；不增加 `autoLayout` prop，也不在浏览器覆盖坐标。raw JSON 与画布因此天然一致。

### D5：结构失败 fail closed，合法 cycle 不阻断

- 若 create-workflow payload 不能投影成布局安全的 workflow definition，草稿保留原 payload 供 raw JSON 排查，同时新增
  blocking validation error `intent-workflow-layout-input-invalid`；不能 crash turn，也不能把未布局的可提交草稿伪装成成功。
- cycle 继续按稳定 edge id 排除 rank constraint，但真实 edge 不删除，属于正常非阻断布局结果。
- `sizeLocked` wrapper 内容放不下时新增 blocking error
  `intent-workflow-layout-size-locked-overflow`，避免自动布局后仍提交确定重叠的容器。
- 自动布局增加坐标后必须重新检查 `INTENT_LIMITS.maxChangesetBytes`；超限沿用
  `changeset-too-large`，不截断 position 或部分布局。

### D6：旧草稿保持原样

部署前已经落库的草稿继续用原 hash、原 preview、原 apply 语义。用户需要新布局时通过 Intent 的继续完善/重新生成得到新
revision。这样不会让一个已经确认过的 hash 在升级后指向另一份 definition。

## 5. 用户故事

### US-1：新建普通 DAG

用户让 Intent 创建 `input → agent → review → output`。即使模型省略全部 position 或把节点放在同一点，复核画布按依赖从左
到右无重叠；提交后打开 workflow 编辑器仍是相同坐标。

### US-2：新建含 wrapper 的工作流

Intent 创建 git/loop/fanout nested wrapper。内层先布局并 fit，父层再按投影依赖排布；wrapper membership、边界边和 inner
node 的相对几何不被改写。

### US-3：修改已有工作流

Intent update 一个已有 workflow 时，只改用户要求的业务字段/节点；既有位置不因本 RFC 全图重排。选择“另存为副本”亦同。

### US-4：复核与提交一致

用户在 Intent 复核画布和 raw JSON 中看到的 position/size 被 `draftHash` 覆盖；apply 不能在确认后再衍生另一套坐标。

## 6. 能力影响

本 RFC 不收缩既有能力：

- workflow 仍可在普通编辑器中自由拖动、Undo/Redo、整理所选或整理全图；
- Intent update/copy 仍保留现有布局；
- 模型仍可输出 position，但在 **create workflow** 路径中只作为不可信草稿输入，最终相对布局和 root anchor 由平台归一；
- 旧草稿与旧 workflow 不迁移；
- 无权限、ACL、密钥、runtime、apply recovery 或资源可见性变化。

## 7. 验收标准

- **AC-1**：新 create-workflow 的每个可布局节点都在 persisted changeset 中有平台生成的有限 position；模型原坐标不决定
  相对排布，top-level bbox 从固定 root anchor 开始。
- **AC-2**：普通 DAG、分支/汇合、孤立节点、合法 cycle、nested git/loop/fanout wrapper 均确定性布局；重复运行同一输入
  byte-for-byte 相同且再次规范化幂等。
- **AC-3**：布局只改变 geometry 字段；opId/tempRef/handle/agentRef/workflowRef/workgroupRef、nodes/edges 顺序和全部业务字段
  原样保留。
- **AC-4**：Intent session DTO、内嵌预览、放大预览、raw JSON、draftHash 和创建后的 workflow definition 指向同一坐标。
- **AC-5**：workflow update、update→copy、非 workflow op、旧草稿均 byte-for-byte 保持现有语义。
- **AC-6**：invalid layout input 与 size-locked overflow 阻断提交并给稳定错误码；cycle 不阻断；post-layout 超限不产生半布局。
- **AC-7**：编辑器手动自动布局继续使用实测尺寸、现有 bbox anchor、history/Undo 与 warning UI；task/其他 preview surface 不变。
- **AC-8**：shared planner 是唯一 Dagre workflow layout 内核，frontend/backend 无第二套实现，现有 frontend 文件最多保留一跳
  re-export facade。
- **AC-9**：定向 shared/backend/frontend、真实 daemon→Intent draft→browser review→commit→editor E2E、响应式/画布几何断言与
  `bun run gate:local` 全绿；实现门无未处置 P1/P2。

## 8. 批准与完成记录

- 用户已批准 D1-D6 与 AC-1～AC-9；实现提交 `1322226f` 已进入 `origin/main`。
- 最终隔离发布树 `bun run gate:local` 全绿：shared 2079、frontend 6426、backend 10110 pass / 35 skip / 0 fail。
- 真实 daemon→draft→review→commit→editor 的重叠 DAG、nested wrapper 与合法 cycle 在 Chromium/WebKit 共 4/4 通过。
- 首轮 hosted CI 暴露的相邻 RFC-287 延迟准备投影遗漏由 `574d2c67` 修复；真实双仓 smart-HTTP 后端测试及
  RFC-024/RFC-248 Chromium 2/2 通过。
- 精确 SHA `574d2c67f59221eb49dab62b6507d03afaa0bd60` 的主 CI `31762926366` 36/36 作业全绿，包含 Windows binary build 与
  frontend 3/3；未声称 live service 部署。

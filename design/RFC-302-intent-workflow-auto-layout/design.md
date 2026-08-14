# RFC-302 技术设计：Intent 新建工作流自动布局

状态：**Done（2026-08-14；实现门与发布门均通过）**
源码核对基线：`15438053188af748f59b45f5cefc1ba2a678768c`

## 1. 当前链路与问题

### 1.1 已有唯一布局能力

`packages/frontend/src/lib/workflow-layout.ts` 的 `planWorkflowLayout` 已实现：

- Dagre left-to-right rank；
- data/control 依赖的 LCA coordinate-space projection；
- boundary/system channel 排除；
- cycle 的稳定 back-edge 排除；
- nested wrapper 自内向外 layout + fit；
- selection、sizeLocked、warning 与 immutable measured-size snapshot。

`WorkflowCanvas.tsx:888-946` 只在 editable editor 的显式 `handleAutoLayout` 中调用它。Intent 的两个只读 canvas
（`IntentOpPreview.tsx:301-332`）只消费 definition + `fitView`，不重排坐标。

### 1.2 草稿哈希要求归一必须前置

`turnEngine.ts:805-854` 当前执行 `parseIntentChangeset → validateDraftChangeset → settle`，而
`turnEngine.ts:440-452` 把同一个 `canonicalJson` 同时持久化为 `changeset_json` 并计算 `draft_hash`。apply 在
`applyChangeset.ts:573-577` 解析 create-workflow definition，最终于 `:995-1049` 原样插入。

因此合法的数据流只有：在 `settle` 前生成并持久化已布局 changeset。前端展示专用 reflow 和 apply-time reflow 都会破坏
“审核内容 = hash 内容 = commit 内容”的既有不变量。

## 2. 不变量

1. **Review exactness**：preview/raw JSON/draftHash/apply 使用同一 persisted changeset。
2. **Identity preservation**：layout 不解析、替换或重排 Intent handle/tempRef；引用授权仍只在 resolve/apply seam 发生。
3. **Geometry-only**：只允许写 node `position`，以及既有 planner 为 wrapper fit 写出的 `size`；nodes/edges/op 顺序不变。
4. **Create-only**：只有模型输出的 workflow create op 自动归一；update 与 update→copy 不进入该函数。
5. **Determinism**：相同 canonical input + layout algorithm version 得到 byte-equal output，不读取 DOM、时间、locale、随机数或 DB。
6. **Total boundary**：任意 schema-legal Intent changeset 都不能让 normalizer throw；不可布局的 workflow 变成 blocking validation error。
7. **Single kernel**：编辑器与 Intent 必须调用同一个 planner；backend 不复制 Dagre/拓扑/wrapper-fit 实现。
8. **Legacy stability**：不扫描、不更新既有 `intent_drafts`；apply 不根据“有没有 position”猜新旧版本。

## 3. Shared canonical layout kernel

### 3.1 模块拆分

把 protocol/React/DOM 无关部分移入 `@agent-workflow/shared`：

```text
packages/shared/src/
├── workflowNodeGeometry.ts   # effective position + default node geometry
├── workflowWrapperGeometry.ts# pure wrapper fit/clearance primitives
└── workflowLayout.ts         # Dagre planner + warnings + layout version
```

`packages/shared/package.json` 增加与 frontend 当前完全相同的 `@dagrejs/dagre` 版本；frontend 因
`structureGraph.ts` 仍直接使用 Dagre，暂不删除自己的 direct dependency。

前端 `workflow-placement.ts` 继续拥有 collision-search 等编辑器 placement 行为，但从 shared import/re-export 唯一
`effectiveWorkflowNodePosition`。`wrapperFit.ts` 只保留端口 chrome minimum-size 这类 presentation adapter，并从 shared
import/re-export planner 所需的 wrapper geometry。旧 `frontend/src/lib/workflow-layout.ts` 删除；调用方直接从 shared import。

源码棘轮允许 Dagre 的另一个既有消费者 `structureGraph.ts`，但 workflow layout planner 只能有 shared 一处实现；frontend
facade 不得含算法分支。

### 3.2 Planner 合同扩展

现有 API 增加一个向后兼容选项：

```ts
interface WorkflowLayoutOptions {
  semanticContext?: { agentsByName: PortAgentLookup }
  measuredSizes?: ReadonlyMap<string, { width: number; height: number }>
  selection?: WorkflowLayoutSelection
  rootAnchor?: { x: number; y: number }
}
```

- editor 不传 `rootAnchor`：保持当前 selection/whole-bbox anchor；
- Intent 传 `rootAnchor: INTENT_WORKFLOW_LAYOUT_ORIGIN`，常量为 `{x:80,y:80}`；
- `rootAnchor` 只在 `scopeId === null && selection.mode === 'all'` 时生效；wrapper 内部仍以 wrapper clearance 为 anchor，
  selection layout 也不允许意外读到 fixed anchor；
- `semanticContext` 缺省为空 port lookup。它只影响 dependency diagnostic 中的 control 分类；当前 rank 对全部非
  boundary/non-system dependencies一致，因此有/无 agent inventory 的 `next` 必须完全相同，并用 parity test 锁住；
- planner 返回的新 definition 不修改输入；`plan(plan(input))` 在 fixed root anchor 下必须幂等。

导出 `WORKFLOW_LAYOUT_ALGORITHM_VERSION = 1` 供测试/诊断使用，但不把版本 marker 写进 workflow wire；实际 position/size 已经
冻结结果，未来 planner 升级只影响新生成/新手动布局。

## 4. Intent create-workflow normalizer

### 4.1 归属与落位

新增纯 domain seam：

```text
packages/backend/src/modules/intent/domain/workflowCreateLayout.ts
```

它属于 RFC-294 的 `intent` bounded context/domain：输入、输出都是 `IntentChangeset` 值对象，只依赖 shared canonical planner，
不依赖 DB、route、Actor、resource service 或 frontend。当前 legacy `services/intent/turnEngine.ts` 作为一跳调用方；不在
`routes/`/`services/` 新增跨域 facade。

### 4.2 Raw Intent identity adapter

Intent workflow 与正式 `WorkflowDefinition` 唯一结构偏差是 agent/call target 使用 handle/tempRef。Normalizer 不能提前 resolve
这些引用，否则会越过 manifest/ACL/copy decision 与 apply transaction。

每个匹配的 create op 执行：

1. 深拷贝 definition，并用专用 planner-input guard 验证 planner **实际读取**的闭集：node `id/kind/position/size/nodeIds`、
   edge `id/source/target/boundary`、id 唯一性与 membership 可终止性；拒绝 duplicate node id、非有限 geometry、畸形 edge
   endpoint 与 cyclic wrapper membership；
2. 仅在私有 layout projection 中把 `agent-single.agentRef` 临时映射到同值占位 `agentId`；call 的
   `workflowRef/workgroupRef` 同理只为 layout projection 提供不透明占位。当前 `WorkflowDefinitionSchema` 的 node 基座仍是
   `.passthrough()`，**不能**把一次 `safeParse` 冒充 kind-specific 业务校验；prompt/review/script/call 等业务字段继续由现有
   resolve/apply validator 负责，本 RFC 的 guard 只保证 planner total；
3. 调 shared `planWorkflowLayout(projected, {rootAnchor:{x:80,y:80}})`，不提供 DOM measured sizes；
4. 按原 node index/id 把 planner 产出的 `position` 与 wrapper `size` 投回原始 Intent node；
5. 原始 `agentRef/workflowRef/workgroupRef`、全部业务字段和顺序原样保留，私有占位绝不进入输出；
6. 返回新的 changeset、per-op warnings 与 stable errors；全程不 mutation 输入。

若 workflow structural projection 失败，输出原 op + `intent-workflow-layout-input-invalid`。这样 raw JSON 仍可诊断，同时 draft
进入 review-blocked；不能 catch 后当成已布局成功。

### 4.3 Warning 归约

| planner result           | Intent 归约                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `cycle-back-edge`        | 非阻断；edge 保留，稳定选择只影响 rank constraint                                                  |
| `size-locked-overflow`   | blocking `intent-workflow-layout-size-locked-overflow`，带 opId/wrapper id，不提交确定溢出的新资源 |
| `cross-scope-selection`  | internal invariant error；Intent 永远传 `{mode:'all'}`                                             |
| planner throw/非有限结果 | 捕获并转 stable `intent-workflow-layout-input-invalid`；日志只记 code/opId，不记 payload           |

不扩 `IntentDraftDto.validation` wire；两条新错误必须使用现有 op 归属格式：

```text
op-3: workflow definition cannot be auto-laid out (...) (intent-workflow-layout-input-invalid)
op-3: size-locked wrapper wrap-a cannot contain its laid-out children (intent-workflow-layout-size-locked-overflow)
```

即固定以 `${opId}: ` 开头，再进入既有 `validation.errors[]`、op error 匹配与 Review blocked 路径；不能只返回裸 code，
否则页面会把错误留在全局摘要而不落到对应变更卡。

## 5. Turn canonicalization

`turnEngine` 的 changeset 分支调整为：

```ts
const parsed = parseIntentChangeset(changesetText)
const normalized = normalizeIntentWorkflowCreateLayouts(parsed.changeset)
const canonicalJson = canonicalIntentJson(normalized.changeset)
const bytes = utf8Bytes(canonicalJson)
const report = validateDraftChangeset(dump.manifest, normalized.changeset)
report.errors.unshift(...normalized.errors)
settle(..., {
  draft: { changesetJson: canonicalJson, canonicalJson, validationJson: JSON.stringify(report) }
})
```

具体合同：

- parser 的原始 byte limit 仍是早期拒绝；归一后再次检查，防 position/size 把结果推过上限；
- post-layout 超限走同一 `intent-changeset-invalid` + `changeset-too-large` 路径，不创建 draft row；
- `releaseScratch()` 只在 parse + normalization/canonical byte gate 通过后执行，保持现有协议失败证据保留语义；
- summary/opCount/mountRequests 不变；blockingErrors 包含 layout errors；
- persistence 与 hash 代码不变，只接收 normalized canonical JSON；
- session DTO 继续直接 JSON.parse `changeset_json`，无需读端 fallback。

## 6. Apply 与 frontend

### 6.1 Apply

apply 不重新布局，不增加“无 position 则布局”的启发式。create path 已经从 exact confirmed draft 得到 position/size，继续经过
正式 schema、引用解析、ACL、prepare 与 big transaction。update/copy path没有行为变化。

系统 E2E 必须断言最终 `workflows.definition_json` 的 geometry 与 draft DTO byte-equivalent，而不只是“节点没有重叠”。

### 6.2 Preview

`IntentOpPreview` 不新增布局逻辑。它仍把 raw `agentRef` 映射成 display label 后 parse 为 canvas definition；映射前后的 geometry
保持。内嵌与 expanded canvas 接收同一个 `shown` object。

前端回归测试增加：

- create preview mock `WorkflowCanvas` 两次收到同一 normalized positions；
- update Before/After switch 不触发布局函数；
- raw JSON 包含与 canvas 相同 position/size；
- 390px/desktop 的既有 canvas height、dialog 与 fitView 行为不变。

## 7. 兼容、发布与回滚

- 零 migration、零 API/schema version bump；position/size 已是 workflow definition 既有字段。
- 部署前 drafts 不改。部署后新 draft 的 hash 已包含布局；旧 binary 也能读取/提交这些普通 geometry 字段，因此代码回滚不会
  损坏新草稿。
- 回滚到旧代码后只失去“后续新草稿自动布局”，已生成坐标仍保留；不能删除新 draft 的 position 以伪造回滚。
- 不使用 marker 推断新旧，不做 lazy write-on-read。

## 8. RFC-294 对齐

| 关注点           | 本 RFC 落位                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| bounded context  | Intent-specific 触发/错误归约在 `modules/intent/domain`；workflow geometry kernel 为 shared stable contract |
| layer            | normalizer 为纯 domain；legacy turn engine 是 application orchestration；DB persistence/apply 不新增旁路    |
| dependency       | intent domain → shared value/algorithm；不 import frontend、route、DB 或 resource-catalog internal          |
| single writer    | draft row/hash 仍只有 turn settle writer；workflow row仍只有现有 apply/Workflow command writer              |
| cross-context    | 不读取 resource 表、不解析 ACL/handle；resolve/apply 继续通过既有资源提交合同                               |
| target evolution | 新代码直接落 feature-first intent module；旧 `services/intent` 只增加一跳调用，不长第二个 service facade    |

本 RFC 不实现 RFC-294 的 AtomicApply 迁移，也不改变其 lifecycle；没有新增偏离项。

## 9. 安全与隐私

- planner 只读 workflow topology/geometry；不读取 prompt、secret slot value、credential、Actor 或文件系统。
- 错误与日志只包含 opId、node/wrapper id 和 stable code，不记录整个 payload。
- reference placeholder 只存在函数内，永不持久化或展示，不能变成授权依据。
- 归一发生在 secret scan/confirm slot 之前，但只投影 geometry；script env/MCP secret carrier 与 pointer index 不变，因为 nodes 顺序不变。

## 10. 测试策略

### 10.1 Shared planner

- 普通 DAG、branch/merge、isolated nodes、stable cycle back-edge；
- omitted/overlapping/extreme model positions + fixed root anchor；
- nested git/loop/fanout wrapper、boundary/system edge、descendant delta；
- sizeLocked overflow、empty wrapper、measured-size editor path；
- input immutability、fixed-anchor idempotence、100 次 deterministic replay；
- empty/full semantic lookup 输出 geometry parity；
- source ratchet：workflow Dagre planner 只有 shared 一处，frontend legacy file 不含算法。

### 10.2 Intent domain/backend

- create workflow 自动布局；多 workflow create 各自布局；非 workflow op不变；
- update、update→copy 证明不进入 normalizer；
- agentRef/tempRef/call refs、node/edge/op order 与 secret pointer 完全保留；
- invalid definition fail closed 且 turn 不 crash；sizeLocked overflow 阻断；cycle 不阻断；
- post-layout byte-limit 边界（刚好等于/多 1 byte）与无 partial draft；
- draft persisted JSON/hash 对 normalized canonical bytes；supersede/context CAS/retry 不变；
- apply 创建 row exact geometry；apply replay/失败补偿不重跑 layout；旧 draft fixture原样提交。

### 10.3 Frontend与系统 E2E

- Intent inline/expanded canvas props 与 raw JSON exact；
- editor auto-layout history/Undo/warnings/measured size 的既有用例全绿；task/preview surface 隔离；
- 真实 daemon + deterministic intent runtime fixture 输出全重叠 DAG：等待 draft terminal → 浏览器复核无重叠、拓扑 left-to-right →
  commit → 打开 workflow editor → DB/画布 geometry一致；
- nested wrapper 与合法 cycle 各一条系统 fixture；390×844 与 desktop，light/dark、axe、无页面 overflow。

## 11. 预计改动

- `packages/shared/src/{workflowNodeGeometry,workflowWrapperGeometry,workflowLayout}.ts`
- `packages/shared/src/index.ts`、`packages/shared/package.json`、`bun.lock`
- `packages/frontend/src/lib/workflow-placement.ts`
- `packages/frontend/src/components/canvas/wrapperFit.ts`
- `packages/frontend/src/components/canvas/WorkflowCanvas.tsx`
- 删除 `packages/frontend/src/lib/workflow-layout.ts`
- `packages/backend/src/modules/intent/domain/workflowCreateLayout.ts`
- `packages/backend/src/services/intent/turnEngine.ts`
- shared/backend/frontend tests 与一条 Intent system/browser E2E

不预计修改 DB schema、route、Intent DTO、apply writer、i18n 或 CSS。

## 12. 请批前设计门记录

当前 Codex 会话按 `docs/dev-gotchas.md` 的要求，对 RFC 三件套与 live source 做了 source-backed、具体失败输入驱动的设计门。
本轮没有启动独立 companion/subagent；当前上层协作规则禁止在用户未要求时派生子代理。第一轮发现并修订 3 条 P2：

1. **P2-A，permissive schema 被误当完整 planner admission**：初稿写“临时 agentId 后由正式 schema 校验其余 node shape”。
   具体反例是 `{kind:'call-workflow', workflowName 缺失}`：`WorkflowDefinitionSchema` 的 `nodes` 仍使用
   `WorkflowNodeSchema.passthrough()`，该行可过 safeParse，证明它不是 kind-specific validator。修订为专用 planner-input
   闭集 guard；它只保证 topology/geometry total，业务字段仍归现有 resolve/apply validator。
2. **P2-B，fixed anchor 作用域不闭合**：若实现只把 `rootAnchor` 替换通用 `anchor`，nested wrapper 或 selection layout 也会被
   强拉到 `{80,80}`，破坏 wrapper relative geometry/“整理所选”现有语义。合同改为只在
   `scopeId === null && selection.mode === 'all'` 生效，并为 wrapper/selection 加负空间测试。
3. **P2-C，裸错误码无法归属 op 卡**：Intent review 的错误筛选依赖 `${opId}:` 前缀。若 normalizer 只返回
   `intent-workflow-layout-input-invalid`，用户只在全局摘要看到阻断，选中 op 没有原因。两条错误的 exact prefix/shape 已写死并
   纳入 frontend integration test。

相邻复核确认：post-layout byte limit 在 hash 前；old draft 不 backfill；update/update→copy 不进入 normalizer；secret pointer 因
nodes 顺序不变而稳定；apply 不二次布局。修订后当前会话结论为 **0 条未处置 P1/P2**。实现前若用户另行要求独立 companion，
再按固定文件清单与隔离快照补跑，不以本记录冒充独立评审。

## 13. 实现与发布门记录

- shared 唯一 planner、Intent domain normalizer、turn canonicalization、preview/apply exactness 与负空间均随 `1322226f`
  进入 `origin/main`；零 migration、零 wire/权限/apply lifecycle 变化。
- 最终候选树完整 `gate:local`：shared 2079、frontend 6426、backend 10110 pass / 35 skip / 0 fail，总耗时 10m19s。
- RFC-302 系统 E2E：Chromium 2/2、WebKit 2/2；首轮 hosted shard 上同两条也通过。
- 首轮 CI 暴露的相邻 RFC-287 G7 成功路径兼容投影遗漏由 `574d2c67` 修复：`tasks` 的首仓 legacy 列、`repoCount` 与
  `spaceKind` 和 `task_repos` 在同一事务回填；真实双仓 smart-HTTP 后端行为测试 10/10 文件级通过，RFC-024/RFC-248
  Chromium 2/2，S-14 写点棘轮 3/3。
- 精确 SHA `574d2c67f59221eb49dab62b6507d03afaa0bd60` 的 GitHub Actions 主 CI `31762926366` completed/success，36/36
  作业成功；Windows binary build 与 frontend 三分片均成功。未执行部署，未声称 live service 状态改变。

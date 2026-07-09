# RFC-160 跨节点反问默认 scope 改为「反问者」（cross 默认单卡，与同节点对齐）

状态：Draft

## 背景

任务问题看板（RFC-120）里，同节点反问（self）与跨节点反问（cross）的呈现不一致。用户
2026-07-09 反馈：「跨节点反问和同节点反问在问题列表中的表现为什么还是不一致，为什么在处理
待指派问题的时候还有处理节点选择？直接都以处理节点默认是本节点还是来源节点来显示和配置就
行了吧」。

调研根因（引用见 `design.md`）：

- **self 反问恒 1 张卡**：提问＝承接＝同一节点，承接默认＝提问节点自己。
- **cross 反问默认 2 张卡**：默认 scope 是 `designer`（`CLARIFY_QUESTION_SCOPE_DEFAULT`，
  `packages/shared/src/schemas/clarify.ts:150`），且 RFC-137 之后集中回答面板**不再逐题选
  scope**、一律按默认提交（`CentralizedAnswerDialog.tsx:372-374`）。于是每条已答 cross 问题
  默认派生：
  - **反问者卡**（`roleKind='questioner'`，恒有，承接默认＝来源/提问节点）；
  - **设计者卡**（`roleKind='designer'`，承接默认＝被审视的上游节点，让它拿答案修订自己的
    产出）。

处理节点的**默认值本来就是**用户要的形态（self→本节点、cross 反问者卡→来源节点）；看板上的
「处理节点」下拉是**默认之上的改派 override**（RFC-120/127），并非从零选择。「不一致」的真正
根源是 cross 比 self 多出的那张**设计者卡**（RFC-059 的 `scope=designer` 路径）。

## 用户拍板（AskUserQuestion，2026-07-09）

- **Q1 处理节点选择 → 维持现状**：保留改派下拉/override，本 RFC 不动。
- **Q2 → cross 默认改单卡·反问者**：把 cross 默认 scope 从 `designer` 改为 `questioner`，让
  cross 默认只出一张反问者卡、承接＝来源节点，与 self 对齐；`/clarify` 详情页仍可手选
  「设计者」保留上游修订能力。
- **老轮向后兼容 → 一并收敛·单卡**：追溯生效、无 migration；已下发的设计者卡不动、未下发的
  按新默认移除，需要时可经改派恢复。

## 目标

1. 新 cross 反问轮在**未显式选 scope** 时，默认只派生反问者卡（questioner），承接＝来源/提问
   节点——每题恒 1 张卡，与 self 对齐。
2. 设计者修订路径**保留为显式选择**：`/clarify` 详情页 scope picker 选「设计者」，或把反问者
   卡改派到设计节点（RFC-140 collapse-to-designer）。
3. 全站（含已存在的已答 cross 轮）一致收敛：老轮里未下发的 designer 卡下次 reconcile 按新
   默认移除。

## 非目标

- **不删改派 Select / override 机制**（Q1 维持现状）。
- **不删设计者修订能力本身**——仍可经详情页 picker 或改派显式获得。
- **不改 self 反问**、不改 scope 的语义（scope 仍是单向「**也**送设计者」标记，反问者恒收全量
  Q&A——RFC-059）。
- 「未答不显示加入待下发」是**独立 bug**（`collapseDesignerEntryToQuestioner` 的 seal 归一化
  缺 answered 守卫），已在本 RFC **之外**单独修复（`rfc138-reassign-to-asker-collapse.test.ts`
  回归用例），不属本 RFC 的 diff。
- 不做数据 migration（用户选追溯收敛）。

## 用户故事

1. 审计节点 A 审视上游 B 的产出、发起跨节点反问；人在集中面板答完 → 默认只有 A 自己带答案
   重跑产出结论（1 张反问者卡，承接＝A），B 不自动改。与「A 用提问代替产出、下游等 A」的
   阻塞-产出语义一致。
2. 人确实想让上游 B 拿答案改自己的产出 → 去 `/clarify` 详情页把该题 scope 选「设计者」，或在
   看板把反问者卡改派到 B（触发 RFC-140 collapse-to-designer，补 echo 回执给 A）。
3. 已存在的老看板：之前按默认 designer 生成、但还没下发的设计者卡，升级后下次刷新按新默认
   消失；已下发在跑/已完成的设计者卡不受影响；需要时改派反问者卡到设计节点即可恢复。

## 验收标准

- **AC-1**：一条新 cross 轮、无显式 scope、答完 → reconcile 只产 questioner 条目、无 designer
  条目；board 上该题恰 1 张卡、承接＝来源节点。
- **AC-2**：`/clarify` 详情页对该题显式选「设计者」→ 照旧产 designer 条目（能力保留）。
- **AC-3**：改派反问者卡到设计节点 → RFC-140 collapse 恢复 designer 卡 + echo 回执（行为不变）。
- **AC-4**：已存在已答 cross 轮（`questionScopesJson=NULL`）+ 一张**未下发** designer 行 →
  下次 reconcile（`listTaskQuestions`）移除该 designer 行、保留 questioner 行；**已下发**的
  designer 行不动。
- **AC-5**：`CLARIFY_QUESTION_SCOPE_DEFAULT === 'questioner'`；`resolveQuestionScope(null, …)
  === 'questioner'`；显式 `scopes[qid]` 仍胜。
- **AC-6**：self 反问、以及显式 `scope=designer`/`questioner` 的既有行为逐字不变（golden-lock）。

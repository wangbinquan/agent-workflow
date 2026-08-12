# RFC-291 设计门（2026-08-12）

双路独立评审，沿用本仓惯例（路 1 锚点核实 + 路 2 对抗破坏）。两路都在 **pin 到 `ed22cc00` 的
detached worktree** 里做（共享主工作树上有并发 session 的未提交改动，直接在主树评审会把别人的
diff 卷进来——`docs/dev-gotchas.md` §Codex 的定式）。worktree 内 `bun install --frozen-lockfile`
（1542 包 / 981ms）以便评审方能真跑测试自证，而不是退化成纯代码阅读。

- 路 1：本会话逐条打开文档引用的 `file:line`，核对「行存在 / 内容相符 / 支撑该结论」，并对文档中
  未经验证的**逻辑断言**单独取证。
- 路 2：`codex exec --sandbox read-only` 对抗评审（prompt 内联范围、硬排除他人 RFC、五项核实任务、
  P1/P2/P3 输出格式）。

## 结论

**初版不通过（FAIL）。** 两路合计 11 条 finding：路 1 两条（P2×1 / P3×1），路 2 九条（P1×4 / P2×5 含
P3 合并条）。其中「面 C 的跳过只覆盖 catalog 初查」由两路**独立同发**，可信度最高。

按归属拆分：

- **本 RFC 自己的缺陷（3 条）**：copy 谱系只记直接来源（P1-c）、`pickCallTarget` 未真正单点化（P2-b）、
  AC-16 断言会把正确实现判红（P2-d）。外加测试矩阵 false-green（P2-e）与锚点 stale（P3、路 1 F2）。
- **本 RFC 的承诺与既有机制冲突（1 条）**：G2/B2/US-3 承诺「原件退出上下文且不可直接改」，但闭包会把它
  抬回 detail（P1-b）。
- **既有缺陷、被本 RFC 放大（3 条）**：call 边无法映射到 handle 且泄漏裸 ULID（P1-a）、handle ordinal
  跨轮回收（P1-d）、dump materialize 阶段抛错炸整轮（P2-a / 路 1 F1）。

6 条已在本轮文档修订中处置（见各条「处置」）。**3 个方向题需用户拍板后才能定稿**，不自行假设。

## 方向题与用户裁决（2026-08-12，逐条反问后拍板）

| #              | 方向题                                | 裁决                                                                                                             |
| -------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Q1**（P1-a） | call 边 handle 绑定与 ULID 泄漏的归属 | **纳入本 RFC 一并修** → design v2 面 E。落地时发现可沿用既有 `agentRef ↔ agentId` 模式同构扩展，不发明新机制     |
| **Q2**（P1-b） | copy 承诺强度                         | **弱化承诺**（(a) 案）：只保证「不再是显式挂载根」，不引入抑制态。理由：改父资源时本就应看得到被引用子资源的正文 |
| **Q3**（P1-d） | handle 高水位回收的归属               | **纳入本 RFC 修** → design v2 面 F。只持久化高水位、不做全映射（§8.3 取舍，剩余「handle 悬空」登记 R4）          |

三条裁决已回写 `proposal.md`（G5/G6、B2/B4、AC-5/AC-8b/AC-9b/AC-16/AC-18~21、§7 Q3-Q5）、
`design.md` v2（面 E §7、面 F §8、§4.4 承诺弱化）与 `plan.md`（P8-P10、T8/T9、N6/N7）。

## 复核后状态

初版 FAIL 的 11 条**全部处置完毕**：8 条文档修订，3 条方向题按用户裁决纳入实现范围。
v2 文档待用户批准后进入实现；实现完成前还有一道 **Codex 实现门**（`CLAUDE.md` 双门第二道）。

## 路 1 — 锚点核实与断言取证

### 通过的锚点（抽样逐条打开核对）

| 文档引用                                   | 核实结果                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applyChangeset.ts:1070`                   | ✓ `tx.update(intentSessions)`，`set` 中确为 `commitSeq` / `contextRevision` / `currentDraftId` / `updatedAt` 四项，无 `contextManifestJson`                             |
| `applyChangeset.ts:1045`                   | ✓ `applied.push({...})`，字段与文档 §3.2 所列一致                                                                                                                       |
| `applyChangeset.ts:872-886`                | ✓ 大事务内重读 session 并 CAS 三项（`contextRevision` / `currentDraftId` / `inFlightTurnId`）                                                                           |
| `resolveChangeset.ts:465`                  | ✓ `const action = op.action === 'create' \|\| isCopy ? 'create' : 'update'`——copy 归一为 create，支撑「挂载集合 = `applied.filter(action==='create')`，无需第二处判据」 |
| `resolveChangeset.ts:474`                  | ✓ `intent-target-not-mounted` 抛点                                                                                                                                      |
| `resolveChangeset.ts:135`                  | ✓ 草稿校验的 inventory-only 拒绝文案                                                                                                                                    |
| `resolveChangeset.ts:646`                  | ✓ `...(entry === undefined \|\| isCopy ? {} : { manifestEntry: entry })`——copy 确实刻意丢弃 `manifestEntry`                                                             |
| `turnEngine.ts:489`                        | ✓ `roots = manifestBefore.filter((e) => e.root)`                                                                                                                        |
| `turnEngine.ts:508-513`                    | ✓ 覆写 manifest 的三重条件（session 存在 / `inFlightTurnId === turnId` / `contextRevision === launchRevision`）                                                         |
| `dumpBuilder.ts:191`                       | ✓ `if (node.kind !== 'agent-single') continue`——workflow 闭包确实只走这一条边                                                                                           |
| `dumpBuilder.ts:241`                       | ✓ `throw new Error(\`mounted resource is not visible: ...\`)`                                                                                                           |
| `dumpBuilder.ts:245-247`                   | ✓ 闭包成员以 `root: false` 进 `detailRefs`，与根同路径拿 `detail: true` + fence                                                                                         |
| `manifest.ts:5-7`                          | ✓ 「The manifest is the ONLY place handles map to canonical ids」——支撑 §4.2 由 handle 反查 `resourceId`                                                                |
| `session.ts:212-250`                       | ✓ `buildInitialManifestInTx` 把初始 mounts 写成 `root: true`                                                                                                            |
| `session.ts:884-889`                       | ✓ `removeIntentMount` 只置 `root = false`，条目与 handle 保留                                                                                                           |
| `intentSessions.ts:456-464`                | ✓ mounts 投影 `displayName: ... ?? null`，不可见挂载在 UI 侧退化为「资源不可用」                                                                                        |
| `intentDoc.ts:452-453`                     | ✓ `## Access notes` 段由 `hiddenDependencyNote` 渲染                                                                                                                    |
| `workflow.ts:809` / `:829`                 | ✓ `CallWorkflowNodeSchema`（`workflowName` + 可选 `workflowId`）/ `CallWorkgroupNodeSchema`（`workgroupName` + 可选 `workgroupId`）                                     |
| `resourceRefs.ts:39-50` / `:64-71`         | ✓ `extractWorkflowAgentRefs` / `extractWorkflowWorkflowRefs` / `extractWorkflowWorkgroupRefs`                                                                           |
| `shared/workflowCalls.ts:25-38` / `:46-56` | ✓ `collectWorkflowCallRefs` / `collectWorkgroupCallRefs` 返回带 `nodeId` + 可选 id 缓存                                                                                 |
| `intentSession.ts:328`                     | ✓ 回执 `fromCopy: z.boolean()`——确实只是布尔，不携带原件身份                                                                                                            |

### 断言取证（文档中未经验证的推断，逐条取证）

- **「`convergeIntentApplyJournal` 对 `committed` 行只做文件系统面的 roll-forward，不重放大事务」**
  —— ✓ 成立。`applyChangeset.ts:1257-1266`：`else if (row.state === 'committed')` 分支只调
  `rollForwardCommitted(db, { skillStages: ... })`。这条支撑 design §3.1「必须写在大事务内」的核心
  论证：事务外补写一旦崩溃，**没有任何补偿路径会修它**。

- **「`buildSkillFence` 的 throw 分支在正常路径不触发」** —— ✓ 成立。`skill.ts:541-545`
  `readSkillContent` 无条件 `encodeSkillToken(...)` 并返回 `token`；行消失时它先抛
  `ConflictError('skill-changed')`（`skill.ts:538-540`）。**但这条取证反而暴露了 F1（见下）。**

- **「自动挂载的资源必然对后续轮次的 actor 可见」** —— ✓ 成立，且值得作为不变量入档。
  `session.ts:439-443` `assertWritable` 把会话写权限制为 **owner-only**（admin 的读旁路显式不延伸到
  写，返回同形 404），因此 apply 的 actor 恒等于会话 owner；而创建落库时 `ownerUserId: actor.user.id`。
  两者相乘 ⇒ 自动挂载的资源不可能对下一轮的 actor 不可见。**若将来放开会话协作写权，这条前提失效**，
  自动挂载会开始批量产出 F1 类的不可用根——文档需要显式记这一笔。

## 路 1 Findings

**[P2] F1 — 面 C 的「跳过」只覆盖 catalog 可见性层，未覆盖 dump 阶段的读取抛错**

- Evidence：`dumpBuilder.ts:222-241` 的跳过判据是 `rootInCatalog`（`loadVisibleCatalog` 的内存快照）；
  而真正 dump 一个 skill 时走 `readSkillContent`（`dumpBuilder.ts:326`），后者在行已消失时抛
  `ConflictError('skill-changed')`（`skill.ts:538-540`），**不经过** §5.1 设计的跳过路径。
- Failure：会话挂着 skill S（自动挂载或手动）。下一轮生成开始，`loadVisibleCatalog` 读到 S；在随后
  逐个 dump 的窗口内，用户（或同 owner 的另一个标签页）删除 S ⇒ `readSkillContent` 抛
  `ConflictError` ⇒ **整轮生成硬失败**，与本 RFC 面 C 想消灭的症状完全相同，只是触发窗口更窄。
  自动挂载使会话中挂着的 skill 数量显著上升，等比放大该窗口。
- Fix：把 §5.1 的跳过语义从「catalog 缺失」上移为「**该根这一轮拿不到可 dump 的内容**」——在逐资源
  dump 的外层对每个 detail ref 做失败捕获，命中即按同一路径记入 `unavailableMounts` 并保留清单条目；
  非根的闭包成员失败则退回既有 `hiddenDependencies` 计数。同时在测试策略里补一条竞态用例
  （catalog 加载后、dump 前删除资源）。若决定不做，必须显式登记为「已知既有竞态，本 RFC 不扩大也不修复」，
  不能默认读者以为面 C 已覆盖。

**[P3] F2 — 前端锚点行号偏 2 行**

- Evidence：design.md §5.2 写 `intent.detail.tsx:468`；pin 版本实际为 `:466`
  （`<strong>{mount.displayName ?? t('intent.mountUnavailable')}</strong>`）。该文件在 `5e95ac58`
  （`fix(intent): show resource names in commit flow`）刚改过 91 行，行号已漂移。
- Failure：接手者按 `:468` 定位会落到相邻 JSX，浪费一次定位；本仓 RFC 的 file:line 是复核契约的一部分。
- Fix：改为 `:466`，并在该处注明「该文件为三方并发热点（RFC-290 / 5e95ac58 / 本 RFC），实现时以符号
  而非行号定位」。

## 路 2 — Codex 对抗评审

`codex exec --sandbox read-only`（codex-cli 0.147.0）在同一 pin worktree 跑完，判定 **FAIL**，
9 条 finding（4×P1 / 5×P2 / 1×P3 合并条）。**每条都经本会话独立复核**（不盲信评审结论，
`CLAUDE.md` 对既有断言的复核规则同样适用于门禁产出）。复核结论：**4 条 P1 全部证实，无驳回**。

### [P1-a] call 边在 dump 里无法表达「这条边指向哪个 handle」，且泄漏裸 ULID

- 复核：**证实**。`dumpBuilder.ts:399` `if (node.kind !== 'agent-single') return node` —— call 节点
  **原样**进 dump，连同 `workflowId` / `workgroupId` 这两个 canonical ULID 缓存字段。这与
  `manifest.ts:5-7`「the model never sees a ULID」直接冲突。
- 后果：两个可见同名工作流 W1（较老）/ W2，父节点 `{workflowName:"build", workflowId:W2}`。启动期
  `freezeCallClosure` 正确绑定 W2；面 D 也会把 W2 拉进详情。但模型看到的是「名字 + 一个裸 ULID」，
  无法判定该边对应 `mounted/` 里的哪个 handle。若实现者为满足 handle 隔离而抹掉 id，模型回写父工作流
  时缓存丢失，**下次启动按名字回落到较老的 W1** —— 用户以为在改被调用的工作流，运行的却是另一个。
- 归属：**既有缺陷**（今天挂载任何含 call 节点的工作流就已泄漏 ULID），但面 D 把「模型会去改被调用的
  子工作流」从理论变成主线场景，等于把这条从潜伏抬成必踩。
- 处置：**方向题，待用户拍板**（见 §待拍板 Q1）。

### [P1-b] 「原件退出上下文」的承诺被闭包重新提升所破坏

- 复核：**证实**，且这是本 RFC 自己写下的承诺与既有机制的冲突。`resolveChangeset.ts:424` 表明 copy 由
  用户 decision 驱动（`applyMode === 'copy'`），**不限于**他人/内置资源的强制 copy；而闭包成员照样拿
  `detail: true` + fence（`dumpBuilder.ts:245-247` → `:277+`），update 守卫只看 `detail` 不看 `root`
  （`resolveChangeset.ts:471-478`，本 RFC 自己在 design §1 强调过这一点）。
- 后果：会话同时挂着 agent O 与引用 O 的 workflow P。对 O 选 copy → 提交后 O `root:false`、副本 C 成根；
  下一轮 P 的闭包又把 O 抬回 `detail:true`，针对 O 的原地 update **照样通过两道守卫**。proposal G2 /
  B2 / US-3 所称「原件全文退出上下文、无法再直接提 update」**不成立**。
- 处置：**方向题，待用户拍板**（见 §待拍板 Q2）。

### [P1-c] `copiedFromResourceId` 记的是直接来源，不是谱系根 —— 「只留最新副本」会漏

- 复核：**证实**。这是本 RFC 的**新设计缺陷**，非既有问题。
- 后果：O→C1（C1 溯源 O）；再对 C1 选 copy → C2（C2 溯源 **C1**）。随后重新挂载 O 并 O→C3 时，退根步骤
  只命中「溯源 = O」的 C1，**命不中 C2** ⇒ C2 与 C3 同时为根，直接违反 AC-8b。全程都是合法输入。
- 处置：**已修**。谱系根改为传递取根：新副本写入
  `sourceEntry.copiedFromResourceId ?? sourceEntry.resourceId`，比较键为 `(resourceType, originResourceId)`。
  测试补 O→C1→C2 再从 O / 旧 C1 分叉的用例。

### [P1-d] dump 重建丢弃条目 ⇒ handle ordinal 被回收复用

- 复核：**证实**，并且 `manifest.ts:51-52` 的注释「Counters only ever grow … so conversation history
  stays coherent across epochs」**与实现相反**（本仓审计常见类型，应一并修注释）。
  `createHandleAllocator`（`manifest.ts:59-70`）只从传入 manifest 恢复高水位；`buildIntentDump` 每轮从
  空数组重建，inventory 只保留 `.slice(0, cap)`（`dumpBuilder.ts:474`），**被 cap 淘汰或已删除且非 detail
  的条目不进新清单**，高水位随之回退。
- 后果：下一个新建资源拿到历史 ordinal，旧对话里对 `res#agent#3` 的引用**指向另一个资源**。测试缝
  `inventoryCap` 可确定性复现；生产 cap=500 需要 500 个名字靠前的同类资源。
- 归属：**既有缺陷**。本 RFC 的面 C 已让「不可用的根」保留条目（部分缓解），但退根条目（copy 原件、
  同源旧副本）仍可能被淘汰。
- 处置：**方向题，待用户拍板**（见 §待拍板 Q3）。

### [P2-a] unavailable 判定只覆盖 catalog 初查（与路 1 F1 独立同发）

- 复核：**证实**，两路独立命中同一处，可信度最高。Codex 补充了更准确的抛点：`readSkillContent` 在行
  消失时抛 `skill-not-found`（`skill.ts:501-515`），路 1 记录的 `skill-changed`（`:538-540`）是同函数
  内更晚的另一处；两条都绕过 §5.1 的跳过路径。
- 处置：**已修**。§5.1 的跳过语义上移为「该根这一轮拿不到可 dump 的内容」——在逐资源 materialize 外层
  捕获**明确的 deleted / not-visible** 结果转 unavailable 条目，闭包成员则计入 `hiddenDependencies`；
  其余 I/O 损坏仍照常失败（不吞真错）。补 catalog 加载后删除资源的竞态用例。

### [P2-b] `pickCallTarget` 并未真正单点化裁决

- 复核：**证实**。原设计让 helper 接收**已经挑好**的 `hinted` / `oldestVisibleByName`，而真正的判据
  （名字相等、可见性、ULID 取最老）留在调用侧（`closure.ts:281-324`，workgroup 分支在 `:395-442` 另有
  一份）。dumpBuilder 只要按 Map 顺序取到同名的另一行，helper 单测全绿而两侧选出不同工作流——AC-14
  声称的「共用同一裁决实现」形同虚设。
- 处置：**已修**。helper 改为接收 `idHint` + **完整的 actor-visible 候选集**，名字相等 / hint 优先 /
  取最老 ULID 全在 helper 内完成；调用方只负责提供可见候选。测试改为 freeze 与 dump 用**同一 DB 夹具
  对拍**（同名、改名 hint、不可见 hint、cap 四种）。

### [P2-c] call 递归会终止，但复杂度可在启动模型前占满事件循环

- 复核：**证实**。`expandClosure` 每个 mount 新建 `seen` 并独立重跑（`dumpBuilder.ts:141-148`、
  `:225-227`），队列用 `queue.shift()`（`:175-176`）是 O(n²) 搬移；本 RFC 让「一次提交 64 个根」成为
  常态输入（`intentChangeset.ts` `maxOps: 64`）。design §9 R2「只增加 token、不影响正确性」不成立。
- 处置：**已修**。改游标队列 + 跨 roots 共享 memo（邻接展开只算一次），复杂度回到 ~O(V+E+roots)；补
  大扇出 + 共享子图 + 64 根的复杂度回归。

### [P2-d] AC-16 的源码断言会把正确实现判红

- 复核：**证实**。dump renderer 必须识别 `'agent-single'` 字面量才能把 `agentId` 转成 `agentRef`
  （`dumpBuilder.ts:399-403`）；而 AC-16 要求整个 `dumpBuilder.ts` 不再出现该字面量 —— 正确实现照样红，
  为凑绿删 renderer 则会让 canonical id 进 dump。
- 处置：**已修**。AC-16 收窄为「**闭包提取**不再手写 agent 节点 walker，改调 `extractWorkflowAgentRefs`」，
  renderer 保留，并用行为测试锁 `agentId → agentRef`。

### [P2-e] AC 测试矩阵多处可 false-green

- 复核：**证实**，逐条属实。要点：AC-2 端到端只测 agent（其余五类接线坏掉仍绿）；AC-3 只测成功态终值
  （把清单写进第二个事务照样绿）；AC-4 只比字节（重复执行但返回新 receipt 仍可能绿）；AC-5 不测跨 dump /
  cap / 高水位；AC-8b 漏谱系分叉且未规定「从已退根 O 再 copy 必须先合法 remount+dump」；AC-9 只调
  `buildIntentDump`、不证明整轮正常收尾；AC-11 直接喂去名 note，抓不到 turnEngine 忘记传参；AC-14 见
  P2-b；AC-17 未锁「两处守卫各断言一次」。
- 处置：**已修**，按上述缺口逐条改写 design §8。

### [P3] 锚点 stale 与过度概括

- 复核：**证实**，其中一条比路 1 的 F2 更重要：design §8.7 称既有测试
  `rfc234-intent-routes.test.ts:348`「只断言初始清单，不受影响」，实际该用例会等首轮结束并断言
  `detail: true`（`:370-394`）——本 RFC 改 dump 装配后**它就是受影响面**，不能按「不受影响」放过。
- 其余：`dumpBuilder.ts:266-272` 实为 capped inventory handle 分配（真正的 summary 入清单在 `:481-493`）；
  §1 图注的 `:274` 实为 `handleFor`，详情循环自 `:277` 起，六类 fence 分散在 `:325/:359-366/:379/:392/:434/:466`；
  copy 丢弃 `manifestEntry` 的条件在 `resolveChangeset.ts:647`（非 `:646`）；`seen` 在 `dumpBuilder.ts:146`
  （非 `:145`）；`turnEngine` 真正 `.set({contextManifestJson})` 在 `:514`；前端文案在
  `intent.detail.tsx:466`（与路 1 F2 同）。
- 处置：**已修**，全部改为真实范围；并把 proposal §1.1 第 3 行的绝对表述改为「未作为根、且不可从任何
  现有根到达、且落在 inventory cap 内的 create 才是 `detail:false`」。

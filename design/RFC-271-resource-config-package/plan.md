# RFC-271 · 任务分解 v4

配套 `proposal.md` / `design.md` v4（统一资源表达 + 配置包；**intent 不迁移**，仅决策 27 的
能力扩张）。
每个批次自带测试，`bun run gate:local` 全绿才推。

## 批次 A · shared 基座：`ResourceRef` 域 codec + `ResourceBundle` 表达层

⚠️ **顺序**（R9-P2-1）：`ResourceRef` AST 与六个域 codec（原 T6a）**必须先于 T1**——
否则 T1 要么 import 尚不存在的东西、typecheck 不过，要么自建一套 parser、违反「不是第二套
parser」。批次 A′ 只保留 **scheduler / runtime wiring**（可独立回滚的那部分）。

- **T0a** `shared/src/ref/`：`ResourceRef` 归一化 AST + **六个域 wire codec**
  （见 design §1.1a/§1.1b'；含 `BundleAgentSkillRef` 的 `project:<name>` 分支）+
  `RefResolution` 五属性契约（`resolve` 返回 typed `Result`、不 throw）。
- **T0b** 六域正反例 + **两条字节级 round-trip**（managed / project 技能各一）。

- **T1** `shared/src/bundle/ref.ts`：`BundleRefSchema` **三形态**（`local:` / `external:` /
  **`name:<type>/<name>` late-bound**，第三种只许出现在 call 节点目标槽）+ 解析辅助。
- **T2** `shared/src/bundle/payload.ts`：六类 payload，**逐字段对照正式 create/snapshot
  schema 并产出一份最终 wire 字段表**（R4-P2-10：plugin 正式字段是 `options`、intent 版是
  `optionsJson`，两处规范打架会让 exporter/importer 各按一处实现 ⇒ 严格 parse 失败或选项丢失）（不是只列相对 `Intent*Payload` 的差异）。已知两个缺口必须补：agent 的
  `network:'allow'|'deny'`（`agent.ts:267`）、技能文件路径的 Unicode 支持（intent 版只许
  ASCII，正式写路径只要求相对不越界）。引用槽按**四个域**各取其一（agent 的 `skills` 用 `BundleAgentSkillRef`）；工作组人类成员补 `username`；
  技能文件改外部载体引用。
- **T3** `shared/src/bundle/op.ts`：`BUNDLE_OP_KINDS` + **12 分支严格 discriminated union**
  （design §1.3 已给规范代码，照抄）（create 必须有 slug、禁 target/expect；update 必须
  external target、禁 slug、**必须**带该类型 expect；kind 与 payload 绑定）+
  `BundleExpectTokenSchema`。⚠️ 缺这条约束时 `mcp-update` 不带 expect 能过 schema，而
  `commitMcpUpdateInTx` 只在 expect 非 undefined 时 CAS ⇒ 无 CAS 覆盖。
- **T4** `shared/src/bundle/bundle.ts`：`BundleSchema` + `assertBundleRefsClosed`
  （**拒重复 slug / 悬空引用 / 悬空 rootRef**）。⚠️ **`ops` 允许为空**（全 reuse 的包），
  引擎走 no-op 成功路径；`rootRef` 允许指向 external。闭包规模上限**显式披露**并配专门错误码。
- **T5** `shared/src/bundle/secrets.ts`：schema-valid 脱敏投影（design §4.2 的载体表），复用
  `SECRET_KEY_RE` / `looksHighEntropy` / `redactUrlForDump` 的判定逻辑，**不复用 dump 投影
  函数本体**。
- **T6** shared 五个测试文件；**`bundle-secrets.test.ts` 必须断言脱敏后仍过各自严格 schema**。

## 批次 A′ · 统一引用模型（决策 29）

依赖 A（含 T0a/T0b）。**独立成 commit**——它触及 scheduler 热路径，要能单独回滚。
本批次只做 **wiring**，AST 与 codec 已在批次 A 落地。

- ~~**T6a**~~ **已前移为 T0a/T0b**（R9-P2-1 依赖倒置）。原文保留供对照：`ResourceRef` **归一化 AST**（`id` / `name` / `selector` /
  `handle` / `local` / `external` / **`call` 复合** / **`project-skill`**）+ **六个域各自的
  wire codec**（不是共用一套字符串形态！`$new:` 与 `local:` 是同一 AST 的两种编码，
  `ImportSelectorRef` 的 `type` 必须保留）+ `RefResolution` 契约
  （域级 `freeze` / `aclAt` + 调用级 **`purpose` / `onMissing` / `failureOwner`**）。
  ⚠️ **agent 的 `skills` 槽用专属 codec** `BundleIdentityRef | ProjectSkillRef`；
  **T1 的三个 Bundle schema 是这些域 codec 的 alias / re-export，不是第二套 parser**。
  ⚠️ `resolve` 返回 typed `Result`、**不 throw**——各调用点自己映射错误码与 node_run 归属。
- **T6b** **机制 4 归位**：`IntentRefSchema` 改为 `IntentRef` 域的别名。
  ⚠️ **wire 零变更**——`res#<type>#<n>` 与 `$new:<slug>` 拼写不动，`INTENT.md` 不改。
  验收：intent 测试套**零改判**。
- **T6c** **机制 5 归位**：`ImportRefSelector` 改为 `ImportSelectorRef` 域的别名
  （agent.md 导入仍在用；YAML 工作流导入已由 C2 下线）。
- **T6d** **机制 1 归位**：`scheduler.ts` 的 `agentId` 裸读收成**一个** `RuntimeRef` resolver。
  实际读取点：主派发 `:5187`、`fanoutInnerAgentKey` `:6939-6944`（调用点 `:6997` / `:7224`）
  ——⚠️ v8 写的 `:7226` 是 `markWrapperTerminal`、不是读取点。
  **四处的失败归属实测不同，合并后必须逐条不变**：主 `agent-single` 返回
  `agent-identity-missing`/`agent-not-found`（`:5187-5200`）；wrapper-fanout 的 inner 在
  hydration 里**跳过**缺失 ref（`:6982-7002`）、shard source 为空时 wrapper 仍**成功**
  （`:7135-7149`）、非空才标 wrapper failed（`:7192-7242`）。
  ⚠️ 直接 throw 会被 `runScope`（`:1629-1654`）冒泡成**任务级** `"scheduler error"`
  （`:713-788`），原有 node/wrapper 归属整个丢掉。四处各留一条归属回归。
- **T6f** **机制 3 归位**：runner 的技能/MCP/插件/dependsOn 闭包组装改用 `RuntimeRef`。
  ⚠️ `agents.skills` 是判别联合——managed `{kind,skillId}` 走 `{k:'id'}`，**project
  `{kind,name}` 走新增的 `{k:'project-skill'}`**（无 DB row、无 ACL，runner 按 `p:<name>`
  去重并按名字透传 CLI：`scheduler.ts:9276-9290,9360-9382`）。不给它一个 AST 变体就等于
  在 runner 组装路径上留 special-case。
  ⚠️ `agentDeps` 的 `allowMissing` 是**调用级**差异（`agentDeps.ts:40-46`），走 `onMissing`
  而不是域级 `dangle`。
- **T6e** **机制 2 归位 + 决策 28 完整落地**（design §1.1c' / §1.1c''）：**统一走
  `resolveEdge(sourceWorkflowId, CallRef)`，五个消费者同源**——冻结生成、`scheduler.ts:2966-2968`
  主消费 ×2、`childClosureSubset`（要收 source id，调用点 `:3732/:3811/:3851` 已持有
  `frozen.id`）、**`detectCallCycles`（`workflowCalls.ts:88` 的 resolver 签名 `(name)` 必须
  改成收完整 CallRef）**、**validator 闭包装载**、**配置包导出器（第六个，本 RFC 自己写的
  ——见 design §1.1c'' 第 6 行，`purpose:'export'`）**。
  ⚠️ validator 那条按 design §1.1c''' 的**三语境表**做：保存期是 advisory（保存者 Actor +
  live）、根启动「解析冻结一次再用同一份校验」、子启动直接用继承 closure 不重查 live。回归含「同名双 id
  其中一支成环」与「同名双 id 端口不同」。原文：`freezeCallClosure` 成为
  `CallRef` 域的 resolver；冻结闭包改 **source-scoped key**（`${sourceWorkflowId}#${nodeId}`
  ——**不能只用 nodeId**，节点 id 只在单份 definition 内唯一）；**三个消费者**
  （`scheduler.ts:2966-2968` ×2 + **`childClosureSubset` `closure.ts:103-131`**）全部双读
  v1/v2；grants+row+members 同一 `dbTxSync` 快照。
- **T6f2** 三条语境回归（R10-P2-N2 点名）：①保存者与启动者不同 → 保存期 advisory 结果与
  启动绑定可以不同且不报错；②根启动**只解析一次**（同一 frozen result 既校验又执行）；
  ③父冻结 G1 后 live 改成 G2 → 子任务仍校验 **G1**（禁止重查 live）。
- **T6g** 测试：六个域的正反例（跨域形态必须 parse 失败）、五条解析契约属性、
  **wire 零变更的字节级断言**（`$new:` / `res#type#n` / selector `type` / 裸 ULID 逐字不变）、
  四处 scheduler 失败归属各一条、v1/v2 双读 × 三消费者、跨 definition 同名 nodeId 不覆盖。

## 批次 B · `BundleApply` 引擎（backend）

**开工前置已完成**：`invariants.md` 是逐条读源码核实的 **14 条**清单（**11 条归引擎**，
含锚点与原文引用）。验收清单**逐条枚举 I1–I14**，不要按「12 条」生成矩阵（会漏掉 I13 的
big-tx 共处与 I14 的 record-before-act）。
批次 B 落地后按其末尾的对照表**逐条打勾**——丢一条就是回归。
⚠️ 该表当场查出：11 条归引擎的不变量里，设计初稿只有 1 条完整；I1（scope 串行）、
I3（replay 三态）、I8（post-commit 绝不补偿）此前完全没写。

- **T7** 迁移 + 新表 `resource_bundle_applies`（泛化自 `intent_apply_journal`）。
- **T8** `services/bundle/provider.ts`：`BundleApplyProvider` 接口。
- **T9** `services/bundle/apply.ts`：五段生命周期，从 `applyChangeset.ts` 搬运并泛化。
- **T10** **`skill-update` 四段拆分**（stage / commitInTx / publishStaged / **abort**）：`stageSkillVersion` / `commitSkillVersionInTx` /
  `publishStagedSkillVersion` + **`abortStagedSkillVersion`**（pre-commit 补偿，引擎没有它
  就只能复制状态机内部逻辑）；既有 `commitSkillVersion` 退化为顺序组合，**保留 `noop` 分支**。
  ⚠️ **`noop` 仍是 fence-only PreparedOp，照样进 big tx 重验四道 token**，只跳过版本写入与
  publish——跳过整个 op 会破坏整包基线（R5-P1-C）。
  ⚠️ **`unmarkSkillBootVerified` 不在 publish 段里**——现有实现在 DB commit 返回后立刻
  unmark（`skillVersion.ts:601`）；批量场景必须在 big tx 返回后、任何逐项 publish 之前
  **一次性 unmark 全部已提交技能**。
  ⚠️ `skill_versions.source` 枚举现为 `initial/editor/fusion/restore`——**包导入的 update
  复用 `editor` 还是扩枚举，批次 B 开工前必须定**；扩则 design §7 要勘误。
  ⚠️ **发布段是 `swapInStaged` 从 staging 发布 live，不是 rename `versions/vN` 候选目录**
  ——后者是永久权威快照，`reconcileSkillLiveFiles()` 与恢复 handler 都依赖它。五相
  （`fs-staged`→`fs-versioned`→`db-committed`→`fs-published`→`done`）与「pre-commit 失败保留
  op 作恢复 oracle、post-commit 失败绝不回滚」逐条保持。
- **T11** **插件 record-before-act**：调用方**预铸** generation/op id，**先把精确路径写进
  journal artifacts**，再调 `installPlugin(..., {generationId})`。⚠️ 只把目录挂到抛出的错误
  上不够——进程可能在 mkdir 之后、返回/抛错之前被 SIGKILL。
- **T12** **最终事务内 owner 断言**（design §5.4）：对每个 update 目标断言
  `ownerUserId === actor.user.id`。引擎层实现，intent 侧同样受益。
- **T12b** **dependency planner + pending seams**：`pendingBundleIds` / `pendingAgentNames`
  让 preflight 接受同 bundle 未落库目标；按类型 + agent `dependsOn` 排序；agent 互相
  `dependsOn` 的闭环给出确定拒绝点。
- **T13** `rfc271-bundle-engine.test.ts` + `rfc271-bundle-owner-gate.test.ts` +
  `rfc271-skill-update.test.ts`。

## 批次 C · intent 能力扩张（决策 27）

本 RFC **不迁移 intent 主流程**（决策 26），但有**一处显式例外**：skill 半边是真「顺手」
（调四段内核即可）；**plugin 半边要动 intent 的 prestage 循环与收敛器**。
⚠️ **决策 28 不在本批次**——它完整归 A′ 的 T6e（见回滚段）。

- **T14** 解开 `copyOnlyTargetsFor`（`applyChangeset.ts:135`）里 skill/plugin 的
  `'in-place update for this resource type is not supported yet'` 分支；skill 侧改为调用
  四段内核。
- **T15** ⚠️ **`ownerUserId` 判据一字不动**——他人拥有的资源仍强制 copy；既有 copy 语义
  （slot derivation / copy rewiring / finalName / receipt `fromCopy`）逐条保持。
- **T16** `rfc271-intent-skill-update.test.ts`：**双向锁**——自己的技能原地更新成功、
  他人的技能仍强制 copy；**显式传 `expectedOwnerUserId`** 的 owner-transfer 409 用例。
- **T17** **plugin 半边的完整链路**（决策 27「两个都开」，决策 26 的显式例外）：
  `PreparedOp` 新 kind → **先用 session manifest 的 `configHash` 验原始基线**（且必须从
  **同一次**读到的完整 row 投影计算，两次读会让漏洞原样复现）→ 完整 row 捕获 → spec 变了才预安装（**record-before-act**：预铸
  generation id、先写 artifact 再 `installPlugin`）→ `commitPluginPublishInTx` → 精确路径
  逆序补偿 → **收敛器的 artifact 分支要能处理它**（现有实现对 plugin artifact 什么也不做）。
  ⚠️ 改判范围**显式限定**为 prestage 循环 / artifact / 收敛 / `copyOnlyTargetsFor` 四处，
  其余零改判。

- ~~**T17b**~~ **已移入批次 A′ 的 T6e**（决策 28 属 `CallRef` resolver；留在批次 C 会破坏
  「scheduler 热路径独立可回滚」）。

> 批次 C 独立成 commit 推送并跑完 CI，与包的工作解耦。

## 批次 D · 配置包导出

- **T18** `util/zip.ts` 的 `encodeZip`（store-only，与 `decodeZip` round-trip 单测）。
- **T19** `services/resourcePackage/closure.ts`：批量装载器 + `walkClosure`。
- **T20** **name 域解析与 `freezeCallClosure` 逐字一致**（AC-7c：cache 优先、其次最老可见），
  且「零匹配」与「全不可见」逐字节同形（AC-7b）。
- **T21** `serialize.ts`：闭包 → `ResourceBundle`（分配 local slug）+ requirements 五段 +
  builtins + secrets 索引 + `ambiguousCallRefs`。
- **T22** **三道门**：行级可见性（含传递）/ 分轴特权 / **同名重复**（原第四道「体积」已随 AC-11 改判取消——用户拍板技能整棵树进包、不设上限）
  （闭包内两个同 `(类型,名字)` 资源 → 422 并点名各自被谁引用；包不带 owner，这种包
  语义上不可表示）。
  ⚠️ **不要**加第四道类型级 `*:read` 门——AC-7d 是反向锁。
- **T23** `manifest.yaml` + `README.md`（中英双段）生成器。
- **T24** `rfc271-export-gates.test.ts` + `package-closure` 矩阵。

## 批次 E · 配置包导入

- **T25** `parse.ts`：解 zip（复用 `decodeZip` 归一化）+ manifest 校验 + 防夹带 +
  `formatVersion` 判定。
- **T26** `preview.ts`：逐条匹配（`ownMatches[]` 可多个）+ 动作可选性 + 建议名 + 权限缺口 +
  密钥字段 + 稳定 `importId` + **`previewToken`** + 内置件 + 人类席位。
  ⚠️ **`previewToken` 要签死整套基线**（`importId‖actor‖packageDigest‖exp‖
canonical(每条目的候选 id / 各候选 expect / 允许动作)），**不是只签 digest**——只签 digest
时客户端换掉某条的 `expect` 仍能通过（R5-P1-A）。
- **T27** `commit.ts`：**① 验签 → ② duplicate lookup（命中走 I3 三态、不查 exp）→ ③ 仅首次
  claim 查 exp**（顺序是承重的：先查 exp 会让「成功但响应丢失、过期后重试」进不了 replay）
  → 断言用户提交的 `(target, expect)` **是该条目签名基线里的一对** → 服务端重算
  `allowedActions` → 翻译成 `ResourceBundle`（**含每个 reuse 目标的 `selectedExternalFence`**）
  → 调引擎。`reuse` 不产 op / `new` → create / `overwrite` →
  update+expect；**指向 reuse 与 overwrite 项的引用都要改写成 `external:`**（v3 只写了
  reuse 那一半）。
- **T28** package `BundleApplyProvider`（`resolveExternal` = 决策表；`readSkillFile` = 从 zip 取；
  **`revalidateInTx` 必须实现**——在 big tx 内逐条复核 `selectedExternalFence`，`ops` 为空时
  也要走。⚠️ 「provider 钩子全部留空」的说法已作废：全 reuse 的包否则完全免检）。
- **T29** `rfc271-import-preview.test.ts` + `rfc271-import-commit.test.ts` +
  `rfc271-package-antitamper.test.ts`。

## 批次 F · 路由与 client

- **T30** 六条 `GET /api/{类}/:id/export-package`，**六类都接各自的完整 exact-revision token**
  （工作流/工作组 `expectedVersion`；代理 `expectedUpdatedAt` **+ `expectedAclRevision`**；
  MCP/插件 `expectedConfigHash`；技能 `contentVersion` **+ `metaRevision`**）。
- **T31** `POST /api/resource-packages/preview` + `/commit`，`tokenAccess:'allow'`，
  **路由门只做身份准入**——资源类型权限按包内实际条目动态计算（AC-30c）。挂六类 `*:read`
  的 AND 会与逐条预检自相矛盾。
- **T32** 错误码族登记 + `route-error-code-coverage` 点名。
  ⚠️ 新文件先 `git add -N` 再跑门禁。
- **T33** `client.ts` 八个方法 + `rfc271-routes.test.ts`。

## 批次 G · 前端

- **T34** `lib/resource-package-download.ts`（抽出 `safeDownloadBaseName`）。
- **T35** 六类详情/编辑页「更多操作」导出入口（工作流那条原地改名）。
- **T36** `components/ResourcePackageImportDialog.tsx`（`<Dialog size="full">` + `.segmented`
  - `<Select>` + `<Field>/<TextInput>` + `<StatusChip>`，零自写 chrome）。
- **T37** 六类列表页导入入口 + 统一入口 + 类型不符跳转 + 导入报告视图。
- **T38** 中英双语 i18n（⚠️ i18n 值里禁字面 `**`）。
- **T39** 前端两个测试文件 + **视觉对齐自查**（与 `/agents`、`/workflows`、`/repos`、
  `/settings` side-by-side）。

## 批次 H · CLI

- **T40** `cli/package.ts`：两条命令，**都必须 `--as-user`** 并构造与 HTTP 同构的 `Actor`；
  导出支持 **`--id`**（同 owner 可有两个同名工作流，`--type --name` 选不中）。
- **T41** `--plan` / `--apply` 决策文件 schema；`--on-conflict`（与 `--plan` 互斥）。
- **T42** `cli/start.ts` 注册 + `--help`（写明 break-glass 边界）+ `rfc271-cli.test.ts`。

## 批次 I · 能力下线（C1–C6）

**最后做**，前面全绿后才拆旧的。

- **T43** 删两条旧路由 + `services/workflow.yaml.ts` 中只服务它们的部分
  （⚠️ `workflowDefinitionToSelectors` / `stripCallWorkflowNodeIds` 保留）。
- **T44** 删 `workflow-draft-export.ts` 的本地草稿路径（C3）+ 编辑页救援态按钮。
- **T45** 删 `WorkflowImportDialog.tsx`（C2）。
- **T46** `rfc271-capability-removal.test.ts` + 显式改判既有断言（design §9 表格六项，
  **intent 测试套改判限定四处、其余零改判**）。

## 批次 J · 文档

- **T47** `docs/resource-bundles.md`：表达层规范（BundleRef / payload / op / 引擎生命周期 /
  Provider 契约）。
- **T48** `docs/resource-packages.md`：包格式、manifest 字段、导入流程与收敛语义、CLI 用法、
  「技能文件树里的密钥属于作者责任」、失败原因对照表。
- **T49** `design/plan.md` 索引改 Done；`STATE.md` 加条目；勘误 RFC-234/199/223/243/270 中
  受影响的表述。
- **T50** `docs/dev-gotchas.md` 沉淀通用教训（**已于 `7603732a` 提前落地**，含第四条
  「写路径的权限门可能只在路由层」）：
  ① **多资源批量落地前先找仓里既成的 bundle / pre-stage / commit 内核**——本 RFC 四轮设计门
  里至少五条 findings 同此根因；
  ② **给模型看的 dump 投影 ≠ 可导入投影**——`projectMcpForDump` 输出的 `oauth` 是字符串，
  直接复用会让产物过不了自己的 schema；
  ③ **泛化一个既有引擎前，先把它的承重不变量列成清单**——凭注释和函数签名推断会漏，
  `applyChangeset.ts` 实际有 ~13 条而不是注释里显眼的那 6 条。

## PR / commit 拆分

| #   | 内容                          | 独立可绿                                              |
| --- | ----------------------------- | ----------------------------------------------------- |
| 1   | 批次 A（表达层）              | ✅ 纯 shared                                          |
| 1b  | **批次 A′（统一引用模型）**   | ✅ **独立 commit，触及 scheduler 热路径需单独可回滚** |
| 2   | 批次 B（引擎 + 新表）         | ✅ 引擎有自己的测试，尚无消费者                       |
| 3   | **批次 C（intent 能力扩张）** | ✅ **单独推并跑完 CI**                                |
| 4   | 批次 D + F 导出半边           | ✅                                                    |
| 5   | 批次 E + F 导入半边 + G + H   | ✅                                                    |
| 6   | 批次 I + J                    | ✅                                                    |

## 验收清单

> **收尾核实（2026-08-09）**：勾选依据写在每条后面。前两条改成**机械核查**，由
> `packages/backend/tests/rfc271-ac-coverage.test.ts` 每次跑测试时重新验证——人工勾
> 清单的问题在收尾时实测到了：62 条 AC 里 30 条其实没被点名（行为有覆盖，但测试标题
> 用的是任务号 `T14` 或行为描述），清单却可以被勾成绿的。

- [x] AC-B1…B6 + AC-K1/K2 + AC-1…AC-34 逐条有测试点名 —— **62 条全部点名**，由
      `rfc271-ac-coverage.test.ts` 从文档抽取真值后逐条核查（不手抄列表，新增 AC 自动纳入）。
      补齐时抓到一条假绿：`AC-B3` 被 `AC-B3b` 前缀顶替，故守卫用编号 + 非字母数字边界匹配。
- [x] **I1–I14 逐条枚举**（不是「12 条」）—— 同一条守卫按 `invariants.md` 对照表的**归属列**
      抽取：归引擎的 11 条逐条要求点名，`intent 特有` 的 I10–I12 本 RFC 不需要故排除。
      核实时发现 **I7 / I13 只有源码事实、没有测试**（对照表标着「已验证」，靠的是读代码），
      已补 4 条注入式测试并做**反向验证**：把 `finalizeInTx` 移出事务，两条 I7 立刻变红。
- [x] **AC-24d：伪造 `previewToken`（换文件+换摘要）被拒** —— `rfc271-import-preview.test.ts`
- [x] **§1.1b lowering：external 目标同时落 name + id，`name:` 只落 name 不落 cache** ——
      `rfc271-impl-gate-fixes.test.ts`（实现门 P2-3：只扫 update target 会让纯 reuse 的包必挂）
- [x] **selectedExternalFence：reuse 目标在 big tx 内复核，`ops=[]` 也要走** ——
      `rfc271-import-commit.test.ts`「④ reuse 也要复核」
- [x] **冻结闭包按节点键控 + v1 name-keyed 存量仍可读** —— `rfc271-call-edge-closure.test.ts`
- [x] **导出拒绝同名重复资源** —— `rfc271-export-gates.test.ts`「④ 同名重复门」
- [x] **AC-K1/K2：自己的 skill/plugin 可原地更新、他人的仍强制 copy** ——
      `rfc271-intent-skill-plugin-update.test.ts` T14/T15 双向锁
- [x] **AC-15b：伪造 overwrite 他人资源被最终事务拒绝** —— `rfc271-bundle-engine.test.ts` + `rfc271-mcp-owner-fence.test.ts`（`commitMcpUpdateInTx` 的 owner 围栏）
- [x] AC-6：六类文档脱敏后仍过各自严格 schema —— `rfc271-serialize.test.ts` +
      `rfc271-bundle-secrets.test.ts`
- [x] AC-7b：零匹配 vs 全不可见逐字节相同 —— `rfc271-zip-roundtrip.test.ts`
- [x] AC-7c：与 `freezeCallClosure` 逐字一致（cache 优先）—— `rfc271-export-gates.test.ts`
- [x] AC-7d：反向锁（可见但缺类型权限点 → 导出成功）—— `rfc271-export-gates.test.ts`
- [x] AC-20：journal 各 phase 边界注入中断 + 重启收敛到二态之一 —— `rfc271-bundle-engine.test.ts`
      「I9 · 收敛」；实现门补上了**生产调用点**（此前收敛器只有定义，`cli/start.ts` 没接）
- [x] AC-25b：技能覆盖失败后两个技能都没被改 —— `rfc271-skill-version-split.test.ts`「② abort」
- [x] `bun run gate:local` 全绿；推后按 exact SHA 查 CI —— gate 6m13s 全绿
      （backend 4 分片 9702 pass / frontend 全过）；CI 与 `visual-regression-nightly` 在
      `52b1400e` 均 success
- [x] Codex 实现门跑一次并修 findings —— 报 13 条（6×P1 + 7×P2），**逐条核实全部属实、全部已修**，
      锁在 `rfc271-impl-gate-fixes.test.ts` + `rfc271-roundtrip.test.ts`（真 DB/真 FS 跨实例往返，
      是 4 条 P1 的根因防护）

## 风险与回滚

| 风险                               | 缓解                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 决策 27 误伤 intent 既有 copy 语义 | AC-K2 双向锁；`ownerUserId` 判据一字不动；独立 commit 先推                                                     |
| 泛化丢掉某条既有不变量             | 开工前列不变量清单，泛化后逐条对照 + 点名测试                                                                  |
| **决策 29 动了 scheduler 热路径**  | 批次 A′ 独立 commit；wire 零变更（既有拼写全保留）⇒ intent/存量 definition 零改判；六域正反例 + 字节级拼写断言 |
| ~~新旧 journal 并存~~              | **随 intent 不迁移而消失**：`intent_apply_journal` 一字不动                                                    |
| `skill-update` 拆分回归            | 既有 `commitSkillVersion` 退化为四段顺序组合、保留 `noop`                                                      |
| 盘子过大                           | 六个独立可绿的 commit                                                                                          |
| C1/C2/C6 打断既有自动化            | 已逐条呈用户确认；发布说明点名                                                                                 |

**回滚**：批次 I 之前任何时点可停（新路径纯增量）。批次 C 若出问题回滚该 commit 即可——
但注意它**不只动一个分支**：含 plugin 的 prestage / artifact / 收敛三处。
⚠️ **决策 28（C7 行为变更）不在批次 C**——它在 A′ 的 T6e。回滚批次 C **不会**撤销 C7。

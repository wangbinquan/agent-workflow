# RFC-370：隔离工作区的完整操作范围

本批属于已批准 A3／A4。先固定原调用、合同和行为，独立设计门通过后实施；不包含 CS 生产 adapter，不关闭完整 A-G。工作区上传 SOURCE24 与其 canonical 发布保持独立。

## 实际消费者及归属

`services/nodeIsolation.ts` 当前把 generation 选择、创建／重建、final snapshot、三方 merge、分片旧增量撤销、清理、Agent 冲突工作区与人工完成放在一起。创建的 Task 效果收据已在 `services/isolatedAgentRun.ts:70-154`；其 merge／持久化在同文件 `157-507`。唯一仍嵌在物理文件的 Task observer 是 `nodeIsolation.ts:1499-1588` 的 discard。

真正消费者是 `task-execution/composition/nodeMechanics.ts` 的普通 Agent、script、call、Workgroup host，`wrapperMechanics.ts` 的 wrapper／fan-out，以及 `executionMergeRecovery.ts` 的两条 replay。现有 `application/ports/wrapperWorkspace.ts` 的 opaque scene 和 open／captureGitEntry／changedFiles／merge 保持，内部操作改接所选 SC scope。不能用一层可选 runFn、Git argv 或改名后的 cwd 代替这些操作。

Task 拥有 run 行、artifact roster、write semaphore、effect receipt、CAS、keep/discard 裁决和 conflict Agent 调用。SC 拥有 Git／worktree／submodule pool／anchor／ref 的机制和工作区操作事实。旧 `repoRelForcedPaths` 是纯相对目录映射：将同一实现归入 SC domain，TE 旧准确 public query 继续转导；不从 SC 反向导入 TE。discard 的 observer shell 移入 TE，原物理 body 留 SC local；SC 不读取 Task 当前 context，也不拥有 Task SQL。

## 中立完整合同

SC `application/ports/isolationWorkspace.ts` 定义 `IsolationWorkspaceFactory.bind(binding)` 和完整 `IsolationWorkspaceScope`。binding 包含 taskId、opaque storageRootRef、有序 canonical repositories（repositoryRef、workspaceRef、logical mount、baseBranch）及可选 generation。引用由 adapter 解释；业务不以 basename／join／exists 解析引用。factory 选择和构造无 IO，只允许 undefined 选择完整本机默认；显式 null／不完整 factory 或 scope 明确报选择错误。同步和 Promise 结果均允许，prototype／private／frozen receiver 始终在原对象上调用。

scope 有以下完整操作，不做逐方法 fallback：

| 操作                    | 输入及结果                                                                                       | 原 native 行为                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `recoverKey`            | 已持久化 workspaceRef、原 rowId → isolation key                                                  | 原 isoKeyOf 的空值／旧列回退；引用解析只在 adapter                                                                 |
| `chooseGeneration`      | baseKey → key／generation                                                                        | 原回收、generation 上限与 blocked 错误                                                                             |
| `create`                | key、真实 dbNodeRunId、forced container-relative paths → descriptor                              | 原 canonical 存在性检查、单／多仓、非 Git passthrough、base／submodule snapshot                                    |
| `restore`               | key、真实 dbNodeRunId、持久化 bases／heads／submodule topology／forced paths → descriptor        | 原 rebuild，不要求 iso 物理目录仍存在                                                                              |
| `canonicalFacts`        | `heads` 或 `submodule-presence` 目的 → 对应有序事实                                              | replay 原逐仓 rev-parse 与 manifest 检查；两个目的分别在原时点调用，不新增另一目的的 IO，也不从另一 adapter 取事实 |
| `snapshot`              | descriptor、附加 forced paths → trees／更新后的 topology                                         | 原 final 全状态快照、forced roster、pool／anchor 更新                                                              |
| `merge`                 | descriptor、trees、当前 forced paths、原 sub-conflict callback → clean／conflicts／更新 topology | 原 canonical snapshot／三方 merge／立即 sub-resolution／pending set                                                |
| `undoShard`             | descriptor、旧 trees                                                                             | 原 reverse merge、原退化结果和日志                                                                                 |
| `discard`               | descriptor、可选 canonical write-window callback、进度 callback → completion                     | 原 repo 顺序、reclaim ladder、delete refs、anchor handoff、drop pools 与 partialFailures                           |
| `resolveConflict`       | conflict descriptor、containerRef、Agent callback → resolved／unresolved／resolve workspaceRef   | 原 resolve-iso、manifest／prompt、Agent 后自检、snapshot／materialize／cleanup                                     |
| `completeHumanConflict` | descriptor、持久化 trees → allResolved／unresolved repos                                         | 原缺 tree／pending submodule 判据、缺 resolve-iso 的 re-probe 与三方完成                                           |

descriptor 只包含 isolationRef／key／真实 dbNodeRunId、workspaceRef、passthrough 与有序 repositories。每仓保留逻辑 mount、repositoryRef／canonicalRef／workspaceRef、baseBranch／baseSnapshot／taskBaseHead、forced relative paths、submodule bases、opaque poolRefs 和 pending sub-resolutions。Git commit／tree／ref 值保留其原业务含义；不公开 process、Stats、Buffer、宿主 appHome／cwd 字段或整份任意 JSON。conflict descriptor 保留原 merge tree、原始 conflict output、paths 和必要仓库／workspace references，manifest 继续原类型和规则。

选定 scope 一次贯穿同一 Task 的 create、snapshot、merge、resolve、discard。restore 后可获得同一 factory 的新 scope，持久化引用足以重建；不能只靠 WeakMap、内存 symbol 或原进程中的 native handle 恢复。请求中的真实 rowId 与 generation key 始终分开，恢复代码也显式传真实 dbNodeRunId。

## 旧类型、持久化和 receiver 的衔接

旧 `IsoRepo`／`IsoHandle`／`CanonRepo`、错误类、常量、纯 native path helper 与直接 helper API 完整保留在独立 SC local／platform native 兼容面，原 service 准确转导。原未传 factory 的直接调用保持原同步／异步返回与类型；旧结构的 Map／数组及 topology 可变行为保持。本机默认不得因为包装而改变原错误类 identity 或 `instanceof`。

TE composition 保留既有 `TaskMechanicsState` 的私有兼容视图，逐字段投影中立 descriptor 的 refs 和 topology，并持有实际 scope；不把此视图新增到 application/public。旧 node/wrapper 的历史列名、JSON keys、digest 字段、空值、顺序和 payload 保留；本机投影继续原位置字符串，selected 的持久化值是该 adapter 提供的可恢复 reference。新 scope 不提供“转换回本机路径”的 escape hatch。

所有本批 create／rebuild／snapshot／merge／undo／discard／conflict／human completion 真实调用改经 retained scope；回读 head／manifest 改由 canonicalFacts。旧 application wrapper port 和其 scene 继续不透明。只用于兼容传递的字段不做 native IO；runner／script 材料和执行消费仍由 A5／A6 的完整合同负责，在其接线完成前不宣称可接 CS。遗留 Task HTTP repair 的 native path helper 和其余 Git inspection／commit／delivery 有各自剩余切面，不借本批有限 PASS 宣称完整 A4。

## 原锁和收据顺序

1. 创建的 artifact roster 在原 write queue 外读取；进入原 write semaphore 后 chooseGeneration，随后原 effect.beforeAct，再 create；create ACK 和原 effect.succeed ACK 后返回，原 fail 和任意 throw 值保持。
2. final snapshot 在 private iso 中完成后才 persist node trees/topology；merge 的原 canonical write window 内 prepare effect、merge、原 sub-conflict callback、CAS／pending topology，最后 effect.succeed。replay supplied trees 跳过 snapshot 和重复 persist。
3. 每次 merge 前保留原 fresh artifact roster 与 extra union；adapter 收到同一 forced paths。不得复用创建时旧 roster。keep/discard 与 merge-threw 裁决留各旧消费点。
4. discard 的 passthrough 先返回，不创建 effect；原 current Task context 和真实 dbNodeRunId 在 TE shell 读取。beforeAct 仍在原 try 外。native body 的 partialFailures 进度在每次旧增量处同步通知 shell；该内部 callback 只赋值，返回 void，不能延迟原 native body。selected adapter 同样须在结算或拒绝前交付已知进度；原 succeed/fail 的 repoCount、partialFailures 及任意原错误值和优先级不变，不能用包装异常代替原拒绝。
5. discard 的 canonical write callback 只用于旧非空 pool handoff，仍排入原 write queue；普通 reclaim／ref delete 不扩大原 lock window。Agent conflict resolution 仍使用原注入 callback，不进入第二份 node pool。
6. human completion 和 replay 仍在原 phase／write window，完成操作 ACK 后才原 CAS，再 discard ACK；不重跑 Agent，不因 iso 目录缺失把已 pin tree 判成丢失。

## 真根与功能验证

CLI／PG／SQLite／standalone HTTP 各选择同一 raw factory，贯穿 provider runtime、Task engine options、节点／wrapper／子 Task 的目的 binding 与 merge replay。child inheritance registry 明确为 bootstrap 重供给项，不序列化进 run-config，也不借父 Task scope。旧已装配 operations 的优先级保持。

原 RFC130／188／193／210／356／369 的实际 isolation、fan-out、强制归档、submodule、代际自愈、replay 和错误断言／名称／预算保持；源码地址 oracle 只跟随真实迁位，不扩大忽略列表或改变判据。保留原所有 Task SQL／CAS 子树、hash 输入与顺序，完整 native 函数按 AST／字节作机械迁移证明。

新增完整 memory factory 以不同于宿主路径的 refs 覆盖 held bind／choose／create／snapshot／merge／resolve／discard ACK，prototype/private/frozen receiver、显式不完整选择、任意拒绝、generation 与真实 rowId 区分；真实 Task node／wrapper／fan-out／replay 证明所选 scope 贯穿且不存在重复默认操作。双 provider 收据夹具验证 write queue／effect／CAS 顺序；持久化 descriptor 在新 factory instance／新 scope 下恢复，缺目录仍沿 pin tree replay。native direct helper 的 mutable topology、错误 identity、passthrough 与旧同步 rebuild 回归保留。

本机只允许目标 format/lint、纯 AST／byte／JSON 证明和一次原 scoped canonical。正式功能以发布候选的 exact-SHA hosted 双 OS／双 provider CI 为准。独立设计、源码与 canonical 门各自限定候选，不重开已通过的工作区上传门；完整 A1～A8／A-G 和 CS B/M0～M4 继续。

## R2：wrapper 事实、canonical 视图及逐仓撤销

首轮 DESIGN `2837773fd65aed5d8d70f6bd1351de5d372f4b57ec358eb6d93bbd34a8d46cd6` 的三项 P2 FAIL 原样保留。以下修订替代上文“每 Task 一次 scope”、`canonicalFacts` 和 `undoShard` 的不足表述；其余操作、Task／SC 归属、原政策、锁／收据／任意错误及 native 兼容要求不变。

工厂由根选择一次，同一完整 factory receiver 沿原 Task／wrapper／child 装配传递。scope 按 **effective canonical scene** 绑定：taskId、storageRootRef 及当前 `state.repos` 的有序 canonical refs／mounts／baseBranch 确定该 scene。一个 handle 的 choose／create／snapshot／merge／resolve／discard 全生命周期留在同一 scope。nested wrapper 的 `innerState` 替换 repos／scopeRoot 后必须得到新 scene／scope，canonical refs 是外层 handle 的 workspace refs；不能复用最外 Task 的 canonical，也不能按 taskId 做全局 scope cache。passthrough 沿原 scene，独立 child Task 由 bootstrap 重新供给同一 selected factory，再按子任务 scene 绑定；factory 不随 run-config 序列化。restart restore 同样用当前 scene 加持久化引用重建，内存映射不能替代持久化。

完整 scope 最终共 **14 方法**：原 recoverKey／chooseGeneration／create／restore／snapshot／merge／discard／resolveConflict／completeHumanConflict 保留；undoShard 按下述精确输入；原 canonicalFacts 替换为四个事实方法。generation choice 明确保留原 key、generation、reclaimed 三字段。四个事实操作只消费本 scene 或其 handle 提供的 opaque workspaceRef，结果为平台中立值：

| 操作                | 输入                              | 结果与真实 native 操作                                                                                    |
| ------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `head`              | workspaceRef                      | 原 rev-parse HEAD 的完整 stdout／stderr／exitCode；wrapper 仍检查 exitCode，replay 仍按原规则 trim stdout |
| `submodulePresence` | workspaceRef                      | boolean；原 `.gitmodules` 存在性由 adapter 判断，调用时点保持                                             |
| `changedFiles`      | workspaceRef、baseline commit     | 原有序 string[]；native 调原 gitChangedFiles，保留 tracked／untracked／submodule 展开及原失败结果         |
| `blobHashes`        | workspaceRef、有序 relative paths | 原完整 path→blob hash／deleted sentinel 映射；native 调原 gitBlobHashes，保留 chunk、顺序和任意拒绝       |

wrapper 的 diffableRepos 仍按原 passthrough／isolation scene 和 mount 顺序投影这些 refs。captureGitEntry 在原 write semaphore 内逐仓 head→可选 capturePreDirty，primaryMount／baseline map／preDirty map 的规则不变。captureGitPreDirty 的两个 cap（4096 entries、256 KiB JSON）和空集／异常／超限退化、warn、resume 不重采样都留原 TE 政策；只把原效果调用换为同一 scope 的 changedFiles／blobHashes，不移动限制或把 hash 改成只看 path。final changedFiles 同样在原 write window 内逐仓取 all→只取原 preDirty 候选的 post hashes→按完整 hash 差异减集→原 mount prefix；同一路径被 inner 改写仍必须报告。所有事实 ACK 完成后才原投影与持久化，不新增另一目的的 IO、额外 snapshot 或本机 fallback。

`undoShard` 是逐仓操作，输入必须含该仓的 workspaceRef、`priorNodeCommit: string | undefined`、`priorBaseCommit: string | undefined`、当前 `forcedRepoRelativePaths: readonly string[] | undefined`，结果为 boolean。两个 prior 角色来自原 `priorShardUndo.node[logicalMount]`／`.base[logicalMount]`，不能以 fresh descriptor.baseSnapshot 替代。native 逐字复用原 undoPriorShardDeltaInIso 的缺任一 prior→false、非 Git→false、pruned→false、reverse conflict→false、gitlink 不可用→false 与成功→true；未被原 native body 吞掉的任意异常仍在原 shard catch 记录并走 superimposition。新增 selected 用例分别覆盖两 prior 不同、缺每一 prior、逐仓混合 true／false 与原 catch。

原 authority 守卫与源码 oracle 跟随真实拆层：`rfc328-architecture-guards.test.ts` 的三个 isolation effect 注册只迁到真实 TE observer 函数及其 SC scope act callee，原 observer／negative fixture／闭合判据保持，不留旧空壳、不扩大豁免或改变 scanner。`rfc356-iso-key-generations.test.ts` 的 observer DB identity 断言核 TE shell，deleteIsoRefs／物理 key／分隔符／container 判空断言核真实 native body；原每条断言、名称及预算保持，必要时同一用例分别读取两个实际 owner。旧 RFC188 7 个 create／7 个 merge／6 个 failed disposition 的站点结构保持；只更新真正迁位的文件定位。

新增 selected wrapper 用例覆盖真实 held head／changedFiles／blobHashes ACK、同 path 同 hash 被减去／新 hash 被保留、deleted sentinel、cap 退化和 mount 顺序。至少一条真实 wrapper→inner wrapper／node 路径断言 inner create 使用 outer isolation 的 canonical refs，内层 merge 先落外层、外层 merge 才落 Task canonical；普通根 Task、fan-out shard 与 restart replay 分别核同一 factory、各 scene 的 retained scope。正式运行仍由本批 exact-SHA hosted CI 判断；有限 R2 设计 PASS 不等于 SOURCE、完整 A4／A-G 或 CS 部署。

## R3：拒绝值不能让诊断阻断原回退

R2 `5906e54d9345ab6f8120cf9c47a65c0b2bc53effebed765d8f9802f0257225d4` 有限 FAIL 保留：原三项 P2 已关闭，新 P2 为 selected 操作可以拒绝 `Object.create(null)`、throwing Symbol.toPrimitive 或带 throwing message getter 的 Error；原 preDirty／undo catch 的字符串转换会再次抛错，阻断空集合／superimposition。R1／R2 全文与两次回执保留。

只在本批实际消费 selected 操作的 catch／诊断边界使用一个 TE 内部共享的 no-throw description helper。该 helper 在 try 内执行原 Error.message／String 分支；正常 string 逐字保持，其它可转换结果转为 string；读 message 或转换失败只返回固定 `unavailable error description`。helper 不转换执行结果、不包装／替换原拒绝、不改变调用次序或 retry／keep／discard 裁决，不修改全仓其它 catch。其目标是完成原本已规定的 catch 行为。

captureGitPreDirty 保留原 catch、warn 和 return {}，只替换 error 字段的诊断投影；shard undo 保留原 catch／warn／superimposition，同样只换诊断。其余本批 create／merge／resolve／discard 的消费点若有原错误消息投影，使用同一 helper；describeIsoFailure 的原 blocked-error 分支及 detail 读取在受保护的诊断段内，正常本机 Error 的所有行保持，无法描述时使用同一固定文本，仍返回原 failure code 和原后续归属诊断。实际 effect.fail 继续接收同一个原 error 值。

`application/localEffectObserver.ts:164,190` 的 retry／fail 两处 receipt.error 目前也直接读 message／String，并执行原 2000 字符 slice。为让新 selected 拒绝能完成原收据，只有这两个表达式改用同一 no-throw description helper 后保留相同 slice。原 state／applicationEvidence／failureCode／retryAuthority、requestHash 输入、resource keys、SQL／settle／beforeAct 次序和 ACK 要求不变；不是另一套 observer 或新的恢复状态。普通 Error、字符串及所有原可打印值的 receipt 文本保持，异常不能因诊断转换而替换原错误；原 settle 自身的拒绝与优先级保持。

新增回归分别以 Object.create(null)、throwing Symbol.toPrimitive 的对象、throwing message getter 的 Error 拒绝 changedFiles／blobHashes／undoShard，断言 warn 有固定文本、preDirty 返回空集／undo 按原 superimposition 继续且 wrapper／shard 未被诊断打失败。正常 Error／string 日志逐字保持。实际双 provider effect observer 另覆盖这三类拒绝的 fail／retry 收据及 held settle ACK，断言原 failure code／状态／2000 字符上限、原后续流程和原拒绝对象 identity；不为测试改请求 hash 或落库规则。本机仍不运行 AW test/typecheck/build/service，正式行为等新 exact-SHA CI；有限设计门不关闭完整 A-G 或部署。

# Codex Adversarial Review

> **处置（2026-07-22）**：4 条 critical 已全部闭环（修复口径与红→绿测试见
> `design.md §17`）；修复补丁的复审轮又折出 4 P1 + 2 P2，全部采纳
> （`design.md §17.3a`）；[medium] onlyRecentDays 自续期已由 `900d1ff6`（G7）
> 先行修复；4 条 high + 3 个 Question 仍开放（`design.md §17.3`）。以下为报告
> 原文，未改动。

Target: branch diff against 1b99caea
Verdict: needs-attention

NO-SHIP。原 8 条 P0 中，A2（`ls-tree -r`）、A3（`.git` 判初始化）、A4（每子仓 pool）和 A7（子仓非 FF 不调和）的局部症状已闭环；A1 对中间坏版本新装库不安全，A5 的 pin 失败仍放行，A6 只完成 park 而无恢复通道，A8 仅覆盖根层子仓。成功写入 node/worktree refs 时，同池 gc/prune 有真 Git 测试支撑；但失败路径、新增拓扑、嵌套 merge/push、并发与崩溃恢复仍可丢失产物或发布不可解析 gitlink。四类盲区也只部分补齐：缺新增拓扑、嵌套并发及嵌套 commit-push；缺坏 0102 中间库升级；settle/resume 仍无端到端测试；G10 rollback 与 pin 失败仍未覆盖。

Findings:
- [critical] 子仓自动提交和对象回写失败仍会 clean settle，随后删除唯一产物 (packages/backend/src/services/nodeIsolation.ts:678-714)
  触发路径为 `snapshotNodeIsoFinal → publishSubmoduleHeads`。子仓 `add` 失败没有处理，`commit` 失败和 `pushObjectsToPool` 失败都只记 warning 后继续。父仓快照只能记录 gitlink；因此 hook 拒绝或索引错误会让脏内容完全不进入 node tree，merge-back 可报告 clean，之后 `discardNodeIso` 删除唯一副本。若只是对象回写失败，后续 `nodeIsolation.ts:527-534` 的 worktree anchor 失败同样只告警，node ref 清理后 pool gc 会把 canonical 借用的对象删成 `bad object`。
  Recommendation: 将 status/add/commit/rev-parse/pushObjectsToPool/update-ref 任一失败升级为快照和 settle 的硬失败；只有在 pool ref 回读精确等于目标 SHA 后才持久化 node tree。失败时保留 iso 并暴露可重试状态，补 hook 拒绝、ref 锁失败和 `gc --prune=now` 回归测试。
- [critical] A5 的 pin 写失败被吞掉，用户未提交工作仍会被强推销毁 (packages/backend/src/util/git.ts:1855-1865)
  `snapshotFullState` 在 `update-ref` 失败时明确记录“gc-exposed”，但仍返回 snapshot SHA。`snapshotSubmodule` 未传 logger，因此连告警都没有；`checkoutMergedGitlinks` 会把它当成功并继续 `checkout -f`。ref namespace 冲突、锁竞争、磁盘或权限失败即可触发：用户的 tracked 修改从工作树消失，唯一快照是可被 gc 回收的 dangling commit，A5 所称“快照失败则拒绝强推”并未实现。
  Recommendation: 指定 `pinRef` 时必须让非零 `update-ref` 抛错；强推前回读验证 ref 指向 snapshot，并先持久化完整 SubSnapshot。ref 应包含 run/attempt nonce，避免同一 HEAD 的后续快照覆盖旧恢复点。
- [critical] 运行中新增的首个或嵌套 submodule 完全绕过对象池与递归合并 (packages/backend/src/services/nodeIsolation.ts:663-699)
  拓扑只在 iso 创建时记录。若节点新增仓库里的第一个 submodule，`subBases` 为空会直接 return；若在已有拓扑中新增，当前列表虽能看到它，但 `poolDirs[s.path]` 不存在又会跳过。`mergeSubmodulesIntoTheirs` 同样只遍历创建时的 `subBases`。新子仓 commit 因而只存在于 iso module dir，父层仍可能接受其 gitlink；iso 被清理后对象消失，或 auto-commit-push 发布指向不可获取 SHA 的父提交。设计中 T24 的新增拓扑分支没有落地，也没有对应测试。
  Recommendation: 快照时重新计算 base、iso 当前和 canonical 当前拓扑的并集，为新增路径建立独立 pool/anchor 并持久化更新后的拓扑；对象未确认可达前禁止 materialize 或父仓 push。增加首个子仓、并列新增、嵌套新增及删除/重命名冲突测试。
- [critical] 嵌套 clean commit 被 A8 谓词跳过，父远端可收到悬空 gitlink (packages/backend/src/services/commitPushRunner.ts:520-524)
  `listSubmodules` 返回 `vendor/inner`，但超级项目的 `rev-parse HEAD:vendor/inner` 不会穿透 `vendor` gitlink，因此 `recorded` 失败。若 agent 已在 inner 提交，inner 此时是 clean，`isDirty=false` 且 `movedAhead=false`，代码直接跳过其 push；随后 outer 因 inner gitlink 变脏而被提交和推送，父仓也可成功推送。最终 outer 远端提交引用一个从未推到 inner 远端的 SHA。A8 只修了根层形状。
  Recommendation: 从每个 gitlink 的直接父仓读取 recorded SHA，例如在 `vendor` 内解析 `HEAD:inner`，并自底向上冻结拓扑。推父层前验证每个子层目标分支确实包含对应 SHA，补 clean-precommitted 两层及更深嵌套测试。
- [high] 递归 push 未冻结 SHA 图，并发与崩溃都能破坏原子性 (packages/backend/src/services/commitPushRunner.ts:527-569)
  每个子仓的写锁在 565 行释放，网络 push 在 569 行才开始，父仓 staging 又在之后单独取锁。此间 sibling merge-back 可把子仓从已推的 A 推进到 B；父仓随后记录 B 并成功推送，而子仓远端只有 A，所有命令都成功却留下悬空 gitlink。另一个崩溃窗是父仓本地 commit 已在 314 行完成、332 行尚未 push；若重入同一工作树，273-279 行会因无 diff 标成 `skipped-empty`，不会补推已有本地提交。
  Recommendation: 在写锁下冻结完整递归 SHA 图并从不可变临时 refs 推送；网络阶段后重新取锁，以 CAS 校验全部 HEAD/gitlink 未变化，否则重算。将阶段、目标 SHA 和远端确认写入可恢复 journal，重启后按 journal 补推，而不是重新依赖工作树 diff。
- [high] 嵌套三路合并必在错误仓重写，失败后又永久卡死 (packages/backend/src/services/nodeIsolation.ts:536-545)
  当 `vendor/inner` 的合并结果不同于 iso SHA 时，代码把扁平路径传给超级项目的 `rewriteGitlinkInCommit`；根 tree 中 `vendor` 是 gitlink，Git 不可能在其下写入 `vendor/inner`，因此该路径必转冲突。随后 T25 又把 `paths` 设为父仓路径而 raw manifest 是子仓文件路径，`nodeIsolation.ts:1205-1218` 会把它判为 unhandled；一旦 `pendingSubResolves` 落库，1309-1315 行对每次 resume 都直接拒绝，且没有清空或检查 `resolve-sub` 的路径。普通的嵌套双边推进会永久停在 awaiting_human。
  Recommendation: 在各子仓自己的 ODB 中自底向上重建直接父 commit，最外层只重写根 gitlink；T25 使用子仓相对文件路径，并持久化真实 resolve-sub worktree/commit。human resume 应验证该现场、重建父链并以 CAS 清空 pending，增加完整 scheduler settle→park→resume 测试。
- [high] materializeTree 在验证 gitlink 前已改写 canonical，且部分失败被当成功 (packages/backend/src/util/git.ts:2117-2168)
  步骤 ①–⑤先删除/覆盖父仓文件、改 index 并 reset，直到步骤 ⑥才递归 checkout gitlink。缺对象等错误会在 canonical 已半改写后抛出；`syncSubmodules` 失败只告警，脏子仓强制 checkout 失败在 2261-2267 行甚至继续并最终返回成功。多数生产调用也未传 log。结果可能是节点被标 clean 但子仓仍停在 base，或调用抛错而 canonical 已包含半份节点结果，后续 sibling 以错误基线继续合并。A3 的 `.git` 判断只修掉一个触发形状，没有修复原子性。
  Recommendation: 任何父仓变更前递归 preflight 所有 gitlink 的初始化、对象可达性和脏状态快照；保存可恢复的 canonical 全状态。sync、pin 或 checkout 任一失败都应硬失败并恢复父仓与已移动子仓，不能 warning/continue。
- [high] 0102 时间戳改写会让中间坏版本的新装库重复执行非幂等 DDL (packages/backend/db/migrations/meta/_journal.json:713-717)
  该风险取决于 `0fde0910` 到 `6bad778c` 之间是否存在可安装构建。旧 0102 的 `when=1784547409780` 小于 0101；新建数据库因 `lastDbMigration` 未定义会执行并登记它，但最新时间仍是 0101。升级到当前文件后，migrator 会把修正为 1786204800000 的同一 0102 当成未执行，再跑三条 `ALTER TABLE ... ADD COLUMN`，触发 duplicate-column 并阻止 daemon 启动。现有测试只覆盖当前从零建库和 journal 单调性，没有这个中间数据库 fixture。
  Recommendation: 若坏版本曾分发，在 migrate 前增加兼容修复：识别旧 0102 migration row 与三列实际存在状态，原子修正 migration metadata，避免重跑 DDL；同时覆盖完整、缺列和部分执行三种中间库升级。不要仅改写已分发 journal 条目。
- [medium] onlyRecentDays 会被后台刷新自身续期，废弃仓永久产生网络流量 (packages/backend/src/services/submoduleRefresh.ts:81-91)
  选仓条件用 `lastFetchedAt` 判断最近活跃，但 `refreshDueRepos` 调用的 `refreshCachedRepo` 又在每次成功后台刷新时更新该字段。一个仓只要进入过 recent 窗口，后台任务就会每个周期把自己的活跃时间续上，永远不会老化退出；这与注释中防止一次性镜像造成 network storm 的承诺相反，现有测试只直接 seed 时间，没有跨真实 refresh tick 推进时间。
  Recommendation: 单独记录任务启动/人工刷新产生的用户活跃时间，或让 auto-refresh 不更新 recency 字段；增加模拟超过 onlyRecentDays 的多 tick 测试，确认无人使用的仓最终退出扫描。

Next steps:
- 先补红测再修：commit hook/add/ref 失败与 gc、运行中新增/嵌套 submodule、clean-precommitted 嵌套 push、writeSem 竞争与崩溃重入、嵌套双边 merge 及完整 park/resume、坏 0102 中间库升级。
- Question：`0fde0910` 到 `6bad778c` 之间的构建是否曾发布、自动部署或用于新建数据库？若从未分发，0102 中间态的暴露面可降级；若分发过，必须按 high 修复兼容。
- Question：`DELETE /cached-repos/:id?force=1` 的产品契约是否明确允许破坏仍引用任务？当前 `deleteCachedRepo` 会直接删除 pool 和 alternates 目标；若不允许，force 也必须做 borrower/ref preflight。
- Question：RFC-165 后是否仍需恢复 legacy path-mode 任务？若需要，`captureSubmoduleTopology` 从未向 `resolveSubmodulePool` 传 `isPathMode:true`，D11/AC-21 仍未接线；若完全不再执行，应删除这条死契约。

Codex session ID: 019f8743-f5e9-7ae1-ad71-9561a35866b1
Resume in Codex: codex resume 019f8743-f5e9-7ae1-ad71-9561a35866b1

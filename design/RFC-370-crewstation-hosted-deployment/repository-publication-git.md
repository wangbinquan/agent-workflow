# RFC-370 A4：提交与发布的仓库 Git 工作区切面

状态：有限设计门已通过，进入实现检视。承接完整 isolation scope；本批只重构提交／发布与终态脏检查的物理 Git 入口，不编写 CS adapter，不关闭完整 A4／A-G。

## 现有调用链与本批范围

`services/scheduler.ts` 的只读仓库终态检查与自动提交入口直接调用 Git status。`services/commitPushRunner.ts` 保存 Task/node/effect 事实、短写入窗口、消息／repair 子 Agent 和最终 receipt，同时直接调用 Git，并用本机 `.gitmodules`／子仓查询。`source-control/application/repositoryCommit.ts` 已拥有七项共享策略，真实 binder 是 `source-control/composition.ts:186`；它以 runGit hook 接入本机机制。`infrastructure/local/fileRepositoryPreviewIndex.ts` 已有独立 preview index port，但默认 binder 会按服务宿主的临时目录生成 index。

现有库存记录上述三个业务文件至少 33 个直接 Git 调用地址；该数是有限库存，不代表整个仓库所有 Git 效果。子仓探测与查询、临时候选 index 也是本批物理范围。原业务七操作 prepare、preview、commitPrepared、classifyPath、publish、resolvePushBase、updateRef 保留同一 SC owner；不把其候选过滤、history 判断或排除政策交给适配器。

Task HTTP diff／repair、DA delivery 与 DE 验证的其他物理入口继续按 remaining-a 收口。本批不声称它们已改造。

## 中性切面与独立本机实现

增加 SC 的 `RepositoryGitWorkspaceFactory`。`bind` 是同步、无 IO 的逻辑绑定，输入为 task identity、workspace reference 与 repository identity，返回一份完整 scope。reference 在 native 实现中可为现有路径；消费者不探测或解析 reference 的本机位置。CS 实现未来按自身工作卷定位规则解释 reference，不将 CS DTO 引入本合同。

完整 scope 持有只读 workspaceRef，并提供五类物理能力：

| 能力                | 原行为与输出                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| run                 | 原 Git argv、env（含 undefined 的取消覆盖）、stdin、timeout、AbortSignal；原 stdout/stderr/exitCode 与拒绝 identity，不改变任一 Git 命令、分类或原结果形状 |
| hasSubmodules       | 原 `.gitmodules` presence 语义；选中实现可异步返回，默认沿原 native probe；Task 在原调用位置等待                                                           |
| effectiveSubmodules | 原 effective discovery、完整 SubmoduleEntry 字段／路径与原失败行为；AW 原 usable/bottomUp 排序仍在原调用位置                                               |
| withPreviewIndex    | 复用既有 RepositoryPreviewIndexPort，等待 callback 和 scope 清理完成；native 临时 index、字面量 pathspec、原 options merge 和 finally 删除保持             |
| subrepository       | 接收原 discovery 的相对 submodule path，同步无 IO 返回同一 factory 的完整 child scope；native 实现保留原 join 位置，所选实现决定其 opaque reference        |

子仓通过所选 scope.subrepository 在原逻辑子仓上绑定，其 workspaceRef 供原 child 业务输入使用。默认实现负责 native 子仓位置；所选实现必须提供对应 reference，Task 不以本机 join/exists/readFile 检查或定位远程子仓。原 root/submodule 的逻辑关系和顺序不得改成另一套 discovery。

完整 native scope 在 `source-control/infrastructure/local`，调用现有 platform Git 和原子仓机制，完整保持 native env、进程取消／超时、结果和子仓错误政策。本批无需搬动或复制底层 platform Git 程序。若复用 SubmoduleEntry 合同，按完整原声明迁到 SC 中性类型处，旧 service 精确转导；不能删字段或重写原纯排序函数。

选择位于 SC composition。只有未提供 factory 时使用 native；显式 null、缺方法或无效 scope 在物理调用前具名拒绝，不能逐项借 native。绑定保留 frozen/prototype receiver，并保留同一 factory identity。显式 factory 与旧 runGit 测试 hook 同时存在时，以显式 factory 为完整物理能力来源；旧 hook 仅作用于未选择 factory 的原兼容 native 分支。

## 真实消费者与 roots

`TaskEngineRuntimeOptions` 增加中性 factory，双 provider 与 cli/server roots 只选择／透传一份完整 factory；child options 保留同一 identity。scheduler 的两条 status、runCommitPush 的 root／subrepo 物理命令和 discovery 均走选中 scope。SC 的既有七项 binder 从完整 scope 取得 Git 和 preview index，不单独拼回本机 index。

旧 `CommitPushDeps.runGit` 保留给原单元调用者，default/native 分支维持原行为。旧直接调用 `bindRepositoryCommitParticipant` 的 native 调用者继续工作；新选择入口不扩大其业务政策。

原 `RepositoryPublicationTransport` 已是独立网络会话切面：open、同一 session 的 runNetwork、receipt 和 close 仍沿原逻辑，不替换网络会话或新开 fallback。SC publish 的原 argv／env 仍使用该选中 session；候选／本地 Git 来自 workspace scope，整个会话直到原 finally close。CS 的网络 transport adapter 以后独立在 SC 对应层编写。

## 不变的实际业务行为

完整 `runCommitPush` 与子仓程序只替换物理调用接线：node mint、beforeAct/journal、短 writeSem acquire/release、消息／repair Agent、Task identity env、三项 diff、exclusion receipt、commit、非 FF fetch/merge/abort、history scan、remote verify、原 amend 政策、原错误／重试、最终 persistence/effect ACK 和 session.close 顺序保持。业务阶段不是 adapter 的生命周期。

只读终态检查仍在原 Task 完成位置，保持 original readonly/warning 和 failed status 的处理；自动提交的原配置和启动判据不改。factory bind 无 IO，实际 scope 调用留在旧效果发生位置，不在 beforeAct 前新增网络动作。

## 回归与验证

新增真实消费者回归覆盖 root 和递归子仓的所有所选调用、一次选取／相同 receiver、held command ACK／preview cleanup ACK、三项 diff 与完整 receipt、native 子仓顺序／空与坏探测、显式不完整拒绝、旧 hook compatibility、跨 Task/仓库和 child/root identity。所选 opaque reference 用例禁止本机 Git/FS 探测，检查实际消费者的输入／输出和原 effects；不以只测 selector 代替真实路径。

原提交、submodule、readonly、artifact、transport 和 effect 用例全部保留名称／预算／断言。纯字节／AST 逆投影证明原 Task/SC 政策正文与调用顺序；source oracle 只随真实 owner/地址投影，不改变 scanner、normalizer、规则或预算。仅做目标格式/lint、纯源证明与必要原 scoped canonical；正式运行仍以该候选的 exact-SHA hosted CI 和 Windows 为准。

设计门通过后实施本批完整物理范围，独立 source gate 后再正常共享 main 发布。仍继续 A4 其余入口、A1～A8/AC00 和完整 A-G；随后各层独立 CS adapters、B/M0 先实际部署，再增量 M1～M4。本任务 M0 首次部署尚未完成。

## 当前证据与边界

DESIGN1 的独立功能门 PASS，候选指纹 `7cc38ae455a1a8b86c4194b9def7c3c992f8bd79564ae4299a48b939061dece9`。本批实现已有完整 native factory／scope、原七项 SC binder、提交与递归子仓、scheduler 两条 status 及双 provider roots 接线；新真实 Git 与双 provider 用例仍交托管 CI。

W29 使用原完整 normalizer 重采：PG 原 173 条变 174 条，SQLite 原 53 条变 54 条，都是新增一次 factory selection；仅替换 PG 计数与两项实际摘要。原八阶段、五项控制和事件摘要不变，未改 normalizer 或预算。第一份投影脚本误认为存在独立 SQLite 计数断言，准备阶段中止且未写测试；后继只删除脚本的这一不存在的假设，原分析与失败记录保留。

SOURCE22-DOC1 首轮指纹 `ee0eeeebcc66a8d8eacd314af1562beeef0098bb582e4e2981e9ccf1157bca9e` 为 FAIL，三项 P2 与完整回执保留。R2 使 selected preview 使用原 binding 捕获的 `common.gitOptions`，仍保留该原 options 对象的 live env 内容；native resolvePushBase／updateRef 恢复原调用时读取 `input.runGit`，selected 分支继续保留同一 scope receiver；删除 SQLite CLI／HTTP root 各一处重复 factory 字段，保留一次完整透传。新增实际 binder 的替换 options／已取消新 signal 和 native 热 hook 回归；W29 仅随实际根修正重采原摘要。原业务、旧测试与预算不变，R2 仍须独立复核和新精确 SHA 的 hosted CI。

### 2026-10-04 RFC-370：提交／发布 Git 完整物理 scope 的有限接线

完整 RepositoryGitWorkspaceFactory/scope 在 SC 的 application/composition/local adapter 各层落位。Task 提交与递归子仓的本地命令、discovery、临时 preview index，以及 scheduler 两条终态 status 使用同一选定 factory；原一次 network transport/session、receipt 和最终 close 保留。33 个旧直接 Git 地址只属本批有限库存，Task HTTP diff/repair、其他 delivery/conflict/员工验证等 A4 余项未记完成。

首 SOURCE22-DOC1 的三项 P2/FAIL 全文保留；R2 修复 preview 捕获原 options、native query/update 热读 hook 与两处重复装配字段，独立有限 PASS，指纹9026b1c971ffb25ae8b521c4e45845af985ffa53a220eb8e2e4de9382ee2447a。第一次原 canonical 在 private output 中发现一个无消费者的新增 public helper，之后只删除其 public re-export，完整内部实现和真实调用者不变；增量 SOURCE1 有限 PASS，指纹d74eb46f2b94e4aba78d7142d6bb4d4d2c95c05052c123bfd8433a61b508ada9。旧生成完整保留，新内容候选只生成一次，不因移动 HEAD 重开源门或生成。

最终 scoped canonical 基准4fe2fcaeed44426cc0a969f1a8751728f94a7b43，四原规则不改，所有非本批源码从该 commit 读取并排除保留并行观测/native owner在制品。sourceDigest sha256:b24f35e5ddd5b479b6f1a6aa1c44791b1d0f388c2949f99e2e6482357b71c376；129 原有序库存及完整 why 保留。五项真实增长：mutation1866→1867、observed6074→6095、exact compatibility exceptions5388→5406、public1137→1146、owner26516→26529；各自具名登记，匹配发布后以普通后继退役。此前321/1→322/2的两个测试计数许可已在4fe2提交消费，本批只正常退役许可，计数和实际 synthetic PG open debt 保留。原40 required SPI、69 target edges、空 implementation SCC、完整300债务和C2原精确等式保持；Task effect仅runCommitPush地址187→198投影，原九条语义保留。

准备脚本首轮传 provenance helper 的参数形状不符实际签名，原证据保留；R2 按其原对象签名恢复 origin/currentSnapshot，不改完整 payload、五项增长、原 why 或规则，不重跑已完成生成。最终 JSON／字节／原计数证明与有限 metadata gate 单独记录。仅做目标 format/lint 和纯静态证明，无本机 AW tests/typecheck/build/service。

旧04a的正式主CI37187048069为completed/cancelled，34 success、14 failure、2 cancelled，Windows37187051255为success；两项test ledger失败已发布4fe2修正，另一个Windows前端wizard断言仍未归属，原失败不改为绿。原E2E入口加载问题由并行06c4修复；4fe2及本批新SHA正式CI分别继续。完整A1～A8/AC00/A-G、各层独立CS adapters、B/M0首先实际部署与M1～M4逐步收编继续，尚无AW-in-CS部署，不关闭RFC。

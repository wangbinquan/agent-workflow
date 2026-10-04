# RFC-370 A4：Conflict merge 完整工作区效果切面

状态：有限设计候选，尚未实现。承接 Task diff/repair 读取批次；本批只收口 SC conflict prepare/inspect/finish/discard 的实际物理效果及所有装配消费者，不关闭完整 A4/A-G，不编写 CS adapter。

## 实际缺口与原合同

`source-control/application/conflictMerge.ts` 仍直接分配临时目录、clone baseline、写平台 exclude、读取冲突文件及 MERGE_HEAD、执行 Git 和删除现场。`source-control/composition.ts` 的 bindConflictMergeParticipant 当前无选择参数，三个实际 roots 在 DA、DE workspace、platform work items 与 reconciler 装配中重复调用默认绑定。DA 自己已经拥有 ConflictMergePort 和 automation/action workspace 合同，继续复用，不再新造业务 prepare/finish facade。

prepare 的原机制是按可选宿主根分配 parent/ws，clone 后 detach source、移除 origin、写平台 exclude，再 merge target into source。无冲突、clone/checkout/remote 错误和非内容 merge 错误按原 typed result 清理；真实冲突现场保留给修复 Agent。inspect 保持 marker 判据、validated delta 优先、porcelain rename 两侧与 extra changes 错误。finish 保持两 parent 幂等回执、验证先于 stage、原 add 范围、平台 identity 与原 message、HEAD/tree 读取和错误。discard 的 native basename 校验与 parent 删除规则保持。

## SC 自有完整物理效果与独立 local 实现

新增一个完整 ConflictMergeWorkspaceEffects port，由 SC application 拥有，reference 只由所选实现解释。七项机制能力为：

- allocate：接可选 storageRootReference，返回 workspaceReference；不决定业务 source/target 或 merge 结果。
- cloneBaseline：接 workspaceReference/baselineReference，执行原 clone 机制，返回原 Git 结果。
- run：接 workspaceReference、原 readonly argv/options，返回原 Git 结果；复用现 RepositoryGitWorkspaceScope update 的中性参数/结果合同和唯一 native Git 机制，不复制 spawn。
- installPlatformExclude：在所选现场安装原完整平台 exclude；不改规则或改成追加内容。
- readConflictFile：接 workspaceReference 和原 conflict 相对路径，返回原文本或 null；native 复用原 exists/read/catch 行为。
- mergeHeadExists：探测该所选现场的 MERGE_HEAD。
- discard：回收该所选现场；返回 void 或 Promise，消费者等待完整 ACK。

port 支持同步 native 机制与异步实现，run/clone 保持原 Promise Git 结果。selector 只有 undefined 选 native，显式 null/缺任一方法在任何分配/物理调用前具名拒绝；不逐方法补 native，不 spread/解绑定所选对象。frozen/prototype/private receiver 和错误 identity 保留。legacy runGit 覆盖仍只影响完整 native 实现，按原每次 operation 入口时点捕获，不覆盖一个显式 selected port。

独立 local 文件唯一解释 parent/ws、tmpdir、dirname/basename、FS 和 Git 参数中的本机位置。沿用原 utility/Git scope及原调用参数；不把整个 prepare/inspect/finish 状态机搬入 local adapter。SC application 仍决定 merge 顺序、marker、delta、幂等、typed failure、commit policy和何时清理。

## 真实消费者与生命周期

bindConflictMergeParticipant 选择并保留一个完整 effects 对象，四个动词都使用该 receiver。StartOptions、session/recompose、SQLite/PG 与 classic HTTP roots 透传所选 effects，所有 DA/DE/reconciler 装配点复用该完整绑定。已有通过 application 函数及 runGit 夹具调用的入口保持 native 兼容，但默认选择归 SC composition。

prepare 等 allocate/clone/exclude/Git ACK 后才返回现场或错误；所有失败清理也等待 ACK，原错误不被改为本机目录缺失。success cleanup 和 discard 可异步，现 DA 合同只随真实签名透传完整能力。现 action workspace adopt/discard 与 DE 持久 preState 保留其既有 owner、策略和恢复事实；不能在抽取本批机制时重写资源 claim、派发或 GC。

inspect 按 conflictPaths 原顺序读取并等待文本，native 缺文件/read 失败保持原 null 判据，selected 明确拒绝保持原 error。finish 使用同一所选 effects，重入不额外创建现场；先等 merge-head/两 parent/inspect，再 stage/commit/HEAD/tree。opaque workspaceReference 不在 application 内 basename/join、FS 探测或退回默认 Git。并行业务改变、effect settle 和恢复策略仍由原 DA/DE/Task owner 处理。

## 有限回归与验收

原 rfc310-pr7b-conflict-merge 套件的名称、断言、预算、真 Git conflict markers、extra changes、clean/no-conflict、flattened index 与两 parent重入保持。原 body/source oracle 只作实际 owner/地址/异步 ACK 投影，不放宽 marker、stage、commit、清理或预算判据。

新增原实际 SC/DA/DE 消费者回归用真实 native Git、双 provider 持久事实、完整 frozen/prototype port与 opaque refs，覆盖 allocate/clone/exclude/read/probe/Git/discard ACK、错误 identity、完整性选择零物理调用、cleanup 一次及无提前成功、原失败分类/幂等和有效现场持久恢复。验证真实返回和业务持久结果，不用只测 selector 或伪造 merge 最终业务结论代替消费者。selected 效果必须贯穿全部 roots与重装配，遗漏消费者不以有限端口测试通过冒充完成。

设计独立功能门通过后实现；仅目标 format/lint、纯源码/JSON及一次原 scoped canonical，不运行本机 AW tests/typecheck/build/service。正式行为交新 exact-SHA hosted CI/Windows与实现功能门。candidate delivery 的剩余 baseline Git、DA/DE validation、其他 A1～A8/AC00/A-G继续；完整 A-G后各层独立 CS adapters，B/M0先实际部署，再逐项 M1～M4。当前尚无 AW-in-CS部署，不关闭 RFC。

## DESIGN-R2：闭合实际 adopt 与持久现场回收

首轮 DESIGN1 功能门 FAIL 保留（指纹 `132cea0915ac8aac14e87d93d648dedc0bc7a88d8ed895007df5df8996a694cc`，两个 P2）。第一个是 SC 所选 opaque 现场进入 DA 原 native adopt/digest，尚未启动 Agent 即在 lstat 失败；第二个是 fresh retry、取消及 head-changed 回收仍调用 native actionWorkspace.discard，SC 所选 discard 调用零次且异步 ACK 无消费者。这两项说明首版“所有装配消费者”声明未闭合。原文保留为历史；以下修订是本批实现准则。

### DA 仍拥有 action workspace 策略与独立机制

将 DA action workspace 的原 materialize/adopt 策略放入 DA application；新增 DA-owned 完整 ActionWorkspaceEffects 物理端口和独立 local 实现。它包含 allocate、cloneBaseline、run、installPlatformExclude、requireEntry、discard，以及一个完整 `contents: AutomationWorkspaceEffectsFactory`。requireEntry 保留原 lstat 对缺失的拒绝，原 kind/mode 事实供 DA walk；contents 直接复用已存在的完整引用投影、目录列举、字节读取、copy/mode/write 和 acquire/close 合同，不新造重复文件能力。Git argv/options/result 复用 SC exact public types，native Git 执行仍委托原唯一工具实现。

DA application 保留全部原 clone/checkout/remove-origin 顺序、失败信息、整树 cleanup 时点、平台 exclude、可选 seed copy 顺序、权限 mode mask、evidence bundle 次序和 businessTreeDigest 的完整 hash bytes、sort 与排除判据。digest 与 seed walk 不迁成 adapter 的黑盒业务操作。所有 ref 拼接经 contents.resolve/parent；bundle destination 也经该所选引用投影，原 EvidenceArtifactPort 等待完整 materialize ACK。adopt 不重新 clone、不叠 seed、不修改 conflict 业务树或 markers，返回同一个 workspaceReference。原同步 businessTreeDigestOf / discardWorkspace 仅作为默认 local 兼容入口保留，真实所选消费者使用异步完整端口。

DA selector 只在 undefined 选完整 native，对显式 null、缺 contents 合同或缺任一物理方法在任何物理调用前拒绝；保留所选 factory/effects receiver。materialize/adopt 等所选 content scope 的 close ACK 后才返回业务事实；run 及各物理结果不逐方法退回本机。旧 evidence materialization 回归仍保留原参数、断言和预算。

### 根装配与跨 owner 引用交接

Start/session/recompose、SQLite、PG、classic HTTP 同时持有一个完整 `conflictMergeWorkspaceEffects` 和一个完整 `actionWorkspaceEffects`；DA ActionWorkspacePort 的 materialize/adopt/discard 绑定所选 DA effects，SC ConflictMergePort 的 prepare/inspect/finish/discard 绑定所选 SC effects。SC effects 显式注入时，实际包含 Mission conflict 消费者的根必须同时获得显式 DA action effects，在任何 scene 分配前拒绝漏配；SC 独立 participant 用例不因此强制装配 DA。根保留引用兼容的完整 DA contents，并将该同一 contents factory 传给已有 workspaceValidation，不可让 adopt 成功后 validation 又落入 default native。存在显式 automationWorkspaceEffects 时保留它，装配时验证完整对象并由组合者提供相同引用解释；不通过逐方法 fallback 拼装。

selected SC allocate 的结果，作为同一字符串依次进入 DA adopt、原 evidence mount、digest/validation、Agent launch、durable preState 和 SC finish；application 不 basename/join、FS 探测或把它改写为本机路径。未来两个独立 CS adapter 共同解释平台 workspace reference；这种协议属于各自 adapter/装配，不把 CS DTO 或资源 claim 规则引入当前业务层。

### 由实际创建 owner 回收并等待 ACK

DA ConflictMergePort 增加完整 discard，并将 prepare cleanup 的真实返回签名扩为 void | Promise<void>；生产绑定和全部受影响旧夹具显式提供完整合同，原断言/预算保留。SC 所选 discard 在 SC application 失败清理、prepared.cleanup 和 DA conflict scene 的 durable 回收中使用同一 receiver。

agentActionOrchestrator 的 cleanup helper及全部既有 discard 调用点都改为 await。新启动 conflict scene 的创建 owner 由原 edit-conflicts mode 决定；恢复后由已持久化并经原 schema 解析的 capabilityId/conflict pin 决定，不依赖进程内 Map、仅一次 cleanup 闭包或当前 action 对象。conflict scene 回收调用所选 ConflictMergePort.discard；其他 action scene 调用所选 ActionWorkspacePort.discard。原 same-session 保留现场、fresh-session 整树重建、取消、manifest 错误、ordinal 冲突、terminal failure 和 head-changed 的分支/重试预算/settle 政策原样保留，只在各原 cleanup 时点等待实际 ACK。原 try/catch 的错误优先级与 GC 兜底保持，不让清理失败覆盖已有业务错误，也不提前进入 fresh retry 或返回终态。

prepare 成功而 adopt 拒绝时，由真实 launch 消费者等待 SC 创建 owner 的一次 discard，再传播原 adopt 错误；清理拒绝按原主错误优先级处理。重装配后的 SC discard 接受原 durable ref，不依赖准备期临时对象；DE 已有持久 preState 和 workspace effects owner 保留，prepare/inspect/finish 及 DE 已有 cleanup 的引用链须用真实消费者对拍。

### 新增验收，不以端口假场景替代业务链

除首版 SC 真 Git 套件外，新增 DA 实际 materialize/adopt 的完整 opaque refs、private/frozen receiver、binary seed、原 digest 字节/native 对拍、bundle materialize 等待、content close 等待和失败 identity。真实双 provider Mission 的 edit-conflicts prepare→adopt→validation→launch 必须生成并回读原持久 preState；包括 bundles=[] 与非空 evidence，避免只测 helper 冒充实际可启动。

在已持久现场上重建 composition，然后驱动原 pollActionRunAttempt 的 fresh retry、canceled 与 conflict-head-changed 分支；held SC discard ACK 前不得再次 prepare、settle 后继 block 或返回 terminal，并断言 SC discard 一次、DA native discard 零次。普通 action scene 的同样回归锁定其 DA discard，原 same-session 不 discard。缺 paired root 注入必须在分配前拒绝。所有旧完整性、markers/extra changes、幂等、validated stage范围、预算和 source oracles只作实际投影，不能削弱。

本修订只处理完整 SC conflict 及 DA action workspace 的物理交接/清理切面；resource claim、派发、GC、业务执行和恢复策略不重写。设计功能门通过后实现，完整 A1～A8/AC00/A-G、CS adapters 和 B/M0～M4 仍开放，尚无 AW-in-CS 部署。

## DESIGN-R3：纯应用层与 native 兼容入口的具体落位

只读调用者核对显示，四个 conflict 应用函数的生产入口全部经 SC composition；唯一直接导入应用函数的旧调用者是 rfc310-pr7b-conflict-merge 真 Git 用例。为避免应用层反向导入 local 或 composition 后再形成循环，本次把这四个函数改为显式接收完整 effects 的内部应用操作，默认选择只在 bindConflictMergeParticipant 中完成。旧真 Git 用例从该既有 composition 入口取得同名 prepare/finish 别名；除 import/绑定以及等待 cleanup ACK 外，全部原 fixture、测试名称、断言和预算保持。首版“通过 application 函数入口保持 native 兼容”在本条具体化为原实际生产 participant 和原 native 行为兼容，不保留仅供旧用例使用的隐式本机应用入口。

SC composition 保留原请求的 runGit 夹具参数：默认 native 使用一个完整 local effects；请求显式传 runGit 时，只在该次 operation 开始选择同一个完整 native 实现的 Git 覆盖版本。显式 selected effects 始终使用原 receiver，runGit 不替换它。finish 内部 inspect、prepare 的 fail/cleanup 都使用该次完整 effects，禁止逐方法混配。默认选择本身不分配现场，prepare 才分配；standalone 的四动词绑定仍可独立使用，不强制 DA。

DA 新异步应用操作分别接完整 ActionWorkspaceEffects 和原业务 deps；实际 composition 同时选择完整 effects、其 contents factory 和原验证器。原 infrastructure/actionWorkspace 的 materialize/adopt 兼容入口委托同一个应用操作与完整 local adapter；原同步 businessTreeDigestOf/discardWorkspace 的 native 兼容体保留在 local 机制侧，由旧入口准确转导，不复制另一份 digest/clone 业务策略。异步 selected digest 仍在 DA 应用层逐项读取、排序和计算原 hash bytes，并与同步 native 用例对拍。

这项落位仅明确内部接线和旧 native oracle 的入口，不改变 R2 的 SC→DA 引用交接、持久 owner 判断、错误优先级或 cleanup ACK 验收。所有应用操作不导入 composition/local，不增加此类反向依赖豁免或迁移新业务政策。R2 的双 provider 实际 Mission、恢复后 fresh/cancel/head-changed 与原 complete native 套件继续作为本批实现门范围。

## 实施候选与验证边界（2026-10-04）

DESIGN-R3 已有限独立 PASS，指纹 `0adc17ba0841c96787becdac5c5a07d9b2be74fab2d884915dc981392fb2ed24`。SC 七项完整物理效果和 DA action workspace 六项机制及既有完整 contents 已按各自 application/composition/local 层接线；默认选择只在装配，原同步 digest/discard 兼容出口保持。三个根共九处 conflict 绑定透传同一所选 receiver，缺 SC/DA 配对及显式不完整对象在分配前拒绝。普通场景由 DA 回收，冲突场景按已持久 capability/conflict pin 回到 SC，原五处恢复清理等待完成；prepare 成功而 adopt 拒绝也等待一次 SC 清理并传播原错误。

新增源码回归使用真实 Git、真实内容字节、完整 frozen/prototype receivers 和 opaque references；包括 prepare/read/probe/discard ACK、二 parent 幂等、二进制 seed/原摘要对拍、bundle/close ACK、原错误 identity、双 provider Mission 的空/非空实际 evidence、重装配后 fresh/canceled/head-changed、普通 action 的 DA 清理、DE Case 的实际 checkpoint/持久现场/重装配/inspect 与真实 provider/HTTP 根的配对装配。旧 T78/PR4 用例和默认预算保持；新 fixture 的 conflict retryDefaults 仅为新恢复用例通过原发布命令明确设置，原默认仍为 0/0。

原 W29 规范化函数保持逐字不变。一次纯 AST 投影得到 PG phase 175→176（新增配对选择）、SQLite 55→55、HTTP 65→65；只有三个实际旧摘要和一项语句数更新。五个原控制函数完整摘要及 Event Center 体保持。四段逆向恢复原 W29 全文，不放宽任何阶段、生命周期、调用或旧断言。

当前仍是未发布的源码候选；28 路径定向 format/lint 已通过，W29 补正与最后测试微调仍需纳入最终定向检查。尚未运行本机 AW tests/typecheck/build/service；独立 SOURCE 门、正式 canonical、精确发布及新 exact-SHA hosted CI 均待。本批不关闭 A4/完整 A1–A8/AC00/A-G，各层独立 CS adapters、B/M0 实际部署和 M1–M4 继续，当前尚无 AW-in-CS 部署。

上一批工作区 reader 修复末 SHA `317977b978cae4e5e623939945b98ac4d781c9cb` 的 Windows37200457724 已 completed/success（1/1），主 CI37200401423 completed/failure（44 success/6 failure）。原全部官方日志保留：两个后端分片为 RFC371 quality-tasks-provider 第156行；三个 E2E 分片为 RFC371 Task 下钻的窄屏宽度第504行和 capture 卡片间距第1287行；另有 required 汇总失败。这些实际失败不是整套 CI 通过，也不代替本批新行为的托管验证。并行观测内容继续由其 owner 修复，本批不覆写其在制品。

## SOURCE32-R2：保留首门失败并修正原生合同与真实回归入口

SOURCE30 的首轮有限 FAIL 保留原回执及首末一致指纹，不以修改候选重写原结果。默认 prepare／inspect／finish 在每次操作开始仅捕获一次 runGit，显式 selected 分支完全不读取该旧 hook；discard 使用装配时已选完整 effects，保持原回收入口不读取 Git hook 的行为。新增真实 Git getter 回归覆盖实际 clone／inspect／两父提交和现场删除，不伪造 Git 业务结果。

真实双 provider DE Case 用例先插入并准备 initial round，再按合法终态退出活动集合，更新 Case 的 repair 当前入口后插入唯一活动 repair round；全部原 checkpoint／重装配／requirements／inspect ACK 断言和预算保持。Evidence root 的完整所选 contents 断言跟随新的配对回退表达式，两个 await materializeBundle 跟随实际 application owner；原 hash 集合仅映射到 application digest 与保留原函数的 local adapter，正则、完整集合相等及其它合法地址保持。

本修订尚待独立 SOURCE32-R2 复审、一次原 scoped canonical、精确发布及确切 SHA hosted CI。无本机 AW tests／typecheck／build／service；完整阶段 A、各层 CS adapters、M0 实际部署与后续全能力接入仍开放。

## SOURCE32-R2 已通过与匹配清单候选

SOURCE32-R2 独立有限 PASS，指纹 `b8564115bf0e735d9582022fd878ed6fccf4e2d1c9df2271786dfb1264f6657f`，32 owned（31 TS 与本文）、14 controls、31 evidence 首末一致。首门 SOURCE30 的五项 P2/FAIL 原回执保持：默认 hook 仅捕获一次、discard 不读取旧 hook、DE 唯一活动 round、evidence 实际 owner 与完整 hash 地址集合均已修正；原 native 函数、旧测试断言及预算通过纯 AST／逆向字节证明保留。

原 317977 基线生成及因 HEAD 已前进而在任何写入前停止的准备记录完整保留。并行 RFC-371 源码和其已消费许可退役进入 `4380835555a9ded3664f266bb995e6a31e345e08` 后，按这个完整 committed 基线加同一冻结 31 TS 内容候选重新投影一次；其余6381份非自有 TS 从 exact committed blob 读取。下一批 Candidate 发布在制品及并行 native owner／CI 修复在制品全部排除且保留，没有重复源码门或本机 AW 行为检查。

13份原 canonical 输出的 sourceDigest 为 `sha256:4d8762a0c70953202b0baf6db646da740c7064a36448d05b79cf0a541adf44ce`。实际 entry1868→1870、import6106→6117、exception5411→5420、public1148→1149、owner26539→26563；完整129有序库存及原 why、四条原规则、40 SPI／69 target／空 implementation SCC、原300债和 Task effects 保持。五项实际增长按原协议登记，matching 发布后以普通后继退役。完整原 JSON validator 已通过；本匹配 metadata 候选另作有限门检视和精确发布，正式行为只由新 exact-SHA hosted CI 验收。

本批只完成冲突与 action workspace 的有限物理切面，不关闭完整 A4／A-G。Candidate 发布切面的 DESIGN-R2 已通过，后续源码保持独立批次；执行、runtime、脚本与执行权恢复等余项继续。各层独立 CS adapters、M0 首次实际部署与 M1～M4 保持开放，当前仍无 AW-in-CS 部署。

# RFC-370 A4：Candidate 发布的完整所选效果接线

状态：后续有限设计候选，尚未实施。承接冲突工作区批次；复用已有 candidate effects 和 publication transport，补齐实际根装配及 push 的 baseline 回读，不关闭完整 A4/A-G，不编写 CS adapter。

## 已有能力与实际缺口

SC 已有 `RepositoryCandidateEffectsFactory`，其 scope 拥有 baseline Git、临时 candidate 工作区及 close；stage、derive、commit 已消费它。`RepositoryPublicationTransport` 已拥有远端会话、endpoint、network Git 和 receipt，AW 仍决定 exact-head CAS、tree/parent 幂等、失败分类与发布收据。

三个实际 roots（SQLite start、PostgreSQL daemon、HTTP/default SQLite）的六组 `bindChangeCandidateParticipant`／`bindCandidateDeliveryParticipant` 目前均未透传 candidate factory。`pushCandidate` 的远端 transport 可替换，但 fetch 后的 tree/parent 回读仍直接使用本机 `runGit`。因此已有 stage/commit 切面不足以完成 opaque baseline 的生产发布闭环。

原 transport 的四个关闭消费者为 candidate push、employee remote-head fetch、Task 普通提交及递归子仓提交。它们当前不等待 close；远端 adapter 的资源释放必须有明确的完成语义。

## 复用现有 factory，不增加第二套发布状态机

`RepositoryCandidateEffectsFactory.acquire` 的 baselineReference 保持必需，overlayReference 改为可选。stage/derive/commit 始终传完整原 overlay；push 只取得 baseline scope，不创建 candidate 工作区。scope 的完整方法集合保持，selected 对象不依赖 own-properties、对象 spread 或本机引用解释。

local adapter 仅在 createWorkspace 入口校验 overlay 存在，再使用原 clone/FS/Git/close 机制；只有 baseline 的 scope 不分配临时目录。所有原 stage/commit 输入、遍历、模式、hash、内部 ref、tree/parent 判据、reused 与错误语义保持。

push 的 baseline tree/parent 读取改经同一所选 scope.runBaseline。AW 保留原 remote-head → fetch → identity → CAS → push → confirm 的顺序；remote network 命令仍经同一个 publication session，receipt 不改变。完整 factory 在 composition 选择，只有 undefined 使用 local；显式不完整对象在物理效果前拒绝，selected 分支不读取 legacy runGit getter。默认真实 native fixture 的 hook 每次仅捕获一次。

原本机 fixture transport 机制移至 local 文件，由 native composition 注入；既有 file/absolute/relative remote 判据及无 managed transport 时的拒绝行为保持。业务应用不导入本机 adapter，也不对 selected opaque baseline 调用路径判据。旧直接 native 用例经既有 composition 获取相同操作；原 fixture、名称、断言、预算与 publication receipt 保持，不复制 push 业务逻辑。

## 实际根装配与生命周期

增加根输入 `repositoryCandidateEffects`，从 CLI opts → sessionInput → provider split → PostgreSQL/SQLite/HTTP 透传；六组 derive/delivery 都使用同一个 factory receiver。DE platform work items 和 DA 普通工作流同样接线，不只覆盖单个 selector。既有 publication transport 仍由其 root 选择，与 candidate scope 的 workspace reference 解释匹配；CS 两个独立 adapters 的具体互通协议留阶段 B。

`RepositoryPublicationSession.close` 扩展为 void 或 Promise<void>，上述四个实际消费者都等待完成。默认 local close 的原体及调用顺序保持，完成前不交付最终成功或继续后继工作。push 在 transport 成功打开后取得 baseline scope；若打开失败，不 acquire baseline。baseline acquire 拒绝也关闭已打开的 transport。退出时先完成 publication close，再在 finally 完成 baseline close，两个 owner 均有回收机会；默认 baseline close 无效果，保持原 native close 错误优先级，不重写 CAS/发布策略。

直接使用旧 native helper 的测试调用只改装配入口/必要 await；同步 hash/Git 参数、业务分支和原失败历史保持。恢复时仍按原持久 subject、baseline、tree、expected head 重装配相同 factory 与 transport，不把内存 session 作为持久事实。

## 验证与交付

新增真实 native Git、frozen/prototype 完整 receiver 和 opaque refs 回归，通过实际 bind、双 provider DA/DE 和六组 roots 验证所选对象、baseline ACK、scope close ACK、publication close ACK、失败 identity、原 tree/parent 幂等、head changed、普通 push 与原 receipt。原 candidate native/双 provider 发布链、员工工作区及递归提交用例保留，不用预设最终 Git 业务结论替代消费者。

对只有 baseline 的 scope 断言零临时分配；对缺失 overlay 的 createWorkspace 断言物理调用前拒绝；对 selected legacy getter 断言零读取，对 native hook 断言一次捕获。原四条 publication close 消费者都写完成回归。W29/oracle 只跟随真实 owner 和必要字段，不弱化规则、集合、测试预算或 CI 门。

有限设计功能门通过后实施。只做目标 format/lint、纯源码/JSON及一次原 scoped canonical；不运行本机 AW tests/typecheck/build/service。有限 SOURCE/metadata 功能门、精确发布和新 exact-SHA hosted CI 分别留证。完整 A1～A8/AC00/A-G、各层独立 CS adapters、M0 首次实际部署及 M1～M4 保持开放；尚无 AW-in-CS 部署，不关闭 RFC。

## DESIGN-R2：publication close 先于实际持久结算

DESIGN1 的有限 P2/FAIL 和原文保持。普通 Task 的 finalize 不只是构造返回值；它会按原顺序写 commitPushJson、nodeRun 终态和 repositoryEffect 成功收据。session 内直接 return finalize 会提前启动这些写入，随后才进入 finally；仅在原 finally 加 await 无法保证持久成功晚于 close ACK。

因此 Task 普通提交的 session 区间先收集原 outcome/extra，不调用 finalize。原 CAS、push、错误分类、日志及分支顺序保持；该区间的所有终态出口都在 publication close 成功 ACK 后才进入唯一原 finalize 本体，继续原 patch → node status → effect settle 的次序。pre-open 拒绝或其它不拥有 session 的早退保持原入口和时点；用户取消及原 CAS winner 仍由原 finalize 判定。close 拒绝传播原错误，不能留下提前写入的 done／pushed／effect.succeed；后续失败与持久 intent 对账沿用既有调用者，不添加新业务状态机。

新增真实数据库／原 node 与 effect owner 回归：实际 native Git remote 完成 push 后暂停 selected publication close，此时 node 及 effect 不得已有 terminal success；ACK 后才出现完整原成功收据。close 在该窗口拒绝时，操作传播该原错误，实际远端事实仍可回读，但 node 不得出现 done、effect 不得出现 succeed。测试使用实际 runCommitPush 消费者、真实持久行和原 transport 完整 receiver，不用 mock finalize 或只有 Promise 返回检查替代结算。递归子仓、employee fetch 和 candidate push 同时覆盖 close held/reject；全部原预算、断言和默认 native 关闭次序保持。

## 实施候选与有限验证范围（2026-10-04）

本批已写入 baseline-only acquire、六组 factory 根透传、native hook 单次捕获与独立 local fixture。四个 publication close 消费者全部 await；Task session 内只收集原结果，close ACK 后进入唯一原持久 finalize，九个原出口与 Git 策略保持。实际 Mission／DE Case、Task node/effect 与递归子仓、employee fetch、native getter、opaque/frozen receiver 和 same-tree/different-parent 回归已写，正式运行仍交发布后的精确 SHA CI。

23 个 TS 候选的纯源码证明恢复三个完整原根、Task 完整原 publication 区间、原 finalize 和完整 native candidate；六份旧测试的原断言／名称／预算保持。W29 只更新两个实际 body 摘要，所有原计数与规则不变。另将 RFC-321 四个直接 push 测试调用接到原 composition，同一旧文件逐字逆恢复；其余 22 个内容和成功证明复用。

第一轮纯证明丢失两个对象尾逗号、第二轮混用 AST SourceFile 导致数字 token 误投影，原 FAIL 程序与日志都保留。修正的是证明工具，生产候选不变。首次 22 文件格式检查发现新增 DE 测试未格式化，随后只格式化该文件；最终目标 format/lint 与源码证明通过，无本机 AW test/typecheck/build/service。当前仅待有限 SOURCE24 独立检视、匹配清单及发布；不表示完整 A-G、CS adapter 或 M0～M4 完成。

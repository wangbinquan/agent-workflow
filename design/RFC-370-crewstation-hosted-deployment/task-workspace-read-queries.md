# RFC-370 A4：Task diff 与 review repair 工作区读取切面

状态：有限设计候选，尚未实现。本批承接已选定的 SC workspace/Git 切面，覆盖 Task HTTP diff 与 repair 的实际读取入口；不编写 CS adapter，不关闭整个 A4 或 A-G。

## 已有合同与缺口

`source-control/public/queries.ts` 已提供 `WorkspacePresenceQueries.exists`；独立 local presence 实现已经存在，不复制其底层逻辑。`RepositoryGitWorkspaceFactory` 面向命令、子仓 discovery 和 preview index；完整 isolation factory 面向创建、恢复、合并与清理。二者不承担 Task diff 的完整 tracked/untracked 文本读取，也不提供 repair 所需的只读隔离位置推导。不要为了读取而调用有写效果的 restore/create。

实际入口是 `task-execution/infrastructure/taskRouteOperations.ts` 的 `taskDiffProjection` 与 `createTaskRouteOperations`。它们仍直接调用 `util/git` 的 `isGitWorkTree`、`gitDiffSnapshot`、`worktreeDiff` 和 `existsSync`。`taskRouteRepairOperations.ts` 的 `deriveScopeRoot` 仍在 Task 内以 `isoKeyOf`、`isoWorktreePathFor` 推导本机位置，再用 FS/Git 探测。真实装配包括 `task-execution/composition/providerRuntime.ts` 的两个 provider、`server.ts` 的不启动 runtime 的经典 HTTP 路径，以及 CLI/PG application roots。

## 完整中性查询与独立本机包

新增 SC application port `RepositoryWorkspaceReadQueries`，继承既有 `WorkspacePresenceQueries` 的 presence 合同，共有五项完整能力：

```ts
interface RepositoryWorkspaceReadQueries extends WorkspacePresenceQueries {
  isGitWorkTree(workspaceRef: string): boolean | Promise<boolean>
  gitDiffSnapshot(workspaceRef: string, fromCommit: string): Promise<string>
  worktreeDiff(
    workspaceRef: string,
    fromCommit: string,
  ): Promise<{ diff: string; truncated: boolean }>
  isolationRoot(input: {
    storageRootRef: string
    taskId: string
    nodeRunId: string
    persistedWorkspaceRef: string | null
  }): string | Promise<string>
}
```

`exists` 的 inherited 签名保持。所有 reference 只由所选实现解释；Task 不以本机路径 join、key 正则、FS 或 Git 对 opaque reference 二次探测。`isolationRoot` 只推导读取位置，不创建、恢复或认领资源；Task 仍决定何时查询最新 wrapper row、是否使用隔离位置及原 fallback。

完整 local 实现位于 SC `infrastructure/local`，复用现有 file presence 和原 Git utilities；隔离位置使用原 `isoKeyOf`／`isoWorktreePathFor` 原参数和语义，不复制或改写其规则。原 `gitDiffSnapshot` 的 rename、中文路径、untracked/no-index、Windows null device、原错误和换行行为完整保留。`worktreeDiff` 保留原 1 MiB 字符串长度裁剪与 `truncated` 结果，不改成 UTF-8 字节计数，也不新增预算。

SC composition 选择完整查询对象，public 只开放有真实生产消费者的合同和 selector。只有 undefined 选择 native；显式 null、缺失任一方法在物理调用前具名拒绝，不逐方法回落。保留 frozen/prototype/private receiver，不通过 spread 克隆或解绑定方法。既有只选择 `WorkspacePresenceQueries` 的调用者保持原职责；本批不以该旧 slot 悄悄改变 diff/repair 的历史 native 行为。CS 后续给新完整 slot 选择自己的独立 adapter。

## Task 原策略与实际接线

单仓先 load Task，再按原顺序检查 base commit；base 缺失先报 409。Git 工作树无效时才查询 presence，以原两种文案报 410；成功后等同一个 selected `worktreeDiff` 的完整结果，返回原 `baseCommit`。不在 base 缺失时提前做物理查询。

多仓先检查父 presence；按原 repoIndex 顺序逐个检查非空 base 与 presence，保持短路和候选顺序，再并行探测候选 Git 工作树。没有可用仓仍报原 409。readonly 过滤、规范仓库标题、空 diff、完整换行、剩余预算、表头占满及截断策略均留 Task 原体，只替换物理调用并等待 ACK。

repair 保持 definition/container/latest row 查询、原恢复键输入和 fallback 顺序。原适用分支才调用 selected `isolationRoot`，然后按原短路顺序等 exists→isGitWorkTree；有效才使用隔离 reference，否则原 task worktree reference。所选读取拒绝保持原错误对象，不因异步失败借 native 或把错误改成“目录不存在”。其他 repair 判据、SQL、持久化和 review dispatch 均不变。

两 provider 的实际 Task route compositions 和 server 经典路径透传完整 selected 对象。CLI、PG 与 HTTP application roots 选择并保留同一 receiver，重装配及 routes callback 不能漏传或被旧默认覆盖。直接调用 projection/repair 工厂且未提供新能力的历史调用者继续使用完整 native。所选入口不加入 CS DTO、网络客户端或服务宿主执行依赖。

## 功能回归与有限验收

保留原单仓、多仓、readonly、1 MiB/表头截断、task-read provider parity、wrapper review repair、所有名称、错误、断言和预算。source oracle 仅随实际 owner/地址投影，原 scanner/normalizer 和业务判据保持。

新增实际 Task diff/repair 消费者回归使用真实双 provider 数据与 native Git、冻结 receiver 和 opaque references；覆盖五方法、presence/probe/diff/root 的 held ACK、原 409/410 优先级与两种文案、多仓顺序/readonly/空与截断、有效/失效 wrapper fallback、原错误 identity 和不完整选择无物理调用。验证实际返回值、原 review dispatch 输入与持久事实；不以只测 selector 或模拟最终业务结论代替消费者。

设计功能门通过后才实现本批。仅做自有格式/lint、纯源码/JSON与必要原 canonical；不运行本机 AW tests/typecheck/build/service。真实行为以新确切 SHA hosted CI/Windows 和有限实现功能门验收。其余 delivery/conflict、DA/DE 校验、A1～A8/AC00 与完整 A-G 继续；其后独立 CS adapters，B/M0 先实际部署，再逐步 M1～M4。

## 2026-10-04 有限实现候选

上述设计首门 PASS `abb6ee3bfd0b0f9ce4dd776e8bbfbfe6be87c1a79d98b5d6e0d2b5a061a740bf`。其正文保留为原设计记录；当前已实现15个源码/测试路径，进入 SOURCE15-DOC1 有限独立功能门。SC application port、完整 selector 与独立 local 实现各一文件；Task 两个实际 diff/repair 消费者、两 provider、CLI/PG 和经典 HTTP 三根保留同一 frozen/prototype receiver。新查询默认复用原 native presence、Git 与 isolation 推导；原 presence slot 独立。

新增真实双 provider/HTTP 与 native Git 回归覆盖 tracked/untracked 中文内容、五方法完整选择、异步 ACK、原409/410优先级及文案、多仓顺序/readonly/空 diff/字符串长度截断、最新 wrapper 持久代际、原短路 fallback、所选错误 identity，以及真实 review dispatch/docVersion/audit。原 wrapper review source oracle 随唯一 native owner 地址投影，业务断言、名称和预算保留。W29保持完整原 normalizer及五个其他函数，只更新本批实际两个根的四个 literals：PG175、SQLite55和经典HTTP65 statements；三项摘要投影随实际代码更新。

纯源码 R3 PASS 对11个旧修改文件作完整 AST 形状与原始 comment 序列对照，证明仅含记录的切面/装配/地址变换；全部15个TS可解析且无重复对象属性。Task diff/repair不再直接探测native FS/Git或解释 isolation key。W29工具首轮缺少计数字面量假设，以及源码工具首轮 printer、次轮 template scanner 假设失败均保留；它们未修改原生产策略或测试规则，R2/R3使用原normalizer与完整parsed AST纠正工具判据。

仅目标format/lint、纯源码证明及后续一次原 scoped canonical；不运行本机AW test/typecheck/build/service。正式行为仍以发布后确切SHA的hosted CI与Windows为准，当前不宣称测试通过。提交/发布Git前批的Windows类型错误已经用持久字段 rerunCause 和原公开参数签名修复，`b905434e23f8dd670cccc6000ff8fe887a9c2805`的新CI待正式终态；原失败及取消保留。

本批只覆盖Task HTTP diff和review repair读取，不关闭delivery/conflict、DA/DE校验或完整A4；A1～A8/AC00/完整A-G继续，其后各层独立CS adapter，B/M0先实际部署，再逐项M1～M4。当前尚无AW-in-CS部署，不关闭RFC。

### 实现首门与 R2 夹具补正

SOURCE15-DOC1 首门 `74efcc621a14d1c76809161ccade2a68de9567c98b6f37376f791042a82c52b9` FAIL，两项P2均在新增回归，正式记录保留：Hono.request可能同步返回Response，直接then不能通过Typecheck；Proxy覆盖Object.freeze对象的自有方法违反语言约束，使实际repair派发抛TypeError。新测试一次补正：对同一次request结果用Promise.resolve；用完整普通对象转发native的全部方法，并以native receiver调用原dispatchReviewNode。仍验证真实docVersion/audit，原请求次数、测试名、断言、预算、frozen workspace receiver和所有14个其它TS字节不变。

R2仅针对这两项finding及文档追加复核，原未变化内容复用首门正文检视，完整候选仍核对首末SHA。格式/lint、完整AST/comment补正证明通过后才交门；不运行本机AW测试/类型检查，不用局部门冒称正式CI或A-G完成。

### 2026-10-04 Task diff／review repair 完整读取切面的有限交付

SOURCE15-DOC1 R2 有限独立 PASS `6810ac1409c1b961a61f019a55050c7f3da0d17b60b1ef503b699ec0dd322c52`；首门两项P2只在新增夹具，Response/Promise和frozen Proxy问题已经补正，其余14TS和原策略/W29规则字节保持。实际SC五方法完整query与独立native实现贯穿Task diff/repair、双provider及CLI/PG/classic HTTP根。新增真实Git/双provider回归保留ACK、opaque/frozen receiver、409/410、多仓顺序/readonly/空与字符串预算、最新wrapper代际和真实review/docVersion/audit；原断言与预算不放宽。

原四条规则一次scoped canonical只读已提交`b905434e23f8dd670cccc6000ff8fe887a9c2805`加本批冻结16路径，6382个非自有TS取完整committed blob，排除观测的一个tracked及四个untracked TS在制文件；13份输出先生成于私有文件。sourceDigest `sha256:3df159a4dc1ad7036b65be8092f4a904a3d26ca6e9dbbbad1a0f829e0445b66a`。原完整JSON validator已通过。实际entry+1、import+11（17新增/6退役）、exception+5（11新增/6退役）、public+2、owner+6；129行顺序/原why、40 SPI/69 target/空SCC、原debt及effects不改。五项实际增长按原协议登记，匹配提交后另行退役。

Git类型修复`b905434e23f8dd670cccc6000ff8fe887a9c2805`的Windows37193750893正式completed/success；主CI37193533285尚未全套终态，Ubuntu前端3/3的111410608298已确定失败，`rfc371-run-observability.test.tsx:1120`返回弹窗来源Task预期task-1但得到null；日志保留，不改原断言或以Windows替代主CI。更早5490的主CI取消与Windows失败保留。当前批次正式测试仍等待发布后新exact-SHA hosted CI。

仅目标format/lint、纯源码/JSON和一次原scoped生成，无本机AW tests/typecheck/build/service。不关闭完整A4或A1～A8/AC00/A-G；delivery/conflict、DA/DE校验及执行/脚本/执行权恢复继续。其后各owner独立CS adapter，B/M0先实际部署，再逐项M1～M4。当前尚无AW-in-CS部署，不关闭RFC。

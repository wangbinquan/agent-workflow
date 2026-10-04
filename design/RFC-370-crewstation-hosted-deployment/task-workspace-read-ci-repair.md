# RFC-370 Task workspace reader CI 修复

状态：有限设计候选；尚未实现。当前任务读取源码 `ac024a495d56cea535a2cc22861891dd987ee322`、canonical `9c614ec7e00d63ae6256f00b0e02618ed13bd41d` 与五许可退役 `ae7654de662f29fc720402e574bf7267b1e7e53d` 均已正常上库。此次只修已确认的两类 CI 回归，不扩充 Task 或 CS 行为。

## 确切失败与作用范围

`9c614ec7` 主 CI 37196589476 已 completed/cancelled：50 jobs 为 11 success / 2 failure / 37 cancelled，失败为 depcheck 和其聚合。Windows 37196589510 已 completed/failure 1/1。原日志分别来自官方 job 111419663579 / 111419663433，完整文件保存在 `/tmp/aw-rfc370-task-workspace-read-queries-job-111419663579-api.log` 与同前缀 `job-111419663433-api.log`。不把取消、后继或单项成功改记为本 run 通过。

Windows 三个 TS18046 位于新增读取测试 193～195：普通 Response.json() 的返回类型是 unknown，原 body.diff 直接读取缺真实响应体类型。只将这一 body 注解为既有 RepositoryWorkspaceReadQueries.worktreeDiff 返回类型加 baseCommit；完整 response status、toEqual 和三个内容断言与原预算保持，类型擦除后 JavaScript 全文不变，不改生产响应或用 any 吞掉类型。

主 CI 的唯一新 no-circular 边为 SC composition/repositoryWorkspaceReadQueries → local/fileRepositoryWorkspaceReadQueries。真实链为 local reader 引入完整 platform/workspace/local/isolation，后者读取 SC public/queries，再进入该 composition。不能登记额外允许边，也不改变 no-circular 或 scanner。

## 修复设计

把原 isolation.ts 中相邻 isoKeyOf / isoWorktreePathFor 两个纯地址函数连同原注释逐字迁到同 owner 的 `platform/workspace/local/isolationReferences.ts`。新叶子仅依赖 node:path 的 basename/join，不引入 Git、Task、SC public、FS 或运行资源。完整 isolation.ts 从该叶子导入内部实际使用的地址函数，并以原名 re-export，services/nodeIsolation 的既有兼容导出不变。local workspace reader 改为引用这个纯叶子。原所有参数/返回、persisted key fallback、空值/目录分隔符、node run generation 与多仓地址算法不变，没有第二份实现。

原 native worktree 生命周期、SC 公开查询、Task diff/repair、selected complete receiver、404/409/410、1MiB clipping和业务持久化全文保持。新回归证明 leaf、完整 native 与 legacy API 指向同一函数，并经实际 native-selected isolationRoot 检验持久旧键/新代际/空值引用；原相关 isolation、repair、双 provider 和预算保持。纯源码证据重建原 full isolation 文件：替换导入/导出并放回两个原函数后逐字相同；新叶子函数逐字同原；新增测试的原类型擦除JS及所有原断言保持。

设计有限功能门通过后实施。只有目标 format/lint、纯 byte/AST/JSON及一次原 scoped canonical，正式 typecheck/depcheck/行为由新确切 SHA hosted CI 验证；不运行 AW 本机 tests/typecheck/build/service。未完成的 A1～A8/AC00/A-G、Conflict设计、CS独立 adapters、B/M0～M4均保持开放，尚无 AW-in-CS部署。

## 已实现候选与有限证明

DESIGN1 独立 PASS，指纹 `8c9c36a988cbdbf94e8c79f9950edac33deafcfbc035222918753271125aee60`。五个 TypeScript 路径已实现：完整原地址声明和注释逐字迁移，native 内部只导入确实使用的 isoWorktreePathFor，并 re-export 两个原函数；reader 仅改叶子 import。首轮精确 lint 检出多余 isoKeyOf 内部 import，已仅移除这一未使用 binding，公共出口保持；原诊断记录保留。

新增测试的 body 使用既有 worktreeDiff 返回值的 Awaited/ReturnType 加 baseCommit 的类型断言；逆向该一个擦除型表达式即逐字恢复整个旧测试。response/status/toEqual/三项中文与 tracked/untracked 内容断言、全部名称与超时预算保持。新回归锁 leaf/native/legacy 单一函数身份及实际 selected native reader 的旧 generation/空/null 引用回读。

纯源码证明 PASS：native 完整原文件逆变换及原函数/注释字节相等、reader 唯一 import 改动、完整旧夹具逆向、完整新回归等于已记录文本、五 TS parse clean，其余设计 controls 保持。目标 Prettier/ESLint 通过；无本机 AW test/typecheck/build/service。implementation功能门、一次原 scoped canonical及新 exact-SHA CI仍须完成。

ae7654de 的人工 Windows37196996310 已正式 completed/failure 1/1，主 CI37196879491 当时仍运行且 depcheck 作业已经失败；它们各自保留，不使用局部结果写整体成功。当前类型和循环修复从上文 9c 的正式原日志定位。完整 A1～A8/AC00/A-G、已设计但未实现的 Conflict切面、各层独立 CS adapters 和 B/M0～M4继续，尚无 AW-in-CS部署，不关闭RFC。

## 2026-10-04 Task workspace reader CI 修复投影

Task reader CI 修复 SOURCE5-DOC1 独立有限 PASS，指纹 `899180ddebb19b9b0186f1297b0b701b33137095566793bb2453ff4ae8b8b5a1`。两个原纯地址函数和注释逐字迁到同 owner 的 isolationReferences，native 原名出口与函数身份保持；reader 仅改叶子引用，从实际 no-circular 链拆出完整隔离模块。新增测试只给 JSON 响应补真实返回合同的擦除型类型断言，完整旧测试可逆向逐字恢复，全部原内容断言及预算保持。new leaf/native/legacy 与真实默认查询的引用回归已写。

原 scoped canonical 只运行一次，固定 ae7654de 加五个 TS 候选，其余6394个 nonowned 源码全部按已提交 blob读取；排除并完整保留并行观测17 tracked / 4 untracked TS。sourceDigest `sha256:0b89825f380acb270867144f623daf295a41a725abec08e6979ddd60bdc1e1ed`。原两符号的边改指纯叶子，imports6106、exceptions5411数量不变；localIsolationWorkspace 旧 isoKeyOf import未改，原扫描器因native现在re-export将其 target owner投影为完整文件owner，只有该owner字段变化。原required40 SPI / 69 targets、空implementation SCC、public面、全部债与effects、Task authority及504 ambient保持。新leaf一个fileowner及两个迁位函数，3 added / 2 retired净增1，原owners26535→26536。只登记这一实际增长许可，匹配canonical发布后正常退役，原129 ordered rows / why保持；不改任何rule、allowlist、周期或预算。

9c614ec7 主CI37196589476正式cancelled 11 success / 2 failure / 37 cancelled、Windows37196589510正式failure1/1，原完整日志保留。ae7654de Windows37196996310已正式failure1/1，主CI37196879491的depcheck也已失败；本段是生成前冻结的作业事实，不是主CI整体终态。修复的新确切SHA正式CI仍待发布验收，旧失败不改写。仅精确format/lint、纯byte/AST/JSON和一次原官方静态生成，无AW本机tests/typecheck/build/service。

Conflict DESIGN-R2另已独立PASS，只是设计、尚未实现。完整A1～A8/AC00/A-G继续，之后各层独立CS adapters，B/M0先实际部署再逐项M1～M4；尚无AW-in-CS部署，不关闭RFC。全部旧正文、并行输出与gate/CI历史保持。

# RFC-370：工作区上传内容切面

这是已批准 A2／A3 的下一批中立重构。归档内容 SOURCE37 须先独立完成发布与验证；本批先固定设计与原行为，再实施源码。CS adapter 仍在完整 A-G 后编写。

## 当前调用链与边界

`task-execution/infrastructure/taskRouteLaunchOperations.ts:788-819` 是 PostgreSQL／SQLite、普通 Task／Agent／Workgroup 共用的真实上传消费点。`taskWorkspaceUploads.ts:18-94` 持有原 requestDigest、preparation journal、placement reserve 与 completeUploads；`services/upload.ts:423-541` 把原验证、命名、打包、重放与回滚政策和物理读写放在一起。两份实际 crash/admission 夹具仍调用原 helper。此前的 `write?` 替换只用于中断 oracle，不能作为完整 adapter 切面。

业务政策归 task-execution application：原限制／accept／数量／重复目标校验；顺序、默认 rename／显式 overwrite；999 次候选名称上限；重放选择；packedByKey／多仓 inputs 前缀；失败时清理本次新增项并保留首错误。journal 的所有原 SQL、版本／owner、requestDigest 字段名及顺序保持。workspace 字节机制归 source-control 的独立 local adapter，通过 exact public types／participants 接入。

## 完整内容合同

新增 SC `application/ports/workspaceUploadContent.ts`，不改变既有只读 WorkspaceContentEffectsFactory。完整 `WorkspaceUploadContentFactory.bind(binding)` 返回同一 receiver；binding 含 opaque workspaceRef 与可选 generation／version，只有选定 adapter 解释。构造和选择没有 IO。

完整 receiver 提供六个操作，全部允许同步或 Promise ACK：

- `prepareTarget(relativeDirectory)`：返回 opaque directoryRef 和原 packedDirectory 投影；本机实现保持原目标准备的调用序列。
- `file(directoryRef, filename)`：返回 opaque fileRef；本机实现保留原文件定位与原错误结果。
- `entry(fileRef)`：返回 `file / directory / other / missing`，不公开 Stats。
- `read(fileRef)`：返回 Uint8Array。
- `remove(fileRef)`：删除该内容项。
- `write(fileRef, bytes)`：创建该内容项；本机实现保持原写入方式。

AW 不把 opaque refs 拼成宿主路径，不用真实目录的存在性作为另一个 adapter 的 fallback。全部效果都经过同一绑定。显式 null／不完整 factory 或 receiver 报明确选择错误；只有 undefined 选择完整本机默认。冻结实例、prototype 方法和 private receiver 保持。

application 用单一政策驱动同步兼容与异步执行，避免另写一份 rename／overwrite／replay 业务规则。纯字节比较继续满足原 complete-byte 相等，不引入截断。所有原 exported legacy helper 保持签名、结果与函数身份；涉及真实物理位置的兼容 helper 留独立 platform local 包，旧 service 直接转导；中立模块 public 不发布 Buffer／Stats 或物理根 helper。公共中立结果可用 ReadonlyMap，旧可变 Map API 在 native 兼容面完整保留，不能为了类型清单收缩旧接口。

## journal 与 ACK 顺序

1. 原 validateUploadPlan 在任何内容效果前完成。原 task preparation 仍先于上传。
2. 原已有 uploads receipt 先核 requestDigest 并回读 packedByKey，不重新 bind 或写入。
3. 单次 bind 后依原提交顺序逐项 prepare、选名。原 persisted placement 优先，不再产生 `(1)`。
4. 新 placement 的原 reserve/version checkpoint ACK 先于内容写入；新 write ACK 后才登记本次 written。
5. 恢复项先 entry；已有 file 的 read ACK 与完整 bytes 一致后复用，没有内容时使用原 write 分支。差异继续原 upload-replay-changed。
6. 全部内容 ACK 后才 completeUploads，再进入原 task admission。任意错误进入原顺序 rollback；每项 remove ACK 完成后再继续，清理失败不覆盖原失败。已 overwrite 的旧内容仍按原行为不回填备份。

原 `write?` 整体中断 oracle 和原未传参数调用保持；所选完整 factory 与有效整体 write override 同时出现时必须明确处理选择冲突，不静默忽略 selected。普通业务路径不以该测试 hook 作为 adapter。

## 装配与实施范围

三实际根（CLI 初建／重装配的 SQLite／PG，standalone HTTP）选择同一 raw factory，并经 provider routeLaunch、两种 SQLite launch factory、RootTaskLaunchDependencies 传入真实 kernel；PG 的已装配 route operations 优先语义保持。根内的 Task／Agent／Workgroup／后台参与者共用上传路径。`RootTaskLaunchDependencies` 缺选择时为旧直接调用提供本机默认，真实根不逐方法补默认。

预计触及：旧 upload service／taskWorkspaceUploads／共用 launch kernel／SQLite launch factory、TE upload application／domain／composition、SC 新 port／local／composition／public types／participants、platform 兼容机制、三 roots／provider，以及直接相关测试。归档内容本批的冻结文件在其发布前不改写；分批源码门的 controls 只核稳定性，不重开已通过的归档门。

## 功能验证与退出

保留原 upload-apply-to-worktree、RFC262 overwrite、RFC363 admission/crash 和双 provider launch parity 的完整断言／名称／预算。源码地址断言只能跟随实际机制迁位，不能调整判据。按原 AST／byte census 保留所有数据库子树和未改正文。

新增 positive 功能覆盖：完整 prototype/private/frozen factory；opaque refs 与 generation；held prepare／reserve／write／read／rollback ACK；新 receipt 前不 admit；同 placement 重试无另名；rename／overwrite／根／多仓 packed 路径；完整字节 replay；同步／异步与 callable Promise；任意拒绝、rollback 次失败与原错误优先；selected 不读取本机位置；真实双 provider launch；三根及 provider 重装配的一次选择与同一 identity。

本机只做定向 format/lint、纯 AST/JSON/byte 证明与原 scoped census。正式行为由新 exact-SHA hosted CI 判断；限定设计／源码门通过不等于完整 A2／A3／A-G 或部署完成。

## R2：旧 native helper 与可变 Map 的具体兼容机制

原六方法 factory 保持，不为旧 helper 增加方法，也不改现有 WorkspaceContentEffectsFactory。以下只落实上文的单一政策与旧 API 兼容，归档 SOURCE37 的正式验证仍先于本批源码实施。

原 `resolveUniqueName(dir, filename)` 在不存在的目录也只探测名称，不创建目录。其完整 native API 留 platform/content/local，旧 service 直接转导同一函数。TE application 的一个私有 name-choice policy 保留先原名、再 1…999、原 stem/ext 规则和原终态错误；selected 上传 policy 将同一 name-choice 的 probe 逐项解释为同一 receiver 的 file/entry 并等待 ACK。原生兼容 helper 则经 exact TE public/queries 的窄同步 `resolveUniqueUploadNameSync(filename, isTaken)` 驱动同一私有 policy，native `isTaken` 仅调用原 resolve/entryExists，不调用 prepareTarget、不增加 mkdir。这个同步 query 的公共签名只有 string、boolean 与函数参数，不暴露 Generator/Iterator/Stats/Buffer，也不是第二套 adapter registry。业务 kernel 的真实上传仍只消费完整六方法 factory；同步 query 仅服务原生 helper 兼容，不提供所选 factory 的逐方法 fallback。

默认 native factory 的六个操作原样解释真实定位和读写；TE policy 保留原 overwrite/replay/rollback 顺序和错误结果。非 exported 的旧混合 helper 可机械拆开：物理定位和 lstat/读写进独立 local，业务选择和原错误条件进入单一 application policy；没有另留一份 dead overwrite/rename 业务主体。原生导出的 assertInsideWorktree 保留完整签名和物理机制；原 resolveUniqueName 的探测顺序、无目录创建、999 次界限和全部返回/错误用例保持。同步和异步 driver 只解释 policy 请求，不各写一套候选命名规则。

中立 `WorkspaceUploadResult.packedByKey` 声明为 ReadonlyMap。单一 TE policy 内仍按原提交顺序创建实际 Map 和 string[]；native `UploadResult` 在 platform 兼容面保持原 Map<string,string[]> 完整类型，applyUploadsToWorktree 返回同一实际结果/Map，不复制成新 Map、不改其可变 API 或顺序。旧 UploadPlan 的 worktreePath、defs/files/limits/recovery 与原 requestDigest 字段均保留；转换到六方法 binding 时把该引用作为 opaque workspaceRef，并透传可用 generation/version。public 中立入口不因原生兼容新增 Map/Buffer/Stats opaque 豁免。

源码门需额外核对两个实际兼容例：resolveUniqueName 对不存在目录仍无 mkdir；旧可变 packedByKey 可 set/delete 并与兼容返回保持同一实例。保留所有原 helper、覆盖/命名/重放断言和预算；任何必须迁位的源码地址只跟随真实函数和政策位置。全部业务 journal/SQL、主路径 reserve→write ACK→written→completeUploads→admit、失败清理和首错误保持原设计，不做新的恢复语义或 CS 实现。

## R3：本机同步批次与原可变结果的实现约束

原 applyUploadsToWorktree 是 async 函数，但没有 recovery.reserve 时，其目录准备、逐文件选名/写入/清理全部在首次返回前同步完成。中立改造不能对每个同步效果无条件 await：两个同目录的旧直接调用因此可能同时看到同一个空名称，再让第二次原本可成功的 rename 写入变成 EEXIST。完整上传使用一份私有 policy，driver 对同步返回立即继续，仅对真正 thenable 等待 ACK；检查 thenable 时兼容 callable Promise。六方法 receiver、bind 的同步返回也走这一规则，原 reserve Promise 的等待位置保持。driver 的错误投递使原政策 catch 能逐项等待 rollback 并保留首错误，不新增另一套业务 loop。

原同步 resolveUniqueName 仍用同一私有 name-choice policy 的同步 probe query，不创建目录。增补真实 native 并发直接调用回归，验证无 recovery 的两次默认 rename 保持原不同落名；所选异步 receiver 的 held ACK、reserve/write/rollback 顺序继续原 R1/R2 判据。

旧可变 UploadResult 的兼容桥不复制结果/Map、不作压制类型检查的强转。platform native 兼容面可使用私有结构 type predicate，验证中立结果的 packedByKey 是实际 Map 后，将同一对象收窄为原 UploadResult 并返回；单一政策按原方式创建 Map 与可变 string[]，该分支对当前政策保证始终成立。public 中立结果继续 ReadonlyMap，不增加 opaque 豁免。原 Map set/delete 与数组可变 API 的兼容回归覆盖实际返回，不能为迁位改变旧调用者的完整类型。

这里只具体约束 native 时序和结果类型桥，不改变 R1/R2 六方法合同、journal/SQL/digest、根选择、原 overwrite/replay/首错政策或 CS 顺序。原设计全文保持；归档 SOURCE37 发布后的正式验证仍先于任何上传源码实施。

## 2026-10-04 有限 SOURCE24 与实际清单记录

SOURCE24 独立功能门有限 PASS，指纹 `daca3967932cf720464fa9c03cae806ecab160dedac0a7e51db777b9048a98a2`；24 owned、14 controls、11 evidence 首末稳定。SC complete factory/六方法 receiver 只解释 workspace/content 引用，TE 保留一份原上传政策；native 同步效果不产生额外 await，旧 helper 不创建目录，旧可变 Map/数组与结果对象身份保持。真实 journal、Task 启动内核和 standalone HTTP multipart 双 provider 回归已写。

原七项业务声明、四项物理 helper 的完整 AST、digest/SQL callback/receipt replay、四个根的原内容、12 个旧 service 出口及 13 份旧源码/测试控制保持。原完整 whole-writer 测试 hook 保留；与显式 selected factory 同时选择时在原 receipt 重放之后明确报错。reserved placement ACK 先于写入，write ACK 先于 written/Task admission，异步回滚有序且首错保持；实际写入后丢 ACK 的重试沿已登记文件名完整字节复核。

一次原 scoped census 基于已提交 `766138c5e371e4b6724458014cd8306878d086dd` 加冻结 SOURCE24；非 owned source/test 使用 exact committed 内容，并行 native page/pump 及前台 WIP 保留、排除。四份原规则不变；sourceDigest `sha256:6c9bcf68d1870290bc9b090ab9e55acfe743ee9ca39efda4a5576c6992fc5b1d`。实际五项增长为 mutation1857→1862（六增一减）、observed imports5983→6015（36增4减）、exception projection5323→5347（28增4减）、public1100→1116（16实际已消费出口）、owners26419→26449（九新生产文件46增、旧service16减）。按原协议登记五项一次回执，匹配 canonical 提交后正常后继退役；129项原有序库存/why、302项原债务全文、40 required SPI、69 target edges 和空 implementation SCC 保持。两项 Task 写点仅 id/line 投影856→859、941→944；14项 ambient root 记录只移行，业务正文保持。原 C2 双向精确相等证明通过。

前次 CI 修复 SHA `de5f90ae80ffdcc4af83fe0a1d39dd01937667a9` 的四个受影响后端 job111317745474/111317745496/111317745535/111317745537、主 Lint/Typecheck/Format job111317745523 和 Windows37162413399 全部 completed/success，满足 SOURCE37 有限正式验证依赖。主 CI37162165195 则 completed/failure（43成功/7失败）；六个浏览器作业及 aggregate 原失败保持。观测失败由并行 owner 接续；macOS四个其它 flaky case 的 daemon-ready timeout 原日志保留，不用后续 retry pass 改记成功。本上传批次仍待新 exact-SHA hosted CI。

本机仅目标 format/lint、纯 AST/字节/JSON 和原 scoped 生成，无 AW test/typecheck/build/service。目标 lint 首轮缺少 HTTP effectiveDeps factory handoff 与 prefer-const 两处 FAIL、首次 AST 根逆变换的分隔 token 误判均保留，源码和证明工具分别修正后有限 PASS；未改变原政策或放宽原回归。完整 A1–A8/AC00/A-G 继续，独立 CS adapters 仍在完整 A-G 后，B/M0先实际部署再逐项M1–M4。尚无 AW-in-CS 部署，不关闭 RFC。

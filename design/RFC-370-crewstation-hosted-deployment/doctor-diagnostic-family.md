# 独立 Doctor 诊断效果家族

本增量属于已批准 RFC-370 阶段 A 的专用诊断入口。验证命令家族先独立完成有限发布；本设计不将其未完成的 hosted CI、H7、A-T7/A-G或CS适配记作完成。阶段B仍先M0实际部署，再逐项M1～M4收编。

## 实际入口与原职责

独立 CLI 的 main.ts doctor arm 调用 cli/doctor.ts。配置查询已有 system-operations/composition/doctorConfiguration.ts 的 lazy read 合同，但当前 Doctor 仍直接解释本机文件、runtime driver、git／ssh进程、数据库运行环境及备份目录。仅传入 configuration 没有替换完整效果。

本批归 system-operations owner。已有 CheckResult／DoctorResult 以及 evaluateGitCheck、evaluateSshCheck、evaluateLifecycleHealth、evaluateMigrationsStatus 和 formatDoctor 的唯一规则迁入其 application／domain；所有准确公开名、签名及输出由 cli/doctor.ts 的 native compatibility facade 保持。既有 native 检查函数整体迁入 infrastructure/local，实际代码完整保留，不能在另一个 adapter 复制应用判据。

## 完整中立合同

application/ports/doctorDiagnostics.ts 定义 DoctorDiagnosticsFactory 与完整 DoctorDiagnosticsFamily；普通 composeDoctorApplication 必须选择工厂，无隐式本机默认。工厂的 create 接收本次选择的可选 ApplicationConfigurationQueries，在一次 run 的原配置装配位置创建家族；同一实例用于原三处配置消费者，不缓存或提前读取。所有调用保留对象 receiver。

家族包含 loadRuntimeConfiguration、probeRuntime、git、ssh、home、configuration、installation、migrations、database、backups。loadRuntimeConfiguration 返回已有配置中的 opencodePath 选择引用或 undefined；普通层只转发，不解释为本机路径。probeRuntime 返回原 binary显示字段／version／可选ran，普通层仅使用原 ran判据，不加入 compatible或版本门槛。其它检查返回原 CheckResult 或原 readonly CheckResult数组，并允许同步或异步完成。数据库诊断保留 provider实际operations与close ACK，不以进程成功伪造数据库健康。

唯一共同执行顺序、config读取异常的原忽略边界、runtime availability结果、各检查顺序、最终checks.every与格式化保持。每一所选检查的ACK先于下一检查与完成；factory、probe或检查的异常与缺成员保持可见，不回落本机。每次run重新create，不缓存live配置或对象。

## 本机配对与兼容

composition/localDoctorDiagnostics.ts 显式导出 native工厂。main的实际doctor arm必须显式选择它；未来CS安装根在同一中立组合合同选择自己的独立实现。旧doctorCommand(selected?)只作为准确native兼容入口转发同一工厂与配置，不承担第二套逻辑。

local工厂将原文件默认配置查询的创建保留在create时；loadRuntimeConfiguration保留原 selected存在／本机config存在的条件及原read receiver，原两处配置诊断接收同一个configuration和相同presence参数。原git／ssh完整spawn选项、输出读取与退出码处理，以及所有旧辅助函数的完整参数、语句、await／finally／错误边界保持。既有其余native函数仅做源码整体搬迁与引用地址调整，不作语义扩展、检视或新任务。

现有公开辅助函数保持value identity。原Windows适用性、provider分派与关闭、缺配置及compiled migrations行为不改变；旧源码reader及spawn登记只跟随真实native地址，保留原判据和预算，不扩大扫描规则。

## 功能验证与发布

固定原Doctor全文件及main doctor arm前像；每个迁移函数完整AST保持，共同规则完整还原，原调用顺序和原三处配置调用可逆。原所有测试名、断言和预算保留，仅作准确绑定／地址逆向；既有非本批函数保持原字节，不作额外分析。

新增所选opaque引用、private／prototype receiver、工厂每次创建、10个ACK阶段与原异常边界、ran与version原判据、完整排序／最终ok／输出格式、缺成员不回落、真实native配置和数据库入口及实际main选择回归。有限fixtures不替代CS接受或正式部署证据。

设计门通过后才实现；独立源码门、一次必要原matching census、有限元数据门和exact-SHA CI分别留证。本机仅自有format/lint、纯源码／AST／字节／JSON；不执行AW tests/typecheck/build/service，不更改既有检查规则、能力或预算。

## 实现候选与当前证据

Doctor DESIGN-D1 已独立有限 PASS（1 owned／11 control，首末12项字节稳定）。本批8个生产文件将完整10成员诊断家族、唯一共同执行顺序及纯结果／格式规则落入 system-operations；main 的真实 doctor arm 显式选择 local 工厂。旧 CLI 公开名、签名与辅助函数 identity 保持，同一所选配置仍在每次 create 后供原三处消费者使用。普通执行不解释 runtime selection；各检查完成后才进入下一项，缺少成员及配置读取之外的异常保持可见。

新增31个功能用例覆盖原型／private receiver、不透明引用、10段 ACK、每次创建、原 ran／version 判据、读取失败边界、缺成员／其它失败、最终结果与格式，以及真实 native 配置和 main 装配。五份旧 reader 只迁移准确 source 地址或 native 配置函数 owner；完整原 AST／全部136个 expect 调用及原预算保持。Windows 的12条路径在 push／PR 对称登记，新增4个适用 suite，完整原 workflow 可逆恢复。

纯 AST 证明完整保留19组原规则、native 调用及 main 函数。第一次格式化后的 proof 因一条 join 表达式被换行而不能作文本逆向，已改为该唯一地址表达式的完整 AST 逆向，生产及旧断言未变；失败记录保留。自有16文件 format 与14份 TypeScript lint 通过，没有运行本机 AW tests/typecheck/build/service。源码实现门、必要 matching 清单、发布及新 exact-SHA CI 仍分别待完成，以上不表示 A-G、CS adapter 或部署已完成。

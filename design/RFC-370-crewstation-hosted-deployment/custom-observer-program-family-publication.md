# RFC-370 自定义观察程序发布配套

状态：阶段 A 实现与匹配候选，尚未完成完整 H7、A-T7／A-G 或 AW-in-CS 部署。原[功能设计](custom-observer-program-family.md)保留历史候选记录。

独立设计门 DESIGN-D1 已有效 PASS。首实现门 SOURCE16-R1 有效稳定 FAIL，发现兼容入口提前读 store／两次读 now，以及双 provider 测试漏算 publish 的再次 validate。两项都修正：构造时只读取原 now 一次，store 在 run 时转发原 getter、保留 receiver 和后续抛错；原 publish 业务再验证保持，测试断言四次完整七成员调用与 null／null／null／next2 cursor。新增 getter 时点／热读／clock／receiver／late-error 回归。R1 回执和全部候选保持，未变38项沿用已完成的功能分析。

SOURCE16-R2 有效稳定 PASS，16 owned／22 control／4 evidence，共42项；指纹 `d622818729f87bf2b0bef30fbc46d9d5faea1193243282ebb6b19775a3323453`，回执145291 bytes，SHA256 `1faf967d97033034ba0e929057f914059fa56def434aa01184dd931fb5a20442`。共同 application 保留唯一 execute 与 run／validate 政策；完整七成员 factory 提供解释器、工作区、准备、输入／程序写入、执行和 finally 清理，opaque 引用只由所选 implementation 解释。全部原 native 调用与参数、三个纯 helper、cleanProcessEnv、兼容签名、原 ACK／finally／错误边界以及三真实 root＋module 完整 SourceFile AST inverse 保持。

SQLite CLI、PostgreSQL CLI、standalone HTTP 和真实 Event Center module 显式选择同一 factory。W29／MCP 原读根摘要及所有旧 expect／预算保持，增加精确选项 inverse；原真实 Node脚本与双provider回归完整保留。新测试覆盖每成员 ACK／失败／缺失、prototype receiver、opaque、sync、构造失败、cleanup 边界、全部原输出／cursor／fixture／source规则与双provider validate→publish→worker→重装→dedupe。Windows 新增11条 push／PR 对称路径和4个适用 suite，原workflow完整byte inverse保持。

一次原 scoped census 使用完整 committed `21bc9a630e928282f825a82da240444d76c07a1c` 加冻结 SOURCE16-R2 的11 production；所有非本片源和四原规则读自完整已提交人口，只向私有目录生成13 matching，sourceDigest `sha256:1245f5a9250663c502f4a024ac8ec808d976ddf99775d56f97e582e506d039f8`。359条原authoring debt中保留359条，仅退役0条实际消除地址，新增0条实际原分类地址，共359条；不改变原classifier、DAG或泛化例外。129有序库存及why／原字段、全部guard判据和顺序、40 SPI／69 targets、9 Task effects、原SCC保持。计数差额仅登记实际原人口测量：

| 原库存                                |  前值 |  后值 |
| ------------------------------------- | ----: | ----: |
| rfc294-mutation-entrypoints           |  1926 |  1929 |
| rfc294-cross-context-observed-imports |  6712 |  6720 |
| rfc294-architecture-exceptions        |  5911 |  5919 |
| rfc294-module-symbol-owners           | 27169 | 27189 |

正常退役0项实际前继已消费许可，只声明4项真实增长；下一普通后继退役本批许可。background差额逐条来自冻结源，不据静态匹配声称新增业务后台任务。私有准备阶段曾在文本替换assert停止，尚未执行census或写共享产物；修正私有准备后使用同一候选，原失败记录保持。

CI 与实现门分别留证。已发布12ca的Windows `37479031030` 正式failure：原MCP完整根功能套件通过，剩余五项启动恢复旧测试readonly类型错误；普通后继21bc只补对应测试类型及其文档／STATE，生产语义保持，该后继Windows37480455083正式success，主37480454971在冻结正式快照仍queued／conclusion为空。12ca主CI及后继主CI未取得完整绿结论。本片尚待精确发布和新确切SHA双OS／双数据库CI；未跑过的hosted用例不计通过。

本机仅 scoped format／lint、纯 AST／byte／JSON和一次原静态生成，没有 AW tests／typecheck／build／service。完整共享STATE旧正文及所有并行输出逐字保留。后续完整H7执行权／后台生命周期、剩余purpose callers及全根A-T7／A-G继续；CS独立adapters尚未开始，先M0必要适配和首次实际部署，再M1～M4逐项接入与完整RFC验收。RFC保持In Progress。

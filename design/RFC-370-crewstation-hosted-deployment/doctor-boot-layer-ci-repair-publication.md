# RFC-370 分层与事件观察程序 CI 修复发布记录

状态：阶段 A 的有限修复；完整 H7、purpose 调用者、A-T7／A-G、CS adapter 与 M0～M4 仍待完成，aw 尚未部署 CS。

正式 ecf 主 CI `37488310589` 和 Windows `37488310616` 的功能失败逐项保留。主 CI 在冻结快照为 `completed`，conclusion 为 `failure`；Windows 正式 failure。不以旧 Windows 成功或单个实现门宣称整仓绿，也不重跑旧失败以覆盖记录。

本片保留原 Git 版本规则的完整接口、五个 pure value、版本阈值、文案及 helper identity，在 `platform/contracts/gitVersion.ts` 唯一实现；原 services facade 直接 re-export，native probe、20s、cache 和三个原入口原样保留。Doctor domain 消费无 IO 叶层。三原架构用例只同步完整十三行的排序、一个实际 provider 选择地址及固定十步协议 oracle 的具名 NOT_A_LEDGER 登记；原 classifier、扫描范围、旧条目与断言保留。

Boot factory 首设计经 public/types 暴露，SOURCE18-R1 曾有效稳定 PASS；随后第一次原 scoped census 在 canonical validation 正式失败 `public surface opaque type allowlist mismatch`，没有生成成功或应用产物。旧候选、门回执、开始标记及日志全部保持。补正设计门通过后，原 factory 仅在现有 bootstrap `composition/bootRecovery.ts` type-only 导出，两个 CLI 并入原 composition import。public/types 全文件等于原 committed 字节；四个涉及文件完整 byte inverse 和整个 type-erased JavaScript 相同。原恢复四步、输入、所选 native family、getter 时点、receiver、ACK、错误、结果和原 reader 全部保持，未加宽 public opaque allowlist 或任何原生成规则。

Event Center 已加载的原 selector 与原 factory type 直接从现有 exact composition 导出，三个 root 仅移动并合入原 exact import。四文件完整 byte inverse，原 RFC310 architecture test 和 manifest 完整不变。observer fixture 的四条 readonly expect 泛型和一个 never getter 仅为类型修正，全部 87 expect 和整个 erased JavaScript 保持；原真实 native source 测试保留四次串行执行、每次原 10s 及 109 expect，单独 whole-test timeout 明确为 50s。原 Windows workflow 全文 inverse 保持，仅对称添加 pure 合同／facade／capability suite 触发路径及该 suite，Boot composition 已有对称覆盖。

补正 SOURCE18-R1 有效稳定 PASS：18 owned／35 control／5 evidence，共 58 项，指纹 `42630bab0a28b2e24188c3966fc88009f1f0ca5c6ad0c1ce4ae79a4e2feb03c3`，回执 223868 bytes／SHA256 `035c4c4e69eb4cbed560543ce6d8c49bbdf34b1609292ed8c9d89e87f178bf7f`。前次 PASS 中未变 42 项完整内容复用，独立门只复核必要补正差额。

改变后的 production 候选获得一次新的原 scoped census，完整 committed `f69bd6a3424bbbaf17b23f439076a5066ef2e3bf` 加冻结八个 production 文件，四原规则逐字不变，仅在私有目录生成 13 matching。sourceDigest `sha256:9e433590b0da283221187980b65afce8fd6ef0a6588fee93ac5562c03f23043b`。两个人口各保留一次原尝试：首轮未完成并失败，补正轮成功一次；不是同一候选反复重采。

原 authoring debt 359 条，保留 356 条，只退役 3 条实际消除地址、新增 0 条实际原分类地址，共 356 条。129 有序库存／why／原字段、全部 guard 判据和顺序、40 SPI／69 targets、9 Task effects 与原 SCC 保持。真实计数差额如下：

| 原库存                      |  前值 |  后值 |
| --------------------------- | ----: | ----: |
| rfc294-module-symbol-owners | 27189 | 27190 |

只退役 4 项实际前继已消费许可，登记 1 项真实测量增长；下一普通后继退役。所有并行已提交内容及当前共享 STATE 完整保留，元数据独立门、精确上库和新 exact-SHA hosted CI 另验。

本机仅自有 format／lint、纯 AST／字节／JSON 与上述原静态生成，没有 AW tests／typecheck／build／service。此片不关闭 RFC；继续 Stage A 剩余切面和 A-G，再实现 CS 必须 adapter、M0 首次实际部署及 M1～M4 逐项接入。

元数据首轮 R1 的功能差额核对通过，但共享 STATE 在首末读取间被并行新增 1065 bytes，故正式记录 INVALID，findings 为空；原回执和完整候选保留。并行提交 `0040a6c6a7171b3296dbd1a3d234d5c4918aae6b` 已包含这段输出、自己的 1615-byte 前缀及原 2691913-byte 全文，当前 STATE 共 2694593 bytes，逐字后缀证明保持。本片不再写入或重复提交已经提交的 STATE。

R2 仅重新绑定当前完整 STATE、此发布说明和基线复用证据。`f69bd6a3424bbbaf17b23f439076a5066ef2e3bf` 到上述并行提交只有 STATE、两份 RFC-371 文档和一份测试夹具变化；全部生产树、四原生成规则、两项 sourceDigest 补充输入、canonical guard 与十三份 committed seed 完整相同，夹具不在 guard 地址清单。源码 58 项及十三份 matching 的原结果直接复用，不重审源码、不重复采数或运行本机 AW 检查。当前 publication parent 与原 generation base 分别保留，后者不伪造为新 SHA。

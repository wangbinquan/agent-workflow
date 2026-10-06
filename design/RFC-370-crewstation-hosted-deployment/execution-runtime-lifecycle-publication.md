# RFC-370 执行后台生命周期发布候选

状态：阶段 A 的 H7 有限子单元，设计和源码独立门通过；matching 清单已生成及对拍，待元数据门、精确发布和本批 exact-SHA hosted CI。完整 H7／A-T7／A-G、各 owner 的 CS adapter 和 M0～M4 继续，aw 尚未部署到 CS。

本片交付 system-operations-owned 执行后台控制端口和 exact type-only composition，由原 bootstrap session 提供实际实现。新增 execution pause／resume／state，独立于 provider 切换：后台 stop／drain 可暂停且保留重试进度，资源 HTTP／WS 可以继续服务；provider frozen 时只记录启用意图。两个 resume 复用唯一原启动循环，默认 standalone 顺序保持。

原 provider state／pause／close、两个 CLI 根完整字节、六份原回归和关闭参与者保持。新增 18 个双 provider 案例覆盖控制面读取编辑、frozen、失败回滚、stop／drain ACK、并发、generation 与 close、空 factory。Windows push／PR 各新增 5 个实际触发路径和 2 个 suites；整份原 workflow 完整逆变换成立。实际新用例尚待本批 CI。

独立设计 D1 PASS 共15项、496703 bytes，FP `8f1731bb2300ca7f801ca23b5fe65681eb3544bada520a65ba3b20a86ab08e5f`。独立 SOURCE6-R1 有效稳定 PASS、0 findings，共23项（6 owned／15 control／2 evidence）、646157 bytes，FP `d4e15e29c4bd7bb152a444d9a28d43dc18456cfb583f38943cd9d995290667a2`；回执 92905 bytes、SHA256 `b5c1e255149cc14b6df72aeecc26a62ad7d34da9a043db04bc77c3d4930078e2`。纯 AST／完整 byte inverse 对拍通过，只针对自有源码做 format／lint。

生产候选仅3个文件。一次原 scoped census 使用完整 committed `3645f05a50e25ca248ebba71abd1205b93c1a1b6` 和4个冻结 source/test文件，四原规则和分类器逐字不改，在私有目录生成13个 matching 产物；sourceDigest `sha256:8c4e11676288a371c1ecd1421076d08ab70f8fe3a417863cf9b9a3df8ff80140`。本机未运行 AW tests／typecheck／build／service。

原129项有序库存和每个 why、214项完整 guard、365项后台与504项 ambient rows、40个 required SPI、69个 targets、原 Task 两份 ledger 和全部 SCC 保持。实际计数为 imports 6720→6722、原分类 exception 5919→5921、owner 27190→27195；仅登记对应3项一次性实测增长，退役前继 owner 增长回执。原356条 authored debt 全部保持，追加原分类器实际记录的2个 type-only地址，成为358条；没有将这两个地址冒充已消除或加宽原规则。完整执行权、早期 worker 与真实根收口仍需后续实施。

当前 Windows 诊断提交 `3645f05a50e25ca248ebba71abd1205b93c1a1b6` 的 run `37505158767` 已 completed/success。该提交只打印原 custom observer 拒绝对象，未改变 native 执行；前继 `0fd9973f06967c3628205ea0bcaec5501428b7b6` 的 Windows `37502737291` 失败保留，原始因果仍未知，本次不复现不等于根因已修复，也不代表本片新生命周期已在 hosted 运行。

同诊断提交主 CI `37505158718` 的 Markdown job `112411831984` 记录2个历史 Actions run链接共5处502，涉及RFC370三份文档和RFC371的CI恢复记录。本批只将这5个链接替换为原 display label 的文本引用，两个 run ID、原全部事实及其它全文保持，4份文档的整文件 byte inverse 成立；共享的RFC371文档历史并行产物原样保留，无跨会话消息。两份RFC370长日志本身已有多余空行，相对 formatter 对拍确认本次没有新增格式差额，不借链接修复重排其余正文。原失败记录和格式初检回执保留。

后续先完成执行权／早期恢复与后台接线、三个目的调用者的九项命令、实际执行根选择和独立 A-G，再按已批准顺序编写各层 CS adapter。阶段 B 先必须能力和 M0 真实登录／编辑／保存／重建回读部署，再逐项 M1～M4；有限子单元不关闭 RFC。

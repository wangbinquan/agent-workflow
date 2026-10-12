# RFC-370：原根核对与累计使用量接线的 CI 兼容

2026-10-12，本片只处理已上库接线与既有完整根源码核对的兼容，仍执行用户要求的“GitHub 完整主 CI 和默认完整 Windows 全绿后再推进 RFC”。它没有继续 RFC 适配实施，也没有接管已交接的累计使用量业务。

## 实际失败与修复边界

`134603ad5658c0a45ebbc4a12881cf504e9b75e9` 的默认完整 Windows `38218462310`／作业 `114708713225` 为 failure，原日志完整保存在 `/tmp/aw-rfc370-maintenance-134603ad-hosted/windows-job.log`，560564 bytes，SHA-256 `8a3f3bc96b538bcc2598f56c7fed8295ca4cec2b44a8f6589d30206daf8de13d`。平台步骤实际为 1450 pass／3 skip／15 fail。maintenance 的原 service 18、supervisor 16、真实 Worker 1 均逐例实测通过，35 次只属于 Windows，不代签其它平台、全 CI 或 RFC 完成。

其中 13 个失败在原两个 CLI 根的同一个 test-only inverse 上传播：`composeSqliteProviderSession` 与 `composePostgresqlApplication` 增加了精确的 `{ taskCalculations: true }` 实参，原 helper 仍只识别未带此实参的四个 native-cache hook。已有 W29、MCP、Task、provider、System 的完整根人口与旧全文判据没有被修改；本片不改两根生产文件。

其余两个失败属于已交接的累计使用量模块：source revision 投影拒绝经过 canonical JSON 的合同；trace 回归比较两次独立请求的随机 receipt 标识。已经向该模块所在会话交接这两处实际 CI 阻塞及完整日志。本片不修改这两个业务／测试路径，也不把它们记为通过。

## 有限兼容

helper 只识别两个已有精确版本的完整参数尾：原 home／database writer／结束尾，以及在它们之间加入一个原样的 `{ taskCalculations: true }`。选中的版本仍必须出现一次，原 build／closeBuild 的配对、原逆向字节、原 source filename、原 TypeScript 重解析方式保持。未带新增实参的已批准旧版本继续可用；错误值、额外属性、重复实参及不完整 hook 继续拒绝。所有其它字节保持可见，完整原根的 byte length／SHA-256／父节点／原调用人口仍由原用例核对，禁止重写基线或削弱判据。

原 `rfc371-native-fact-root-inverse.test.ts` 的正文保持，只增加两个 CLI 根的新旧版本兼容及错误实参／未知追加字节回归。没有本机 AW test、typecheck、build、服务或 E2E；仅限定格式／lint、纯语法与源码保持检查，再运行有限独立实现门。三个 owned 为 helper、原测试的追加与本说明。

本片没有生产源码、依赖或生成规则变化，架构 census 的原 src-only 输入不变，不重复生成整套配套。精确提交上库后，仍等待后继确切 SHA 的完整主 CI、默认完整 Windows 与原 maintenance 实测。原失败、未完的全 RFC／CS adapter／部署和所有并行输出均保留真实状态。

## 后继 CI 与本会话的发布遗漏

兼容修复已发布为 `ed12db25fb409fe7819e5b696b5e9dcd018daabb`。其默认 Windows `38224169503` 平台步骤为 1465 pass／3 skip／2 fail，原十三个 inverse 失败不再出现；两个使用量失败仍保留，整条 Windows 仍为 failure。包含相同修复的后继 `86a822bdf8a7840deff739e1d806bf6b8a94de76` 默认 Windows `38227893656`／job `114739810539` 也是 1465 pass／3 skip／2 fail；两个原失败名称和实际行分别位于原日志 2049、2809，末尾摘要的重复列举不算额外失败。这些部分通过不代签总 CI。

`ed12db25` 主 CI `38224169616` 的 Ubuntu 6／job `114727475540` 在 `rfc317-ledger-highwater.test.ts:950` 实际失败：六条 `allowGrowth` 相对上一提交没有数量增长，已经过期。首个无增长后继是本会话发布的 `ed12db25`，遗漏紧邻退役属于本会话的发布缺陷；不是因为本会话负责 push 就接管原 RFC-371 的生产和使用量回归。

本次仅退役 mutation-entrypoints、transaction-callbacks、cross-context-observed-imports、architecture-exceptions、public-surfaces、module-symbol-owners 六条已消费的一次声明。130 行原顺序、全部 baseline／原 why、完整其它 payload、sourceDigest、canonicalProjection、origin／snapshot 来源保持，沿原 `artifactContentDigest` 规则更新内容摘要；不执行新 census、不修改生成规则和原 highwater 用例。原声明和实际消费仍在 `134603ad` 的提交历史中，旧失败也不改记为通过。

这是既存 CI 发布缺陷的元数据修复与状态说明，不新增生产实现或另一轮半成品功能门。共享在制的 SQLite、schema 测试、使用量和脑图产出均保留，不纳入这次精确发布；后续按今日协作规则由责任会话处理各自回归，不再发送跨 session 信息。完整 H7、A-T7／A-G、CS adapters、首次 M0 部署和 M1～M4 尚未完成。

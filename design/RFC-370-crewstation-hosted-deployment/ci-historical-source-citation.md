# CI：历史来源引用的外站超时

HumanGate 修复源码 127ab32d5948383f5bd92c92204df65cd5c99da1 和紧邻许可退役 abca1d5118e20227b9b5a0cfa51c29035dd83934 已上库。该 SHA 的主 CI 38042223483 中，Markdown link check 作业 114184569575 的日志只记录一个外站超时、零错误：历史 RFC-205 文档的 man7 来源 URL 在原 30 秒单次超时、五次重试下仍未完成请求。本机额外的一次只读 HEAD 也在 TLS 握手时超时；它只作排障观察，不作为 hosted CI 通过证据，没有读取网页正文。

本片只将该处 Markdown 外链改为保留名称及原完整 URL 的纯文本引用。全部原文与历史结论作为不透明原字节保持，不重审旧内容，也不改链接检查规则、重试次数、超时预算或任何生产／测试源码。另一个会话已正常发布 ff450237 的三个观测测试／文档路径；这些并行输出保持，32 份 HumanGate 源码／原控制字节与已消费源码门及配套门一致。无新架构 census 或本机 AW tests、typecheck、build、services、E2E。

该 SHA 的默认完整 Windows 38042223475 已正式 success，作业 114184569461 的 26 个步骤全部 success。根会话已核对全部 47 次 HumanGate、53 次原生命周期实际案例及四工作区 typecheck 的 code 0；H05／H08 的原真实循环亦已通过。主 CI 最后已读的非终态快照为 61 success、1 failure、9 未终结／71 已创建作业，外链失败及其后续汇总仍需保留原终态，不以 Windows 通过代签主流水线。

有限引用格式／新正文功能复核、四路径精确上库、新精确 SHA 主 CI＋默认完整 Windows 总绿与 398 次实际案例分别验收。当前总绿门槛未通过，下一批 RFC 生产实现仍暂停。完整 H7／十九 owner／三个启动根、A-T7／A-G、各层 CS 独立 adapter 和 M0～M4 继续开放，AW 尚未部署 CS，RFC 未完成。此前 HumanGate 功能门与所有旧失败回执完整保留，详见[CI 修复记录](ci-human-gate-context-and-frozen-fixture.md)。

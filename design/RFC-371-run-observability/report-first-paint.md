# RFC-371：重新打开时先读已完成报告

当前完整生成仍约20–22秒，而已完成报告header与原分页读取约10–15ms。页面刷新/QueryClient重建会丢失已完成reportId，重新POST完整报告，首屏因此被整个扫描和发布阻塞。上一片只保留同一次挂载中的结果，未覆盖浏览器重载。

## 范围

前端仅持久化最后一次成功、原范围核对的reportId，不保存统计数值、明细或“完整”判断。bookmark key按原服务base URL、当前原token的SHA256、规范化filters和taskId隔离，key/value不复制明文token。存储不可用/校验失败不能影响原统计请求。常规页面首次没有旧报告时仍走原完整生成，不设任何总人口限制。

重建QueryClient且revision=0、没有当前报告ID时，先读同范围bookmark对应的原GET。仅GET成功、reportId与原header一致、filters/task一致，且有原已完成content（含原not-ready但facts存在的报告）时保留其原四桶/CNY/统计时间/缺口。随后仍POST一次新报告，保留原完整扫描、2秒building轮询、ACK/EOF和整体替换规则。读取bookmark不把旧内容写入新报告query结果；继续使用现有previous显示状态和compact提示。刷新中禁用按钮，不能重复POST。手工revision刷新不重新恢复bookmark。

原报告404/已淘汰时丢弃该bookmark，走正常新报告。403、5xx、异常header/scope、取消不能恢复旧数值或被当成成功。原终态失败/无facts、新请求错误以及原明细失效要删除对应reportId的bookmark，保留已有隐藏旧值、停止错误轮询及手工重试语义。删除按确切ID匹配，不能误删同范围后来的不同报告。只接受原服务器响应，不读取本地存储中的统计值作为显示资格。

未指定from/to的入口在原route挂载时以replace把已验证默认时间范围写入URL；不改变范围、筛选、页签、任务、返回、滚动或新增历史记录。已有明确时间范围保持。这样浏览器重载保持相同范围，不每次以Date.now产生新查询；用户选择新周期仍使用原当前时间计算。URL是应用当前实际范围，与原时间显示一致。

## 验证与交付

保留已发布的刷新/错误/缺口/明细失效全部用例和预算，增加真实Hook+新QueryClient重载：原GET完成即显示原四桶/CNY和日期，新报告building时保持并只有一次POST；终态整体换新。覆盖不同token/base/filters/task不恢复、404淘汰正常重建、403/502/取消/错误范围不显示、不重启错误轮询、存储失败回原路径、明细失效删除旧bookmark。route覆盖缺省范围replace与明确URL不替换。有限设计/实现双门；不运行本机AW产品测试/构建/新服务。正式本机dev-admin页面重载核对首屏及原全部API数据，生成耗时与首屏耗时分开，不代签后台性能或两个RFC完成。

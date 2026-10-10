# RFC-370：生命周期切面的 CI 修复

`981ae0f4dd28f6711adac2bec65c96fb231fd77d` 的默认完整 Windows `38014332673` 正式 failure。主 CI `38014332637` 的 typecheck、Ubuntu 分片 6／10／12／15／25 和 macOS 分片 11 已失败，其余作业继续等待终态。保留该提交的失败事实；后继通过不能代签它。

这次仅修测试与对应记录，生产候选和原四个架构生成规则不变，不重新运行 census，也不在本机运行 AW tests／typecheck／build／服务。HumanGate 的有限设计门已通过，生产实现等新的完整 CI 通过后继续。

## 新测试的真实事务和协调器

原事务活动查询只回答调用方的 async 作用域，外部等待者没有事务帧。阻塞 host ACK 的测试在原事务内部记录活动状态和原 Task 行，再让外部等待者断言尚未发布、尚未返回；释放后仍断言已提交的 Task、事件与原 publisher 错误保持成功。没有把外部上下文的 false 当作已提交，也没有修改生产事务原语。

真实 driver 的 claim、释放和最终清理也使用同一个 host binding。reporter 的“一次写入”断言改为量测原 reporter 调用前后的 ACK 差值；原 Task 状态、事件、intent、错误对象和九个真实 reporter 全部继续检查。原 driver 在可 attach 状态会等待另一 driver 释放，所以 not-attached fixture 将已附着 Task 放到真实不可 attach 的 `awaiting_human` 状态，再检查不调用 reporter、engine 或写另一结果。每个原 30 秒预算保持。

两个 tombstone fixture 明确检查原 Task 行存在，然后保留完整 Task 记录的比较。52 个 provider 用例和一个全量原调用者用例、所有既有断言目标与预算保持；实际通过数仍须读取新 SHA 的 hosted 日志。

## 完整原装配根检查

原 Task launch 逆变换仍保留原 JSON、完整 statement 人口和全部 introduced hash。它之前先按原生命周期 fixture 逐个验证三个启动文件中的六个调用：原接收者、`issuedResults` 和全部原参数必须逐字相等，才能移除该次选择并重解析同一文件。再继续原 Task launch／System／MCP 的完整原根检查。改变 purpose、参数或删掉调用都必须拒绝；同一全量原调用者用例覆盖这些反向输入和完整重解析 parent。

两处 Task 插入源码账本只将行号分别 561→562、121→122，与新增 import 对应；原四个站点、血缘和启动来源三列及其检查算法保持。

## 已发布增长记录

`981ae0f` 的 T17 正式拒绝五个未附当次 `allowGrowth` 的分母增长：1988→1989、6902→6905、6044→6047、1259→1260、27775→27782。它们是已批准生命周期切面的新 selector、三个真实启动消费边、七个 owner 和一个观测写入口，由唯一原 census 产生；遗漏发布所需的一次声明仍是该提交的失败。

当前修复没有新增长，不补造会被 stale 检查拒绝的后继许可，不降低分母、不关闭 T17，不重写已推送历史。在账本 `note` 追加这次遗漏与完整五项变化，按原纯函数重算该文档的 provenance；130 行、全部 ID／why／baseline、其他正文和源人口摘要保持。后继 CI 按其实际父提交与完整实际库存检查，单独记账。

## 继续条件

新精确提交的主 CI、默认完整 Windows、四工作区 typecheck 和新增生命周期用例全部通过后，恢复 HumanGate 实现。H7、19 个 owner／三个启动根、A-T7／A-G、独立 CS adapters、M0 首次部署和 M1～M4 仍开放，RFC 未完成，AW 尚未部署 CS。

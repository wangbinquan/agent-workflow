# RFC-370 W2-R：生成状态页的 CI 修正

`fbf85b2710180228f84a7e98b2becf7756ac50ae` 的主 CI `37782710720` 在 macOS 后端第 4 分片的原 `rfc294-review-status-projection.test.ts` 失败。原判据要求状态页与 `renderArchitectureStatus` 逐字相等；本批误对生成页执行 Prettier，改变了表格空格和分隔线。Windows `37782710729` 和 Static scans 已成功，不能据此签主 CI 总绿。

状态页恢复为本批唯一一次原 scoped generation 已保存的完整原输出，八份 canonical JSON、指标、sourceDigest、原 renderer 和所有旧断言保持。原 `package.json` 的 `format:check` 仅覆盖 packages 和具名 repo UI 文件，不覆盖 design 生成页；该页以原生成器字节为准，不改格式规则或相等判据，没有新增 census 或本机 AW tests/typecheck/build/services/E2E。

四条已消费增长声明的退役已取得独立有限 PASS；此次状态页修正另取独立有限功能门，二者按各自原候选绑定后精确发布。原退役候选关于其余架构文件保持的记录属于该候选的实际边界；发布包含此次状态页格式修正，业务 payload 仍全部保持。其余并行输出完整保留，共享 Windows 等其引用的两个会话新测试都上库后再提交。

新提交的主 CI 与 Windows 仍需确切 SHA 终态验收。Task 具名投影正在实施，实际根、其余写入目的、十九 owner、H7/A-T7/A-G 及 CS adapters、M0～M4 继续；AW 尚未部署到 CS，RFC 未完成。

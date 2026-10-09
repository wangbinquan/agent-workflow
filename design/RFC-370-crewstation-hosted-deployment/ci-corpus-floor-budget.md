# CI 全模块语料下限检查预算

`ab5c6ab7a834f86b2ec4ee282de21074a0a91c06` 的主流水线最终结果还包含 macOS shard 5 的一项失败：`rfc294-architecture-preflight.test.ts` 的 RFC-317 T13 语料下限用例完成了 5469.66ms 的全模块 AST 构建，超过其未显式声明的 5000ms 默认超时。该作业实际 1821 pass、1 fail，失败摘要仅列这一超时；不能把此前修复的类型和账本差额当成总流水线已绿。

本批只为该用例声明 30000ms 的扫描预算，并写明真实 hosted 失败依据。`productionModuleUnits()` 的枚举、逐文件读取和 `sourceUnit()` 构建保持；`expect(productionModuleUnits().length).toBeGreaterThanOrEqual(120)` 完整原样，120 下限、全部其它断言、扫描规则、库存和生产实现保持。该断言验证实际语料覆盖，不承担执行性能阈值；既有全语料账本检查也使用 30000ms 预算。不存在跳过扫描、复用伪造结果或删除超时失败历史。

本次不运行本机 AW 测试、typecheck、build、服务、E2E 或新 census；只做目标格式、lint、差额与完整旧文件逆向验证。新提交的主流水线和完整 Windows 仍需 GitHub 实际终态成功；当前运行的 `58846013` 检查继续完成，不主动取消或重启。RFC-370 的 Lifecycle 生产实现继续等待总绿，完整 H7、19 个 owner、三个真实 root、A-T7/A-G、CS adapters、M0–M4 部署和完整 RFC 仍未完成。

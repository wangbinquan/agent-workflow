// RFC-359 —— 后端生产代码的「丢 Promise」门（类型感知，独立于主 eslint 配置）。
//
// 为什么单独一份配置、而不是并进 eslint.config.js：类型感知需要 `project`，而仓里有测试
// （RFC-282 的边界探针）用 `eslint.lintText` 去 lint **磁盘上不存在**的 `packages/backend/src/**`
// 合成路径。那些路径不在 tsconfig 里，一旦主配置带上 project，它们会解析失败并把该文件其它
// 规则的报告一起吞掉（实测：no-restricted-imports 的命中数从 1 变 0，RFC-282 五条直接红）。
// 拆成独立入口后，这道门只对真实文件生效，`bun run lint` 的行为一个字节都不变。
//
// 为什么值得有这道门：本仓正在把 bun:sqlite 的**同步**事务面整体迁到中立异步原语，这类迁移
// 最危险的失败模式是**漏 await 静默通过类型检查**——端口一旦写成 `void | Promise<void>`，
// 丢掉返回的 Promise 就是合法写法，tsc 不报、测试多半也不红，症状只是「写好像没生效」。
// 2026-09-07 第一次开这道门：机械迁完 30 个文件后 tsc 全绿，而这两条规则当场报出 **62 处**丢弃；
// 指向 main 上的存量代码则照出 **15 处**真丢弃（effect 台账 succeed/fail、fan-out 的
// recordConsumed、资源包 apply 在铸回执前没等写入落库），逐条修掉后归零。
//
// 成本：全 backend/src 约 30s。
import tseslint from 'typescript-eslint'

export default [
  {
    files: ['packages/backend/src/**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    // 这份配置只开两条规则，判断不了针对**别的**规则的 eslint-disable 是否多余
    // （主配置才有那些规则）——所以关掉「未使用的 disable 指令」报告，避免误报。
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ['./packages/backend/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
]

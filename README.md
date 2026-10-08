# ts-grm-patches

> 状态：工程骨架已初始化，公开 API 待实现。

## 安装

```bash
pnpm add ts-grm-patches
```

## 使用

```ts
import { PACKAGE_NAME } from 'ts-grm-patches'
```

## 开发

```bash
pnpm install        # 安装依赖
pnpm dev            # 监听模式构建
pnpm typecheck      # 类型检查 (tsc --noEmit)
pnpm lint           # ESLint
pnpm format         # Prettier 格式化
pnpm test           # 运行测试 (vitest run)
pnpm coverage       # 测试覆盖率
pnpm build          # 构建到 dist/ (ESM + CJS + d.ts)
```

## 发布

```bash
pnpm version patch   # 或 minor / major
pnpm publish         # prepublishOnly 会自动 clean + build + test
```

包以双格式发布：ESM (`dist/index.js`) 与 CJS (`dist/index.cjs`)，类型声明通过
`exports` 字段分别提供 `dist/index.d.ts` / `dist/index.d.cts`。

## 许可

MIT

# ts-grm-patches

为 `ts-grm` 补齐**列的 `autoIncrement` 与 `default` 支持**，填平 `ts-grm` 与
`ts-grm-migrate` 之间的需求鸿沟。

## 背景

`ts-grm` 的列元数据（`ColumnDef`，见 `packages/sql/src/impl/schema_def.ts`）只表达
`name` / `type` / `nullable` / `length` / `precision` / `scale` / `when`，**不表达自增与列默认值**。
由此导致两块能力缺失：

- `ts-grm` 生成 `create table` 时无法输出自增列（`serial` / `identity` / `auto_increment`）与列默认值。
- `ts-grm-migrate` 的模型适配器只能把它们写死为 `default: undefined` / `autoIncrement: false`
  （见 `ts-grm-migrate` 的 `src/schema/adapter.ts`），因此迁移无法产出对应的数据库功能。

本包作为 `ts-grm` 的**扩展补丁**，补齐这部分缺口。

## 状态

工程骨架已就绪，功能实现进行中。公开 API 尚未定型。

## 依赖关系

`@ts-grm/core` 与 `@ts-grm/sql` 是本包的 **peerDependencies**（`>=0.0.13 <0.0.14`），
随宿主项目一同提供，本包不打包上游实现。

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

构建产物为双格式：ESM (`dist/index.js`) 与 CJS (`dist/index.cjs`)，类型声明通过
`exports` 字段分别提供 `dist/index.d.ts` / `dist/index.d.cts`。

发布与发布前验证由维护者在本地执行，本仓库不提供 CI 与 `prepublishOnly` 钩子。

## 许可

本项目原创代码使用 [MIT](LICENSE)。上游 `ts-grm` 使用 Apache-2.0，归属与许可全文见
[third-party notices](THIRD_PARTY_NOTICES.md) 与 [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)。

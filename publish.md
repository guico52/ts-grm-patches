# 发布到 npm

只记录 npm 侧的命令。版本号、构建、提交与打 tag 都假定已经完成。
用 `npm` 而不是 `pnpm publish`，因为后者会检查 git 工作区与分支。

所有命令都显式指定官方源，避免本机镜像配置把包发错地方。

## 1. 确认身份

```bash
npm whoami --registry https://registry.npmjs.org/
# 未登录时：
npm login --registry https://registry.npmjs.org/
```

## 2. 发布前核对

```bash
# 线上已有的版本，确认本次版本号没有被占用
npm view ts-grm-patches versions --registry https://registry.npmjs.org/

# 预演：列出将要上传的文件与版本号，不真正发布
npm publish --dry-run --registry https://registry.npmjs.org/
```

核对 `--dry-run` 输出：

- 版本号与 `CHANGELOG.md` 一致；
- 包含 `dist/`、`docs/`、`LICENSES/`、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`、`README.md`、`LICENSE`；
- 不包含 `src/`、`test/`、`node_modules/`。

## 3. 发布

```bash
npm publish --registry https://registry.npmjs.org/

# 账号开启了 2FA 时附上一次性验证码：
npm publish --otp <6位验证码> --registry https://registry.npmjs.org/
```

预发布版本（如 `0.3.0-beta.0`）不要占用 `latest`：

```bash
npm publish --tag next --registry https://registry.npmjs.org/
```

## 4. 发布后验证

```bash
npm view ts-grm-patches version dist-tags --registry https://registry.npmjs.org/
```

## 补救

```bash
# 把 latest 指回某个版本（例如预发布误占了 latest）
npm dist-tag add ts-grm-patches@<版本号> latest --registry https://registry.npmjs.org/

# 标记某个版本有问题（不删除，安装时给出警告）
npm deprecate ts-grm-patches@<版本号> "<原因>" --registry https://registry.npmjs.org/

# 撤回 72 小时内发布的版本；撤回后该版本号永久不可复用，优先用 deprecate
npm unpublish ts-grm-patches@<版本号> --registry https://registry.npmjs.org/
```

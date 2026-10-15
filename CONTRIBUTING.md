# 参与贡献

感谢你愿意改进走得到。

## 开发环境

需要 Node.js ≥ 22.12 和 pnpm 10。

```bash
pnpm install
pnpm dev          # 同时启动服务端与 Web
pnpm test         # 全部单元测试
pnpm lint         # ESLint
pnpm typecheck    # 类型检查
pnpm format       # Prettier 格式化
```

## 约定

- **语言：** 全部使用 TypeScript，开启 `strict` 与 `noUncheckedIndexedAccess`。包内相对导入带 `.js` 扩展名。
- **算法：** 放在 `packages/core`，保持纯函数，不做任何 I/O，并为每个模块写单元测试。
- **百度接口：** 调用一律经过 `packages/baidu`。测试使用 `research/` 中录制的真实响应，**不得在测试里调用线上接口**：个人认证的地点检索每天只有 100 次。
- **数据来源：** 每个对外展示的数字都要能追溯来源，区分实测、路径采样、估算和样例。新增字段也要遵守这一点。
- **密钥：** 不要提交真实 Key。`.env*` 已被忽略，CI 会用 gitleaks 扫描。
- **界面：** 视觉系统以 `DESIGN.md` 为准。状态不能只靠颜色表达，红色只用于"伪覆盖"。

## 提交流程

1. 先开 Issue 说明问题或提案；小修复可以直接提 PR。
2. 从 `main` 拉分支，保持 PR 聚焦在一件事上。
3. 确认本地 `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全部通过。
4. PR 描述写清楚动机、改动内容和验证方式；涉及界面的改动请附截图。

## 行为准则

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。

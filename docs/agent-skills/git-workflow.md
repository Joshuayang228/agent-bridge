# Git Workflow

## 代码托管

- 平台：GitHub。
- 开源协议：MIT。
- 主分支：`main`。

## 网络代理

本项目环境可能通过代理访问 GitHub。若 `git push` 报 `Failed to connect to 127.0.0.1 port XXXX`，说明代理端口不对或代理未启动：

- 检查当前代理端口（Clash 常见 `7890` / `7897`）。
- 更新代理：`git config --global http.proxy http://127.0.0.1:<端口>`。
- 或清除代理直连：`git config --global --unset http.proxy`。
- 确认端口后再重试，避免盲试。

## 推送前检查

按变更风险选择执行：

1. `npx tsc --noEmit`，类型检查（若为 TS 项目）。
2. 项目构建命令，构建验证。
3. 单元测试 / E2E 测试。
4. 确认 `.env` 等敏感文件不在 staged 中。

Windows PowerShell 不支持 bash heredoc，commit message 使用简短单行 `-m` 格式即可。

### 提交推送门控

完成功能编码且测试通过后，收尾阶段必须按以下规定执行：

- **测试与验证必做**：commit 前必须运行并通过单元测试与类型检查，确保提交的不是破损代码。
- **必须 commit**：验证通过后立即 commit，严禁在本地积压多个功能模块的不稳定代码。
- **必须 push**：commit 完成后随之 push 到远程，确保云端备份和多端一致。
- **网络代理排查**：遇到 `Failed to connect to 127.0.0.1` 类报错，按上文「网络代理」排查直至推送成功。

目的：降低本地代码丢失或回滚难度，同时减少多设备同步冲突。

## Commit 规范

格式：`type: description`

| type | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `refactor` | 重构，不改功能 |
| `docs` | 文档变更 |
| `test` | 测试相关 |
| `chore` | 构建、工具、依赖变更 |
| `style` | 代码格式，不改逻辑 |
| `perf` | 性能优化 |

规则：

- description 用英文，简洁说明做了什么。
- 一个 commit 只做一件事。
- 不要在 commit 里混杂无关改动。

## 分支命名

```text
feat/功能名
fix/问题简述
refactor/模块名
docs/文档主题
```

## PR 流程

1. 从 `main` 创建功能分支。
2. 完成开发、自审、测试。
3. 创建 PR，描述改了什么、为什么改。
4. Review 通过后合并到 `main`。

## 版本记录格式

`changelog.md`：

```md
## [版本号] - 日期

### Added
- 新增功能描述

### Fixed
- 修复问题描述

### Changed
- 变更描述
```

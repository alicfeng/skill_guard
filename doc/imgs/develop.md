# Skill Guard — 开发说明

面向从源码运行、调试与打包的开发者。最终用户说明见根目录 [README.md](./README.md)。

## 环境要求

- [Node.js](https://nodejs.org/) 18 及以上
- 本机已安装 [Git](https://git-scm.com/)（Marketplace 与部分扫描逻辑依赖）
- 各平台打包的额外条件（证书、依赖库等）见 [electron-builder 文档](https://www.electron.build/)

## 安装依赖

```bash
npm install
```

## 本地开发

同时启动 Vite 开发服务器与 Electron（见 `package.json` 中 `dev` 脚本）：

```bash
npm run dev
```

## 构建

```bash
# 前端构建 + 当前平台安装包（与 package.json 中 build 脚本一致）
npm run build

# 仅构建渲染进程产物到 dist/
npm run build:renderer
```

安装包默认输出目录为 **`release/`**（由 `package.json` → `build.directories.output` 配置）。

### Makefile（可选）

若使用仓库根目录 [Makefile](./Makefile)，可选用：

| 目标 | 说明 |
|------|------|
| `make install` | 安装依赖（可用 `NPM=pnpm` 等覆盖包管理器） |
| `make ci` | 干净安装（`npm` 时用 `npm ci`） |
| `make clean` | 删除 `dist/`、`release/` |
| `make build-renderer` | 仅 `npm run build:renderer` |
| `make build` | 当前平台完整包 |
| `make build-mac` | macOS（dmg） |
| `make build-linux` | Linux（AppImage） |
| `make build-win` | Windows（NSIS） |
| `make build-all` | 一次打 mac + linux + win（需本机具备对应交叉构建条件） |

## 项目结构（摘要）

| 路径 | 说明 |
|------|------|
| `electron/` | 主进程、文件扫描、IPC、`.skill_guard` 与 Marketplace 逻辑 |
| `src/renderer/` | React + Vite 界面 |
| `build/` | 应用图标等资源 |
| `docs/` | 设计备忘与方案说明 |

## 许可证

MIT（与 `package.json` 中 `license` 字段一致）。对外分发时建议在仓库根目录放置 `LICENSE` 文本以便识别协议。

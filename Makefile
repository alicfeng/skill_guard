# 包管理器：可覆盖，例如 `make install NPM=pnpm` 或 `NPM=yarn`
NPM ?= npm

# electron-builder 可执行文件（安装依赖后存在，不依赖 npx 行为差异）
ELECTRON_BUILDER := ./node_modules/.bin/electron-builder

.PHONY: help install deps ci clean build-renderer \
	build build-mac build-linux build-win build-all

help:
	@echo "Skill Guard — 常用目标"
	@echo ""
	@echo "  make install       安装依赖（同 deps）"
	@echo "  make ci            干净安装（npm ci；其它包管理器回退为 install）"
	@echo "  make build-renderer 仅构建前端 dist"
	@echo "  make build         当前平台完整包（vite + electron-builder）"
	@echo "  make build-mac     macOS（dmg）"
	@echo "  make build-linux   Linux（AppImage）"
	@echo "  make build-win     Windows（nsis）"
	@echo "  make build-all     一次打 mac + linux + win（需本机具备交叉构建条件）"
	@echo ""
	@echo "覆盖包管理器: make install NPM=pnpm"

install deps:
	$(NPM) install

ci:
	@if [ "$(NPM)" = "npm" ]; then $(NPM) ci; else $(NPM) install; fi

clean:
	rm -rf dist release

build-renderer:
	$(NPM) run build:renderer

# 与 package.json 中 \"build\" 一致：当前平台
build: build-renderer
	$(ELECTRON_BUILDER)

build-mac: build-renderer
	$(ELECTRON_BUILDER) --mac

build-linux: build-renderer
	$(ELECTRON_BUILDER) --linux

build-win: build-renderer
	$(ELECTRON_BUILDER) --win

build-all: build-renderer
	$(ELECTRON_BUILDER) --mac --linux --win

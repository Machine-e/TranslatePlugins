# Stream Translate Page（网页翻译插件）

一个 Chrome Manifest V3 插件：把英文为主的网页内容翻译成简体中文，并将译文插入到原文下方（保留原文，双语对照）。

本项目不包含任何真实 `Base URL` / `API Key`，请在浏览器本地自行配置。

## 功能特性

- 在 popup 里手动触发“整页翻译”
- 支持 OpenAI-compatible provider（使用 `POST /responses`）
- 分批处理，前面的内容先显示，后面的继续翻译
- 译文插入到原文下方（支持表格单元格、左侧导航栏等常见文档站结构）
- 代码块：仅翻译注释（不翻译代码本身）
- 失败段落支持“重试该段”
- 可隐藏/显示译文、清除当前页译文
- 支持多套 system prompt，且同一时间只启用一套
- popup 内可实时切换译文字体颜色

## 安装（本地加载）

1. 打开 `chrome://extensions`
2. 开启右上角 `Developer mode`
3. 点击 `Load unpacked`
4. 选择包含 `manifest.json` 的目录

## Release 打包与一键导入

生成干净的发布 zip：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-release.ps1
```

会产出：

- `releases/stream-translate-page-v<version>.zip`
- `releases/stream-translate-page-latest.zip`

Windows 下一键导入辅助：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\import-release.ps1
```

或直接双击：

- `releases/Import-Into-Chrome.cmd`

这个辅助脚本会自动解压最新 release、打开 `chrome://extensions`、打开解压目录，并把目录路径复制到剪贴板。由于 Chrome 安全限制，最后仍需要你手动点一次 `Load unpacked` 完成导入。

## Provider 配置

打开扩展的 `Options` 页面，填写：

- `Base URL`：例如 OpenAI 官方 `https://api.openai.com/v1`，或你的 OpenAI-compatible endpoint
- `API Key`
- `Model`：例如 `gpt-4.1-mini` / `gpt-4o-mini` 等
- 可选 system prompt（支持多套管理与启用）
- 超时与 batch size

插件会请求：

`{Base URL}/responses`

## 使用方式

1. 打开英文网页（例如文档站、博客、文章页）
2. 点击扩展图标
3. 点击 `开始翻译`
4. 需要时可用 `隐藏译文` / `停止` / `清除当前页`
5. 某段失败时，在该段下方点击 `重试该段`

## 安全说明

- 不要把真实 `API Key` 提交到 Git 仓库或分享给他人。
- `API Key` 保存在本机浏览器的 `chrome.storage.local` 中，翻译时会把页面内容发送到你配置的 provider。
- 若页面含敏感内容，请谨慎使用，或配置你的私有 provider/代理。
- `scripts/build-release.ps1` 会在打包前扫描发布文件，发现疑似硬编码密钥时会直接中止，避免把敏感字段打进 release。

## 常见问题

- `Failed to fetch`：
  - 请确认 provider 支持 `POST /responses` 且允许浏览器端请求（CORS/网络策略）。
  - 部分 provider 不支持流式：插件会自动降级为非流式请求，但仍按批次逐段插入。

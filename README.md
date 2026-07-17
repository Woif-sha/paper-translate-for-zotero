# Paper Translate for Zotero

[![CI](https://github.com/Woif-sha/paper-translate-for-zotero/actions/workflows/ci.yml/badge.svg)](https://github.com/Woif-sha/paper-translate-for-zotero/actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

我写这个插件，是因为普通划词翻译常常不知道论文在讨论什么。同一个术语换一篇论文，译法可能就不一样；只把选中的一句话发给模型，结果很容易跑偏。

Paper Translate for Zotero 会读取 `llm-for-zotero` 已生成的 MinerU Markdown，从当前论文中找出相关段落，再结合这篇论文自己的术语表和背景资料完成翻译。它有独立的提示词和论文上下文，不会占用或修改 `llm-for-zotero` 的聊天记录。

## 目前能做什么

- 在 Zotero Reader 中选中文本后自动翻译；
- 修改选区内容或粘贴新文本，再手动翻译；
- 使用与 `llm-for-zotero` 相同的 Codex 旧版认证接口；
- 初次使用时按摘要/引言、方法、实验和结论均衡读取 Markdown，生成中文背景和双语术语表；
- 为每篇论文保存术语表、背景摘要、可选外部来源和文件级准备进度；
- Markdown 更新后重建索引，不沿用旧论文上下文。

界面只显示原文和译文。插件不会把翻译写进批注、笔记或条目字段，也没有词典、语音和传统机器翻译服务。

## 安装前要准备什么

这个插件依赖两样东西：

1. Zotero 7，以及已经安装并配置好的 `llm-for-zotero`；
2. 官方 Codex CLI。安装后先在终端运行 `codex login`。

请先用 `llm-for-zotero` 解析论文。对应附件的 MinerU 缓存中必须有 `_llm_source.json`、`manifest.json` 和 `full.md`。本插件不会读取 PDF，也不会替你调用 MinerU。

从 [Releases](https://github.com/Woif-sha/paper-translate-for-zotero/releases) 下载 XPI，然后在 Zotero 的“工具 → 插件”中选择“从文件安装插件”。安装后可以在插件设置中填写目标语言和模型，并用“测试连接”检查当前 Codex 登录是否可用。

插件读取 `~/.codex/auth.json`（设置了 `CODEX_HOME` 时读取该目录下的 `auth.json`），直接请求 `https://chatgpt.com/backend-api/codex/responses`。access token 缺失或服务端明确返回 401 时，会按 `llm-for-zotero` 的规则刷新登录令牌。插件不会启动 Codex App Server，也不会改用其他 API、模型或服务商。

## 使用方式

在 Reader 中选中文本，翻译浮层会直接出现。上方文本框可以编辑，点击“翻译”即可重新提交；下方文本框显示流式译文。继续选择其他文本时，上一条请求会被取消。

每篇论文第一次翻译前，插件先从已经验证的 `full.md` 建立真实章节索引，整理论文所属领域、方法流程、实验语境、翻译风险和初始术语。核心文件写完后即可翻译；随后 Codex 会根据论文分析得到的具体问题进行可选网页检索，不依赖 Crossref、Semantic Scholar 或其他固定网站。外部搜索失败会记录为警告，不会阻断基于论文 Markdown 的翻译。

外部资料分三级使用：论文正文以及官方/标准资料决定论文事实和规范术语，学术来源用于专业背景，社区页面只用于解释通用概念。背景只参与消歧，不会被拼进译文。后续请求只发送当前文本、相关 Markdown 段落、论文元数据、背景摘要和术语表，不会反复提交整篇论文。

## 文件放在哪里

论文上下文保存在 Zotero 数据目录下。假设数据目录是 `E:\ZoteroData`，文件结构如下：

```text
E:\ZoteroData\paper-translate-for-zotero\<parentItemKey>\
├─ _paper_source.json
├─ _preparation.json
├─ terminology.md
├─ background.md
├─ background-sources.json
└─ index.json
```

一个父条目对应一个文件夹。`_preparation.json` 以论文 key 和 Markdown 哈希绑定来源、索引、论文背景、双语术语、外部补充五个阶段，状态固定为 `pending / running / complete / warning / error / skipped`。侧栏每次从这个文件读取实际进度；来源、索引、论文背景和术语完成后即可翻译。

`index.json` 只记录真实章节、UTF-16 字符偏移、相邻分块和哈希，不复制 `full.md`。MinerU manifest 没有章节时，插件会从 Markdown 的 `#`–`####` 标题重建索引。条目放进 Zotero 回收站时文件会保留；只有条目被永久删除后，插件才会校验路径和来源记录并清理目录。

`terminology.md` 和 `background.md` 都是普通文本，可以直接查看或修改。

## 出错时会怎样

来源文件缺失、附件映射不一致、Markdown 损坏、核心知识生成失败或流式响应格式错误都会直接显示出来。外部网页受限会写入 `background-sources.json` 并在侧栏显示精简警告，不展示完整网址和长错误。插件不会偷偷改用另一个模型、接口或翻译服务。

如果错误指向 MinerU 缓存，请回到 `llm-for-zotero` 修复或重新解析对应附件。

## 开发

```powershell
npm ci
npm test
npx tsc --noEmit
npx eslint src test
npm run build
```

构建后的 XPI 位于 `build/paper-translate-for-zotero.xpi`。推送和拉取请求会运行同样的检查；推送 `v*` 标签后，GitHub Actions 会创建 Release 并上传 XPI。

## 来源与许可

Reader 交互和部分 Zotero 插件结构来自 [Translate for Zotero](https://github.com/windingwind/zotero-pdf-translate)。MinerU 缓存约定和 Codex 旧版认证实现参考了 [llm-for-zotero](https://github.com/yilewang/llm-for-zotero)。具体提交见 [NOTICE](NOTICE)。

本项目使用 [AGPL-3.0-or-later](LICENSE) 许可。

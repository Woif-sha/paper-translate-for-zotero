# Paper Translate for Zotero

[![CI](https://github.com/Woif-sha/paper-translate-for-zotero/actions/workflows/ci.yml/badge.svg)](https://github.com/Woif-sha/paper-translate-for-zotero/actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

普通划词翻译只看到选中的一句话，不知道 `cell` 在当前论文里是“单元”还是“细胞”，也不知道作者前面如何定义一个缩写。这个插件用当前论文的 MinerU Markdown 补上这些上下文，再把选区交给 Codex 翻译。

它不会加入 `llm-for-zotero` 的对话，也不会共用提示词、线程或运行状态。两者之间只有一个文件层面的关系：`llm-for-zotero` 负责生成 MinerU Markdown，本插件读取并验证这份 Markdown。

1.0.0 的具体改动见 [CHANGELOG.md](CHANGELOG.md)。

## 它会做什么

- 在 Zotero Reader 中划词后自动翻译，也可以修改原文或粘贴新文本再翻译。
- 根据选中文本查找同一篇论文的相关章节和相邻段落，不反复发送整篇论文。
- 为每篇论文保存中文背景、双语术语表、来源记录和章节索引。
- 论文打开后立即允许翻译。背景分析、术语整理和网页检索留在后台进行，后续翻译会读到已经写入的新内容。
- 过滤跨页选区中的 IEEE 版权、授权和下载提示，合并正文的视觉断行。
- 保留段落、项目符号和列表顺序。原文框与译文框使用固定尺寸，不会随着流式输出反复缩放。

插件默认只显示译文，不会改写 Zotero 条目、批注或笔记。它不读取 PDF，不调用 MinerU，也没有 PDF 解析回退路径。

## 安装前准备

需要以下环境：

1. Zotero 7；
2. 已安装并配置好的 `llm-for-zotero`；
3. 官方 Codex CLI，并已在终端执行 `codex login`。

先在 `llm-for-zotero` 中解析论文。对应附件的 MinerU 缓存必须包含：

```text
_llm_source.json
manifest.json
full.md
```

缺少其中任何一个文件，或者附件 key、父条目 key、字符长度对不上，本插件都会停止读取并显示错误。它不会猜测另一个缓存目录，也不会转去读取 PDF。

## 安装

1. 从 [GitHub Releases](https://github.com/Woif-sha/paper-translate-for-zotero/releases) 下载 XPI。
2. 打开 Zotero 的“工具 → 插件”。
3. 点击右上角齿轮，选择“从文件安装插件”，然后选中 XPI。
4. 重启 Zotero。

插件设置页默认使用：

```text
认证模式：Codex Auth
API URL：https://chatgpt.com/backend-api/codex/responses
模型：gpt-5.4
推理强度：medium
```

认证模式和 API 地址不可编辑。插件读取 Codex CLI 的登录凭据；默认位置是 `~/.codex/auth.json`，设置 `CODEX_HOME` 后则读取该目录下的 `auth.json`。可以在设置页点击“测试连接”检查登录和模型是否可用。

## 使用

打开一篇已经生成 MinerU Markdown 的论文。Reader 侧栏会显示论文标题、`MD` 标记和五个文件阶段：

```text
正文身份
章节索引
论文背景
双语术语
外部补充
```

正文身份和章节索引写完后就能翻译，通常只需要本地文件处理时间。其余阶段继续在后台运行。即使网页检索受限，当前翻译仍会使用论文 Markdown；侧栏只显示简短警告，完整记录写在来源文件里。

在 Reader 中选中文本后，浮层会自动出现：

- 上方是经过清理的原文，可以直接编辑；
- 点击“翻译”可重新提交；
- 下方按流式方式显示译文；
- 选择另一段文字时，当前翻译会取消并切换到新选区。

有项目符号或明确分段的选区会按原结构翻译。跨页选择时，插件会删除已识别的页脚噪声。例如夹在 `The key` 和 `is to remove...` 之间的 IEEE 版权与下载文字不会进入翻译请求。

## 论文上下文文件

每个 Zotero 父条目对应一个目录。Zotero 数据目录为 `E:\ZoteroData` 时，结构如下：

```text
E:\ZoteroData\paper-translate-for-zotero\<parentItemKey>\
├─ _paper_source.json
├─ _preparation.json
├─ index.json
├─ background.md
├─ terminology.md
└─ background-sources.json
```

- `_paper_source.json` 记录 Zotero 条目、附件、MinerU 目录和 `full.md` 哈希。
- `_preparation.json` 记录各文件的 `pending / running / complete / warning / error / skipped` 状态。
- `index.json` 保存章节、UTF-16 偏移和相邻分块，不复制论文正文。
- `background.md` 区分论文依据和外部背景，只用于理解与消歧。
- `terminology.md` 保存原文写法、规范英文、统一中文译法、正文证据和置信度，可以人工修改。
- `background-sources.json` 保存检索问题、网址、来源等级和错误记录。

`full.md` 更新后，插件会重建索引，并重新核对背景和术语证据。人工修改过的术语译法会在原词仍存在于新版 Markdown 时保留。

条目进入 Zotero 回收站时，上述目录不会删除。只有父条目被永久删除后，插件才会检查目录边界和 `_paper_source.json` 的身份，再清理对应文件夹。

## 背景资料如何使用

论文正文是论文事实的依据。官方和标准资料用于确认规范术语，学术来源用于补充专业背景；社区页面只能解释通用概念，不能覆盖前两类来源。

网页搜索不是翻译前置条件，也不绑定 Crossref 或 Semantic Scholar。搜索失败会记为 `warning`。背景内容只帮助模型消歧，不会被添加到译文里。

## 常见问题

### 提示 MinerU 文件缺失或映射不一致

回到 `llm-for-zotero`，确认当前附件已经解析完成。不要手工把另一个附件的 `full.md` 复制过来，插件会核对附件 key 和父条目 key。

### Codex 连接失败

先在终端运行 `codex login`，然后回到插件设置页点击“测试连接”。本插件不会改用 App Server、其他接口或其他模型来掩盖连接错误。

### 背景准备很慢

这不会锁住翻译。正文身份和索引完成后即可使用；背景与术语会继续写入本地文件，之后的请求自然会获得更多上下文。

### 跨页选区仍有页眉或页脚

当前版本处理了 IEEE 授权、下载、版权字符串和独立页码。不同出版商的页脚格式并不相同，可以提交包含原始选区文本的 issue，但不要附带 Codex 凭据或未公开论文全文。

## 开发

```powershell
npm ci
npm test
npx tsc --noEmit
npx eslint src test
npm run build
```

本地 XPI 生成在 `build/paper-translate-for-zotero.xpi`。推送和拉取请求会运行 CI；推送与 `package.json` 版本一致的 `v*` 标签后，发布工作流会重新检查并上传 XPI。

## 来源与许可

Reader 交互和部分 Zotero 插件结构来自 [Translate for Zotero](https://github.com/windingwind/zotero-pdf-translate)。MinerU 缓存约定和 Codex 认证实现参考了 [llm-for-zotero](https://github.com/yilewang/llm-for-zotero)。复用范围和提交哈希见 [NOTICE](NOTICE)。

本项目使用 [AGPL-3.0-or-later](LICENSE) 许可。

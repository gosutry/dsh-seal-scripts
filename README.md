# dsh-seal-scripts

**简体中文** | [English](./README.en.md)

> 把跑通的脚本封存成工具，把被压缩的对话留成回顾。

[![version](https://img.shields.io/npm/v/dsh-seal-scripts?color=4a7cff)](https://www.npmjs.com/package/dsh-seal-scripts)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2%20%3C1.0.0-6f42c1)](https://github.com/deepseek-ai/dsh)
[![deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](./package.json)

**脚本固存是本插件的重心。** 一次跑通的命令链，当场固化成可执行工具脚本：落成目录、写进清单、注入系统提示词，下一句话就能重跑——不重新推导命令，不改写脚本，不依赖你复述。

**回顾是底座。** DSH 压缩上下文时，被压掉的原文当场落盘成回顾文件；按自然日衰减后注入上下文，需要细节时模型能按线索把原文读回来。它同时是「跨会话固存脚本」的原料来源。

## 目录

- [特性](#sec-features)
- [安装](#sec-install)
- [快速开始](#sec-quickstart)
- [脚本固存](#sec-tools)
- [回顾](#sec-reviews)
- [配置项](#sec-config)
- [设置页](#sec-settings)
- [数据位置与备份](#sec-data)
- [兼容与降级](#sec-compat)
- [已知限制](#sec-limits)
- [开发](#sec-dev)
<a name="sec-features"></a>


## 特性

**脚本固存**

- **一条跑通的链 → 一个工具脚本**：脚本全文、入口、参数、步骤、出处、每文件 sha256 一次写全。
- **进系统提示词**：工具组清单每轮出现在提示词末尾（最多 24 条），模型自己知道有哪些能直接跑。
- **按原状执行**：参数走 argv 数组、不经过 shell；解释器按 run 字段选（bash / node / powershell / cmd）。
- **可核对**：跑前比对清单里的 sha256，脚本被手改过就拒绝，除非显式放行。
- **可搬运**：整组打成 zip（store，不压缩），导入先预览再落地，索引按落地文件重建。

**上下文回顾**

- **压缩即留档**：压缩事件一到就落盘，纯代码、零模型调用，工具调用与参数原样保留。
- **四级衰减**：当天原文 → 次日摘要 → 日记 → 关键词索引；被读中时加一级并锁定。
- **按工作区扩面搜索**：本工作区 → 子级 → 平级 → 上级，外圈要许可才读。
- **补写提醒**：日记或关键词空着时催模型一次写完，写完提醒自动消失。

**工程面**

- 零运行时依赖，只用 Node 内置模块；中文 / 英文双语。
- 宿主能力缺哪块关哪块，不抛错、不整页崩溃。
- 数据是纯文本：`session-memory/` 拷走即备份。
<a name="sec-install"></a>


## 安装

在 DSH 插件管理器里添加本包（包名、本地绝对路径、tarball、Git 地址都可以）：

~~~bash
# --profile 必填（缺省会报 required option not specified），例如 web
dsh plugin --profile web add dsh-seal-scripts

# 本地目录：pnpm 会在该 profile 里登记成 link 依赖
dsh plugin --profile web add /path/to/dsh-seal-scripts
~~~

也可以在设置 → 插件 → 添加里填包名、本地绝对路径、tarball 或 Git 地址；装完要重开 profile 才会加载。

要求：

- 宿主 `@deepseek-ai/dsh` `>=0.2.1-rc.2`、`<1.0.0`（peerDependency，不强制安装）
- Node `>=18`（没有原生 zstd 时走内置解码器，不影响功能）

装完重开 DSH，设置里出现 **工具(脚本)管理** 即成功。
<a name="sec-quickstart"></a>


## 快速开始

1. **打开总闸**：设置 → 工具(脚本)管理 → 选项 → 打开「自动回顾」。默认关闭；不打开就不会产生回顾，跨会话固存也就没有原料。
2. **跑通一套命令**：抓页面、转码、打包、连 SSH——任何你真的跑通、且以后还会再用的东西。
3. **让它封存**：对模型说「将上述流程总结成工具」。
4. **以后直接用**：「跑一下 <id>」；想先看命令就加一句「先看看命令别执行」。

一次典型对话（输出为示意）：

~~~text
你：把刚才这套打包流程存成工具
模型：（调用 session_tool_create_write）已装好工具脚本 dsh-plugin-pack，目录 …/toolSequence/dsh-plugin-pack
     入口 pack.sh，参数 source_dir out_dir，下一轮装配后进入系统提示词。

（新会话）
你：跑一下 dsh-plugin-pack，源码目录是 /sdcard/Download/dsh-seal-scripts-0.4.6
模型：（调用 session_tool_call）exit 0，N 个文件，sha256 与清单一致
~~~
<a name="sec-tools"></a>


## 脚本固存（重点）

### 为什么不是一个笔记

模型很擅长把方法写成 markdown，写完就不能执行了；也很擅长现场重新拼命令，每次都拼得略有不同。
本插件的产物是**脚本本身**——当初跑通的那几行，逐字节存下来，连参数顺序都固定。

### 怎么触发

对模型说这两句之一，它自己会调对应工具：

| 你说 | 它做什么 | 适合 |
|---|---|---|
| 将上述流程总结成工具 | 把刚跑通的步骤固化成脚本 | 同会话内，命令还在上下文里 |
| 将之前会话的流程总结成工具 | 先用 `session_tool_create_read` 翻回顾原文（含每次工具调用的参数与结果），再固化 | 换会话、换机器、翻旧账 |

前提是那套命令真的跑通过。写进去的就是跑通的那一份，不是草稿——装完再改等于把整段上下文重发一次。

### 产物长什么样

~~~
$DSH_HOME/session-memory/toolSequence/
    _index.json             名单：id、标题、用途、入口、参数、步骤、每文件 sha256
    <id>/
        toolScript.json     清单：脚本全文、docs、hashes、provenance（来自哪份回顾第几行）
        <脚本>              真正执行的文件（.sh / .js .mjs .cjs / .ps1 / .bat .cmd）
        README.md           安装时按清单自动生成，给人看
        <说明>.md           只读说明：坑、路径、速度基准（不会被执行）
    _runs/                  输出超限时的全量日志
    <id>.bak-<时间戳>/      覆盖安装 / 导入时保留的旧目录
~~~

### 模型怎么知道有这个工具

系统提示词末尾会多一段「工具组」：条目最多 24 条，整段（标题 + 引导句 + 条目）上限 1600 字符，每条一行——`id（标题）：用途 ｜ 入口 ｜ 参数`。所以封存之后不需要你提醒它有这个工具。

清单什么时候换新（选项「清单词刷新时刻」）：

| 档位 | 行为 | 代价 |
|---|---|---|
| 新会话开始之前（默认） | 会话第一次装配时取一次，固定到会话结束 | 当前会话装/删工具不生效，提示词不变 |
| 会话内实时刷新 | 每轮现算 | 装/删后那一句缓存未命中一次（整份会话重发） |

改这个档位的那一下，会把所有已记住的会话立刻刷新成此刻现词——所以「当前会话看不到新工具」有明确的解法。

### 三个工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `session_tool_create_write` | 封存一条链 | `toolScript{ id, title, purpose, entry, scripts[], docs[], params, steps, timeoutMs }`；`replace` 覆盖 |
| `session_tool_create_read` | 回读回顾原文（含工具调用与结果），只读 | `file` 或 `date`+`nth`；`mode` = outline / raw / block；`cursor`、`chars` 分页；`line`、`span` 展开单条 |
| `session_tool_call` | 按原状执行 | `toolScript`、`step`、`args`、`stdin`、`cwd`、`dryRun`、`calls`、`stopOnError`、`allowDrift`、`timeoutMs`、`maxOutputBytes` |

- 不带参数调用 `session_tool_call`：列全部工具脚本名单。
- `dryRun: true`：只回显参数与 cwd，不执行。
- `calls: []`：最多 20 条顺序执行，逐条报退出码、耗时、stdout、stderr。

### 封存时的校验

| 项 | 规则 |
|---|---|
| `id` | 小写字母开头，2–41 位，只允许 `a-z0-9-` |
| 文件名 | 首字符字母数字，不许点开头、不许路径分隔符，最长 61 |
| `run` 与扩展名 | bash→`.sh`；node→`.js/.mjs/.cjs`；ps1→`.ps1`；cmd→`.bat/.cmd` |
| 体积 | 单脚本 ≤ 64 KB；一个工具脚本（脚本+说明）≤ 512 KB |
| `title` / `purpose` | 非空；purpose ≤ 600 字节（它进系统提示词，展示时超 80 字符截断） |
| `entry` / `steps` | 必须是 `scripts` 里的文件；entry 缺省取第一个脚本 |
| `timeoutMs` | 1000–600000，默认 120000 |
| 说明文件 | 必须 `.md`，不许叫 `README.md`，不许重名 |
| 脚本正文 | 不许空；不许出现 `<!--ovr:`（会破坏回顾分区） |
| 同名已存在 | 无 `replace` 直接拒绝，并给出清单 sha256 前 12 位 |

`steps` 只声明流水顺序，不会自动串跑；`params` 只声明 argv 顺序，不校验名字。

### 执行语义

| 项 | 值 |
|---|---|
| 解释器 | bash→PATH 里的 `bash`；node→当前 `process.execPath`；ps1→Windows 自带 powershell（非 Windows 用 `pwsh`）；cmd→`%ComSpec% /d /c`（非 Windows 退化成 `sh`） |
| argv | 解释器参数 + 脚本绝对路径 + 你的 args，数组传递，不经过 shell |
| cwd | `workspace`（会话工作区）、`toolScript`（脚本目录），或落在两者之内的绝对路径 |
| 环境变量 | 继承 `process.env`，另加 `TOOL_NAME`、`TOOL_SCRIPT`、`TOOL_ROOT`、`DSH_HOME` |
| 超时 | 默认 120 s，上限 600 s；SIGTERM → 2 s → SIGKILL；POSIX 杀进程组，Windows 走 `taskkill /T /F` |
| 输出 | 默认 64 KB、上限 1 MB，stdout 与 stderr 共用额度；超限时全量写进 `_runs/`，返回值给前一段加文件路径 |
| 返回值 | `{ exitCode, signal, timedOut, stdout, stderr, truncated, spill }`，不替调用方判成败 |
| 参数个数 | 实参多于 `params` 声明的数量 → 开跑前失败（会错位）；少传合法 |
| 漂移 | 跑前比对清单 sha256，不一致拒绝；`allowDrift: true` 放行并在结果里标 `drift` |
| 越界 | 只跑工具脚本目录内的文件；清单里没有的脚本名直接拒绝 |

### 导入 / 导出

- **导出**：自创工具页 → 导出。打成 `toolSequence.zip`（store，不压缩），直接写进当前会话的工作区目录并回真实路径，不走浏览器下载；超过 24 MB 直接拒绝。
- **导入**：选 zip → 先 `dryRun` 预览「会装哪些 / 会盖哪些 / 跳过哪些」→ 确认才写；同名目录留 `.bak-<时间戳>`。
- 包内的 `_index.json` 不采信，索引按落地文件重建；`_runs`、备份目录、越界路径、非法 id 一律跳过。
- 限制：单文件 ≤ 64 MB、合计 ≤ 128 MB，不支持 zip64 与加密包。
<a name="sec-reviews"></a>


## 回顾（上下文记忆）

回顾解决的问题：上下文被压缩之后，前面的细节原本就没了；现在被压掉的那段原文会被留成一份文件，需要时读回来。

### 什么时候产生

- 只有**压缩**才产生：DSH 自动压缩时，被压掉的事件当场落盘成一份回顾（摘要 + 原文 + 空的日记分区）。
- 工具调用与参数原样保留、不截断——日志删掉之后，回顾里的这份就是唯一原文。
- 子代理会话不产生；「自动回顾」关着时连检测都不做。
- 会话页的「删除并回顾」也会主动触发：先压缩、等回顾写出来、确认多了一份，才删会话；任一步失败都不删。

### 四级深度

| 时间 | 深度 | 模型看到 |
|---|---|---|
| 压缩当天 | 3 | 原对话（工具调用与报错被滤掉） |
| 第 2 天 | 2 | 压缩摘要 |
| 第 3–28 天 | 1 | 日记（模型自己总结的） |
| 第 29 天起 | 0 | 关键词 + 文件名，当索引 |

按本地日历日算，不看小时。你指出模型记错时，它会把原文读回来；只有**本工作区自己那份**被读出去才加一级并锁定（0→1、1→2），锁定后不再衰减。子级、平级、上级的回顾只读、不计深度。

### 按工作区扩面搜索

搜索单位是工作区的回顾文件夹，不是文件系统递归。顺序：本工作区自己 → 它的子级（从最深往回收）→ 平级（从最深往回收）→ 上一级 → 上一级的平级 → 它们的第 1、2 层子……外圈只有 `allowOuter` 为真才读，否则只数有几份并说明。

命中粒度：先关键词、再摘要、最后原文，命中哪层就整段返回那层；同一工作区内按层级、命中词数、压缩时刻排序。

### 补写提醒

深度降到 1 或 0 时，模型看到的是日记或关键词——这两个是它自己总结后写进去的。哪份还空着就会提醒它补，两个位置可选：

- **在上下文提醒**（默认）：并进回顾正文，同一条消息；写完这段文字变了，整条被替换，催促自动消失。
- **在系统侧提醒**：作为系统提示词末尾的一段。模型的遵守程度不同，按实际情况选。

### 注入与预览

- 回顾每轮自动进上下文，多条按时间从旧到新。
- 设置页「回顾」页的预览框与真实注入走同一个装配函数：框里看到的就是这一轮会送进去的文字（选中某条时只看那条）。
- 装配失败（例如回顾太大）不会静默变成「没有回顾」，而是给模型一段诊断：几份、合计多大、最大那份是谁、怎么处理。

### 和脚本固存的关系

一句话：回顾是固存的原料库。跨会话、换机器时，模型靠 `session_tool_create_read` 从回顾里翻出当初的命令与参数，再 `session_tool_create_write` 封存。回顾本身的细节不需要你调——打开「自动回顾」，其余用默认值即可。
<a name="sec-config"></a>


## 配置项

存在 `$DSH_HOME/session-memory/_options.json`，改完立刻生效，全部工作区共用。

| 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `autoReviewEnabled` | bool | `false` | 总闸：关着不建回顾、不注入、不装回顾工具 |
| `injectEnabled` | bool | `true` | 回顾注入与日记提醒的总开关（不管工具组清单） |
| `toolListEnabled` | bool | `true` | 是否注入工具组清单段，并按它装卸三个 `session_tool_*` |
| `toolListRefresh` | `newSession` / `realtime` | `newSession` | 清单段什么时候重算 |
| `fullLoad` | bool | `false` | 深度 3 也保留工具调用与报错（官方警告：会全文回灌） |
| `reminderChannel` | `context` / `system` | `context` | 日记提醒并进正文，还是走系统提示词段 |
| `stopLowering` | bool | `false` | 所有回顾停在记下的深度，不再按天衰减 |
| `loadLevel` | `follow` / 0–3 | `follow` | 载入时强制某一级（只改载入，不改已记深度） |

两条联动：自动回顾关着时「回顾注入」读出来一律按关算（存的值不改）；停止降低开启时「载入数值」回退到跟随深度。
<a name="sec-settings"></a>


## 设置页

设置 → **工具(脚本)管理**，四个标签：

| 标签 | 内容 |
|---|---|
| 自创工具 | 工具路径、即将注入的系统提示词原文、清单开关与刷新时刻、导入 / 导出 |
| 会话 | 按工作区分组的会话列表（标题、归档徽章），删除 / 删除并回顾（都二次确认） |
| 回顾 | 日历区间筛选、回顾列表（深度徽章）、注入预览、删除单条 |
| 选项 | 四组：工具固存、回顾注入、回顾内容、回顾深度 |
<a name="sec-data"></a>


## 数据位置与备份

~~~
$DSH_HOME/session-memory/
    _options.json                 选项
    _locale.json                  语言（中文 / 英文）
    _health.json                  每工作区最近一次成功/失败
    <工作区 key>/
        <时间戳>-<id>.md          回顾正文（唯一真相，纯文本，可读可搜可改）
        <同名>.json               这一份的载入缓存（丢了按文件时间重建）
        _assembly.json.migrated-*  旧版索引迁移遗留（永不自动删）
    toolSequence/                 工具脚本（机器级，所有工作区共用）
~~~

- 工作区 key 与宿主 `sessions/` 目录同一套编码：`/` 折成 `-`，非 ASCII 写成 `~XXXX`。
- 备份 = 整个 `session-memory/` 拷走；迁移 = 放到新机器同一位置，装同一个插件。
- 卸载插件不删数据。
<a name="sec-compat"></a>


## 兼容与降级

宿主缺能力时关掉对应那一块，其余照常（设置页顶部会列出缺了什么）：

| 缺失 | 影响 |
|---|---|
| `systemPrompt.context` | 回顾注入关闭 |
| `systemPrompt.section` | 日记提醒段与工具组清单段不出现 |
| `tools.register` | 五个工具都不装 |
| `webServer.register` | 设置页接口整块不装 |
| `agents.create` / `resume` | 只关「删除活会话 / 删除并回顾」 |

会话日志是多帧 zstd，按帧头逐帧解；没有原生 `zlib.zstdDecompressSync` 时走内置解码器，所以 Node 18 也能读标题。
<a name="sec-limits"></a>


## 已知限制

- 工具脚本**没有界面上的删除与编辑**：删要么重装覆盖（留 `.bak-`），要么手删目录（索引里仍会留着，之后跑会报「目录不存在」）。
- 工具脚本的 `steps` 不会自动串跑，连跑用 `calls`。
- 回顾只在压缩时产生；「回顾」页只有日历筛选，没有全文搜索。
- 子代理会话不产生回顾，也不催写日记。
- 导入导出只针对工具脚本，不搬回顾；回顾靠拷 `session-memory/`。
<a name="sec-dev"></a>


## 开发

~~~
index.js            插件入口（只导出 name / apply / inject）
cordis.patch.yml    往宿主 loader 插入插件
lib/core/           宿主侧逻辑：落盘、衰减、工具定义、脚本执行器
lib/host/           宿主服务适配：12 个 HTTP 端点、能力探测、会话删除
lib/client.js       设置页（React，注册到 settings.section）
~~~

- 零运行时依赖，ESM，Node `>=18`。
- 测试入口 `node --test test/*.test.mjs`（测试不在发布包内）。
- 打包：`npm pack`；发布白名单见 `package.json` 的 `files`。

## License

[MIT](./LICENSE) © dsh-seal-scripts contributors

仓库：<https://github.com/gosutry/dsh-seal-scripts> · 问题：<https://github.com/gosutry/dsh-seal-scripts/issues>

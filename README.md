# dsh-seal-scripts

**简体中文** | [English](./README.en.md)

> 把跑通的脚本封存成工具，把被压缩的对话留成回顾。

[![version](https://img.shields.io/npm/v/dsh-seal-scripts?color=4a7cff)](https://www.npmjs.com/package/dsh-seal-scripts)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.2--rc.1%20%3C1.0.0-6f42c1)](https://github.com/deepseek-ai/dsh)
[![deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](./package.json)

**脚本固存**：一次跑通的命令链当场固化成工具脚本，落成目录、写进清单、进系统提示词，下一句就能重跑。

**回顾**：DSH 压缩上下文时，被压掉的原文落盘成回顾文件，按自然日衰减后注入，需要细节时模型能读回原文。回顾也是跨会话固存的原料来源。

## 目录

- [特性](#sec-features)
- [安装](#sec-install)
- [快速开始](#sec-quickstart)
- [脚本固存](#sec-tools)
- [会话管理](#sec-sessions)
- [回顾](#sec-reviews)
- [配置与设置页](#sec-config)
- [数据位置与备份](#sec-data)
- [兼容与降级](#sec-compat)
- [已知限制](#sec-limits)
- [开发](#sec-dev)

<a name="sec-features"></a>

## 特性

#### 脚本固存

- **一条链 → 一个工具脚本**：脚本全文、入口、参数、步骤、出处、每文件 sha256。
- **进系统提示词**：工具组清单每轮列出，装几个列几个。
- **按原状执行**：参数走 argv 数组、不经 shell；解释器按 run 字段选。
- **可核对**：跑前比对 sha256，手改过的脚本拒绝，除非显式放行。
- **可搬运**：整组打 zip（store），导入先预览，索引按落地文件重建。

#### 上下文回顾

- **压缩即留档**：零模型调用，工具调用与参数原样保留。
- **四级衰减**：原文 → 摘要 → 日记 → 关键词；被读取时加一级并锁定。
- **按工作区扩面搜索**：本工作区 → 子级 → 平级 → 上级，外圈要许可。
- **补写提醒**：日记或关键词空着时催一次。

#### 工程面

- 零运行时依赖，只用 Node 内置模块；界面与注入跟随 DSH 的 8 种语言，模型侧报错与回执用英文。
- 宿主能力缺哪块关哪块。
- 数据是纯文本，`session-memory/` 拷走即备份。

<a name="sec-install"></a>

## 安装

插件管理器添加本包（包名、本地路径、tarball、Git 均可）。`--profile` 必填，如 `web`：

~~~bash
dsh plugin --profile web add dsh-seal-scripts
dsh plugin --profile web add /path/to/dsh-seal-scripts
~~~

第二行是本地目录，注册为 link 依赖。装完重开 profile 才加载。

要求：宿主 `@deepseek-ai/dsh` `>=0.2.2-rc.1`、`<1.0.0`（peer，不强制）；Node `>=18`。

装完设置里出现 **工具(脚本)管理** 即成功。

<a name="sec-quickstart"></a>

## 快速开始

1. **打开总闸**：设置 → 工具(脚本)管理 → 选项 → 打开「自动回顾」（默认关，关着不产生回顾）。
2. **跑通一套命令**。
3. **封存**：对模型说「将上述流程总结成工具」。
4. **复用**：「跑一下 <id>」；想先看命令加一句「先看看命令别执行」。

~~~text
你：把刚才这套打包流程存成工具
模型：（session_tool_create_write）已装好 dsh-plugin-pack，目录 …/toolSequence/dsh-plugin-pack
     入口 pack.sh，参数 source_dir out_dir

（新会话）
你：跑一下 dsh-plugin-pack，源码目录 /sdcard/Download/my-src
模型：（session_tool_call）exit 0，N 个文件，sha256 与清单一致
~~~

<a name="sec-tools"></a>

## 脚本固存

#### 为什么不是笔记

笔记不能执行，现场重拼命令每次都不一样。这里存的是脚本本身：当初跑通的那几行，逐字节保存，参数顺序固定。

#### 怎么触发

| 你说 | 它做什么 | 适合 |
|---|---|---|
| 将上述流程总结成工具 | 把刚跑通的步骤固化成脚本 | 同会话，命令还在上下文里 |
| 将之前会话的流程总结成工具 | 先用 `session_tool_create_read` 读回顾原文，再固化 | 换会话、换机器、翻旧账 |

存的是跑通的那一份，不是草稿；装完再改要重发整段上下文。

#### 产物长什么样

~~~
$DSH_HOME/session-memory/toolSequence/
    _index.json             名单：id、标题、用途、入口、参数、步骤、每文件 sha256
    <id>/
        toolScript.json     清单：脚本全文、docs、hashes、provenance
        <脚本>              真正执行的文件（.sh / .js .mjs .cjs / .ps1 / .bat .cmd）
        README.md           按清单自动生成
        <说明>.md           只读说明（不执行）
    _runs/                  每次执行的 stdout/stderr 全量日志
    <id>.bak-<时间戳>/      覆盖安装 / 导入保留的旧目录
~~~

#### 模型怎么知道有这个工具

系统提示词末尾多一段「工具组」，每条一行：`id（标题）：用途 ｜ 入口 ｜ 参数`。无条数与字数上限，purpose 全文。

| 档位 | 行为 | 代价 |
|---|---|---|
| 新会话开始前（默认） | 首次装配时取一次，固定到会话结束 | 会话内装/删工具，提示词不变 |
| 会话内实时刷新 | 每轮现算 | 装/删后那一句缓存未命中 |

改档位会立刻刷新所有已记住的会话。

#### 三个工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `session_tool_create_write` | 封存一条链 | `toolScript{ id, title, purpose, entry, scripts[], docs[], params, steps, timeoutMs }`；`replace` 覆盖 |
| `session_tool_create_read` | 只读回读回顾原文 | `file` 或 `date`+`nth`；`mode` = outline / raw / block；`cursor`、`chars`、`line`、`span` |
| `session_tool_call` | 按原状执行 | `toolScript`、`step`、`args`、`stdin`、`cwd`、`dryRun`、`calls`、`stopOnError`、`allowDrift`、`timeoutMs`、`maxOutputBytes` |

- 不带参数：列全部工具脚本。
- `dryRun: true`：只回显参数与 cwd。
- `calls: []`：按序全跑，不限条数，逐条报退出码、耗时、日志。

#### 封存时的校验

| 项 | 规则 |
|---|---|
| `id` | 小写字母开头，只允许 `a-z0-9-`，不限长度 |
| 文件名 | 首字符字母数字，只许字母数字与 . _ -，不许路径、不许点开头 |
| `run` 与扩展名 | bash→`.sh`；node→`.js/.mjs/.cjs`；ps1→`.ps1`；cmd→`.bat/.cmd` |
| 体积 | 不设上限 |
| `title` / `purpose` | 非空；purpose 不限字数 |
| `entry` / `steps` | 必须是 `scripts` 里的文件；entry 缺省取第一个 |
| `timeoutMs` | 正数即可（毫秒），运行时夹到 DSH 的 maxTimeoutMs，默认取 DSH 的 timeoutMs |
| 说明文件 | 必须 `.md`，不许叫 `README.md`，不许重名 |
| 脚本正文 | 不许空；不许出现 `<!--ovr:` |
| 同名已存在 | 无 `replace` 拒绝，回清单 sha256 前 12 位 |

`steps` 只声明顺序、不串跑；`params` 只声明 argv 顺序、不校验名字。

#### 执行语义

| 项 | 值 |
|---|---|
| 解释器 | bash；node 用 `process.execPath`；ps1 用 Windows powershell（非 Windows 用 `pwsh`）；cmd 用 `%ComSpec% /d /c`（非 Windows 退化成 `sh`） |
| argv | 解释器参数 + 脚本绝对路径 + args，数组传递，不经 shell |
| cwd | `workspace`、`toolScript`，或两者之内的绝对路径 |
| 环境变量 | 继承 `process.env`，另加 `TOOL_NAME`、`TOOL_SCRIPT`、`TOOL_ROOT`、`DSH_HOME` |
| 超时 | 跟随 DSH 终端设置（默认 120 s，上限 maxTimeoutMs）；到点转后台继续跑，回 pid 与日志路径；显式停机 SIGTERM → 2 s → SIGKILL；POSIX 杀进程组，Windows `taskkill /T /F` |
| 输出 | 默认 DSH maxOutputBytes；每次执行写 `_runs/`，回返回值带文件路径 |
| 返回值 | `{ exitCode, signal, timedOut, background, pid, logFile, stdout, stderr, truncated, spill }` |
| 参数个数 | 多于 `params` 声明的数量 → 开跑前失败；少传合法 |
| 漂移 | 跑前比对 sha256，不一致拒绝；`allowDrift: true` 放行并标 `drift` |
| 越界 | 只跑脚本目录内的文件；清单外的脚本名拒绝 |

#### 导入 / 导出

- **导出**：自创工具页 → 导出，打成 `toolSequence.zip`（store），写进当前会话工作区并回路径，不走浏览器下载。
- **导入**：选 zip → `dryRun` 预览 → 确认才写；同名目录留 `.bak-<时间戳>`。
- 包内 `_index.json` 不采信，索引按落地文件重建；`_runs`、备份目录、越界路径、非法 id 跳过。
- 大小不设上限；解压炸弹按「解压后总字节 + 16 MB vs 磁盘可用空间」判。不支持 zip64 与加密包。

#### 清除缓存

两次确认（第一下只换按钮文案）：

- **删**：`<id>.bak-<时间戳>` 回滚目录、`_runs/` 全部日志。
- **不删**：`_index.json`、每个 `<id>/` 目录。
- 只认「合法 id + `.bak-` + 纯数字」的目录；进行中的导入临时包跳过。
- 单项删不掉不中断整轮，回执报数量与字节。

<a name="sec-sessions"></a>

## 会话管理

会话页按工作区分组列出本机会话，一条一条管：整包导入、删除、删除并回顾。列表读的是落盘日志，不用打开会话也能看。

#### 列表

- **按工作区分组**：每个有会话的工作区一段，段头是工作区路径；空工作区不占位置。
- **每条一行**：会话标题（还没有标题时用 id 占位、灰色显示），归档的会话带「已归档」徽章。
- **读不出来就说**：日志解不开时列表顶上一句说明，不把读不出的会话显示成「空会话」。

#### 导入

- **一个按键**：页脚最左边「导入」，选 `dsh-session-<id>.zip` 即可，不用手搓目录；宿主写不了 zstd 时这个按钮直接禁用并说明原因。
- **先看后装**：选包先预演（会不会换新 id、要不要挂分支），确认才落盘。
- **写完就能开**：日志按 DSH 的格式压成「首帧户口本 + 正文帧」，再 `attachSession` 登记；图与文件按 sha256 落到附件库；落盘后通知宿主列表新增，主界面左侧立刻出现，不用重启。
- **撞号不硬来**：同 id 撞上本机任何已有会话就换新 id，原来那条一个字节都不动；同工作区的撞号还会挂成原会话的分支（`parentSession`），别的工作区只换号。带继承历史的会话（`isSeeded:true`）按包内实际条数记，照样能开、能挂分支。
- **写盘前先备份**：`workspace.json` 与目录册备份到目标工作区的 `会话导入备份-<时间>/`。

#### 删除

- **二次确认**：第一次点只把按钮变成「确认」，再点才真删。
- **活的先关**：会话还在内存里时先 cancel → 等闲 → flush → 释放句柄，再删目录；关不掉就拒绝，日志原样保留。
- **删完摘牌**：目录删掉后从工作区里摘掉，列表里同时消失。
- **残留会说**：引擎里还留着引用时，回执会明说「重启前可能还记着它」，不假装干净。

#### 删除并回顾

- **先留档再删**：先压缩出回顾、等拆出、校验通过，才删会话。
- **失败不删**：任何一步失败都不删，最坏情况是「压缩成功、拆失败、会话还在」；这一步不可逆。
- **日志**：每一步失败都写一行到 `session-memory/_compact-delete.log`，不然只剩一句英文报错。
- **产物**：生成的回顾出现在「回顾」页，按自然日衰减。

<a name="sec-reviews"></a>

## 回顾（上下文记忆）

被压掉的那段原文留成文件，需要时读回来。

#### 什么时候产生

- 只有**压缩**才产生：落盘成回顾（摘要 + 原文 + 空日记区）。
- 工具调用与参数原样保留、不截断。
- 子代理会话不产生；「自动回顾」关着连检测都不做。
- 「删除并回顾」主动触发：压缩 → 确认回顾落地 → 删会话；任一步失败不删。
- 压缩走宿主命令表：压缩服务按会话预设隔离，插件根上下文看不见它，`/compact` 由命令处理器执行。
- 压缩结束后取最新 `compaction/summary` 拆成回顾。
- 每步失败写一行到 `session-memory/_compact-delete.log`（>256 KB 留最后 64 KB）。

#### 四级深度

| 时间 | 深度 | 模型看到 |
|---|---|---|
| 压缩当天 | 3 | 原对话（工具调用与报错滤掉） |
| 第 2 天 | 2 | 压缩摘要 |
| 第 3–28 天 | 1 | 日记 |
| 第 29 天起 | 0 | 关键词 + 文件名 |

按本地日历日算。只有**本工作区自己那份**被读出去才加一级并锁定（0→1、1→2），锁定后不再衰减；子级、平级、上级只读、不计深度。

#### 按工作区扩面搜索

单位是工作区的回顾文件夹。顺序：本工作区 → 子级 → 平级 → 上一级 → 上一级的平级 → 再往下的 1、2 层子。外圈要 `allowOuter`。

命中先关键词、再摘要、最后原文；同工作区内按层级、命中词数、压缩时刻排序。

#### 补写提醒

深度降到 1 或 0 时，日记或关键词空着就催一次：

- **在上下文提醒**（默认）：并进回顾正文，写完自动消失。
- **在系统侧提醒**：作为系统提示词末尾的一段。

#### 注入与预览

- 回顾每轮自动进上下文，从旧到新。
- 设置页预览框与真实注入走同一装配函数（选中某条时只看那条）。
- 装配失败给模型一段诊断（几份、多大、最大那份是谁），不会变成「没有回顾」。

#### 两个回顾工具

「自动回顾」打开才装这两个工具。

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `session_mem_read` | 按线索找回顾，一次一条 | `need`（必填）、`skip`、`allowOuter` |
| `session_mem_write` | 读某份原文；写关键词与日记，可批量 | `file` 或 `date`+`nth`；`keywords`、`diary`；`writes[]` |

- 只给定位不给内容 = 读「原文」区：只留对话，工具调用整块剔除。
- 写多份用 `writes[]`：全部合格才落盘。
- 深度不由这两个工具改。

#### 和脚本固存的关系

回顾是固存的原料库：跨会话时模型用 `session_tool_create_read` 翻出命令与参数，再 `session_tool_create_write` 封存。

<a name="sec-config"></a>

## 配置与设置页

配置只有 `$DSH_HOME/session-memory/_options.json` 一份，改完立刻生效，所有工作区共用。设置 → **工具(脚本)管理** → **选项** 改的是同一份。

#### 设置页四个标签

| 标签 | 内容 |
|---|---|
| 自创工具 | 工具路径、注入的提示词原文、清单开关与刷新时刻、导入 / 导出 / 清除缓存 |
| 会话 | 按工作区分组的会话列表；导入会话包、删除、删除并回顾（后两者二次确认） |
| 回顾 | 日历筛选、回顾列表（深度徽章）、注入预览、删除单条 |
| 选项 | 四组：工具固存、回顾注入、回顾内容、回顾深度 |

#### 选项字段

| 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `autoReviewEnabled` | bool | `false` | 总闸：关着不建回顾、不注入、不装回顾工具 |
| `injectEnabled` | bool | `true` | 回顾注入与日记提醒（不含工具组清单） |
| `toolListEnabled` | bool | `true` | 注入工具组清单，并装卸三个 `session_tool_*` |
| `toolListRefresh` | `newSession` / `realtime` | `newSession` | 清单何时重算 |
| `fullLoad` | bool | `false` | 深度 3 也保留工具调用与报错（会全文回灌） |
| `reminderChannel` | `context` / `system` | `context` | 日记提醒的位置 |
| `stopLowering` | bool | `false` | 回顾停在记下的深度，不再按天衰减 |
| `loadLevel` | `follow` / 0–3 | `follow` | 载入时强制某一级（不改已记深度） |

两条联动：自动回顾关着时「回顾注入」按关算（存的值不改）；停止降低开启时「载入数值」回退到跟随深度。

#### 界面语言

跟 DSH 的设置走：设置页文案、回顾注入正文、日记提醒、工具组清单都切换。回顾文件按**写下那一刻**的语言写文件头与分区标题，之后换语言只换显示（8 种写法都认）。工具返回给模型的报错与回执是英文。

<a name="sec-data"></a>

## 数据位置与备份

~~~
$DSH_HOME/session-memory/
    _options.json                 选项
    _locale.json                  语言
    _health.json                  每工作区最近一次成功/失败
    _compact-delete.log           压缩与「删除并回顾」每步诊断（>256 KB 截断）
    <工作区 key>/
        <时间戳>-<id>.md          回顾正文（纯文本，可读可搜可改）
        <同名>.json               载入缓存（丢了按文件时间重建）
        _assembly.json.migrated-*  旧版索引迁移遗留（不自动删）
    toolSequence/                 工具脚本（机器级，所有工作区共用）
~~~

- 工作区 key 与宿主 `sessions/` 同套编码：`/` 折成 `-`，非 ASCII 写成 `~XXXX`。
- 备份 = 拷走整个 `session-memory/`；迁移 = 放到新机器同一位置，装同一插件。
- 卸载不删数据。

<a name="sec-compat"></a>

## 兼容与降级

宿主缺能力时关掉对应那块，其余照常（设置页顶部列出缺了什么）：

| 缺失 | 影响 |
|---|---|
| `systemPrompt.context` | 回顾注入关闭 |
| `systemPrompt.section` | 日记提醒段与工具组清单段不出现 |
| `tools.register` | 五个工具都不装 |
| `webServer.register` | 设置页接口不装 |
| `agents.create` / `resume` | 删除活会话只剩第 2 档（插件自造的 teardown） |
| `commands.execute` 或预设没挂 `command-compact` | 「删除并回顾」不可用，普通删除照常 |

删除活会话两档：① `agents.create` / `resume` 返回的 `dispose`，由生命周期捕获；② 无句柄时自造 `cancel({kind:'disposed'})` → `whenIdle()` → `scope.dispose()`。第 2 档只能停住 agent，摘注册表是宿主闭包动作、无公开接口，所以删除成功但带 `warnings`（设置页显示「已删除（引擎重启前可能还记着它）」）。

会话日志是多帧 zstd，按帧头逐帧解；无原生 `zlib.zstdDecompressSync` 时用内置解码器。

<a name="sec-limits"></a>

## 已知限制

- 工具脚本**没有界面删除与编辑**：重装覆盖（留 `.bak-`）或手删目录（索引仍留着，跑时报目录不存在）。
- `steps` 不自动串跑，连跑用 `calls`。
- 回顾只在压缩时产生；回顾页只有日历筛选，无全文搜索。
- 子代理会话不产生回顾，不催日记。
- 导入导出只管工具脚本，回顾靠拷 `session-memory/`。
- 「删除并回顾」要求该会话预设挂了 `command-compact`。
- 自造 teardown 收尾时，引擎重启前可能仍记着该会话。

<a name="sec-dev"></a>

## 开发

~~~
index.js            插件入口（导出 name / apply / inject）
cordis.patch.yml    往宿主 loader 插入插件
lib/core/           宿主侧逻辑：落盘、衰减、工具定义、脚本执行器
lib/host/           宿主服务适配：12 个 HTTP 端点、能力探测、会话删除
lib/client.js       设置页（React，注册到 settings.section）
~~~

- 零运行时依赖，ESM，Node `>=18`。
- 测试 `node --test test/*.test.mjs`（测试不进发布包）。
- 打包 `npm pack`，白名单见 `package.json` 的 `files`。

## License

[MIT](./LICENSE) © dsh-seal-scripts contributors

仓库：<https://github.com/gosutry/dsh-seal-scripts> · 问题：<https://github.com/gosutry/dsh-seal-scripts/issues>

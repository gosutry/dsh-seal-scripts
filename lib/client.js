window.__ModuleLoader__.load({
  id: 'dsh-seal-scripts',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var API = '/api/session-seal-scripts.'
    var NS = 'session-seal-scripts'

    /* ── 语言（0.2.3）────────────────────────────────────────────
       只跟 DSH 设置：读客户端的 locale 服务，每次切换就把它 POST 到
       /api/session-seal-scripts.locale，宿主那半边注入时按这个文件换字。
       界面文字走下面这张表；回顾正文里的中文标记由宿主当通配键处理。 */

    var LANG = 'zh'
    var langSubs = []
    var langPushed = false

    // 0.5.2：跟着 DSH 的 8 种语言走。先按主语言子标签匹配（ja-JP → ja），认不出按中文。
    var LANGS = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']

    function normalizeLangId(id) {
      var s = String(id === undefined || id === null ? '' : id).trim().toLowerCase()
      if (s === '') return 'zh'
      var primary = s.split(/[-_]/)[0]
      return LANGS.indexOf(primary) >= 0 ? primary : 'zh'
    }

    function pushLang() {
      try {
        if (typeof fetch !== 'function') return
        fetch(API + 'locale', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale: LANG })
        }).catch(function () { /* 老宿主没有这个端点：忽略，宿主按中文走 */ })
      } catch (e) { /* 同上 */ }
    }

    var localeService = null

    /** 页面自己的语言标记：locale 服务拿不到时的兜底。 */
    function pageLang() {
      try {
        if (typeof document !== 'undefined' && document && document.documentElement &&
          typeof document.documentElement.lang === 'string') return document.documentElement.lang
      } catch (e) { /* 没有 document：当空 */ }
      return ''
    }

    /** 读 DSH 现在用的语言；服务优先，页面标记兜底，都没有就给空串（保持现状）。 */
    function readActiveLocale() {
      if (!localeService) return pageLang()
      try {
        var snap = typeof localeService.getSnapshot === 'function'
          ? localeService.getSnapshot()
          : (typeof localeService.getLocale === 'function' ? localeService.getLocale() : null)
        if (snap && typeof snap.active === 'string' && snap.active !== '') return snap.active
      } catch (e) { /* 服务坏了就退回页面标记 */ }
      return pageLang()
    }

    /**
     * 收下一种语言。notify 为真时通知已挂载的组件重渲染；
     * 渲染路径里调它（label thunk、组件开头）要传 false，免得在渲染中 setState。
     */
    function applyLang(id, notify) {
      var next = normalizeLangId(id)
      var changed = next !== LANG
      LANG = next
      if (changed && notify) {
        for (var i = 0; i < langSubs.length; i++) { try { langSubs[i]() } catch (e) { /* 单个订阅坏掉不连累别的 */ } }
      }
      // 第一次解析出来的语言一定要推一次：否则宿主那边会留着上次的语言。
      if (changed || !langPushed) { langPushed = true; pushLang() }
      return changed
    }

    /** 从 locale 服务现读一次（渲染路径用，不触发重渲染）。 */
    function syncLangFromService() {
      var active = readActiveLocale()
      if (active !== '') applyLang(active, false)
    }

    /** locale 服务变了：重读并通知界面重渲染。 */
    function ensureLangNow() {
      var active = readActiveLocale()
      if (active !== '') applyLang(active, true)
    }

    /** 订阅语言变化（组件用它重渲染）。 */
    function subscribeLang(fn) {
      langSubs.push(fn)
      return function () {
        var i = langSubs.indexOf(fn)
        if (i >= 0) langSubs.splice(i, 1)
      }
    }

    /** 组件里调一下就行：语言一变，这个组件重渲染。 */
    function useLangTick() {
      var st = React.useState(0)
      var bump = st[1]
      React.useEffect(function () {
        return subscribeLang(function () { bump(function (n) { return n + 1 }) })
      }, [])
      return st[0]
    }

    /**
     * 跟着 DSH 的 locale 服务走。插件依赖里声明了 'locale'（见文件尾 inject），
     * 所以 ctx.locale 就是那个服务；旧宿主或测试桩没有它时退回 ctx.get('locale')，
     * 再没有就按中文——绝不让界面因为拿不到语言而空白。
     */
    function watchLocale(ctx) {
      try { localeService = ctx && ctx.locale ? ctx.locale : null } catch (e) { localeService = null }
      if (!localeService) {
        try { localeService = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null } catch (e) { localeService = null }
      }
      if (!localeService) {
        // 服务拿不到：至少把页面自己的语言标记读一次（不能订阅，切语言靠重新挂载）。
        syncLangFromService()
        return
      }
      syncLangFromService()
      try {
        if (typeof localeService.subscribe === 'function') localeService.subscribe(ensureLangNow)
      } catch (e) { /* 没有订阅能力就只读一次 */ }
    }

    /** 界面词条：中文就是原来的文案，英文一一对应。 */
    var TEXTS = {
      zh: {
        'app.title': '工具(脚本)管理',
        'tab.sessions': '会话',
        'tab.memory': '回顾',
        'tab.toolList': '自创工具',
        'tab.options': '选项',
        'loading': '读取中…',
        'loading.first': '读取中…（第一次要扫一遍会话日志）',
        'empty.sessions': '还没有任何会话',
        'empty.memories': '这个工作区还没有回顾',
        'health.failedTitle': '上次自动回顾失败',
        'health.failed': function (when, msg) { return '上次自动回顾失败（' + when + '）：' + msg },
        'host.degraded': function (blocks) { return '当前宿主能力不全，已关闭相关功能：' + blocks },
        'digest.noZstd': '本机 Node 缺 zstd 解压能力，会话标题与条数读不出来（回顾本身不受影响）',
        'ws.archived': function (n) { return ' · ' + n + ' 个归档' },
        'badge.archived': '归档',
        'ws.unknown': '(找不到当前工作区)',
        'box.none': '（当前没有载入任何回顾）',
        'box.noContent': '（这一条没有内容）',
        'box.err': function (msg) { return '（' + msg + '）' },
        'head.base': '当前载入的回顾',
        'head.pick': function (id, chars, loading) {
          return ' · 只看 ' + id + (loading ? ' · 读取中…' : ' · ' + chars + ' 字') + ' · 点这里回到全部'
        },
        'head.all': function (n, chars, level) {
          return ' · ' + n + ' 条 · ' + chars + ' 字' + (typeof level === 'number' ? ' · 载入深度 ' + level : '')
        },
        'ws.count': function (cwd, n, ranged, inRange) {
          return cwd + ' · ' + n + ' 条回顾' + (ranged ? ' · 区间内 ' + inRange + ' 条' : '')
        },
        'chip.depth': function (level, forced, pinned) {
          return '深度 ' + level + (forced ? ' · 载入覆盖' : (pinned ? ' · 锁定' : ''))
        },
        'range.empty': function (from, to) {
          return '选的区间里没有回顾（' + from + (to !== from ? ' ~ ' + to : '') + '）'
        },
        'btn.delete': '删除',
        'btn.deleteCompact': '删除并回顾',
        'btn.confirm': '确认删除？',
        'btn.confirmCompact': '确认压缩并删？',
        'btn.memDelete': '删除这条回顾',
        'note.saved': '已保存',
        'note.memConfirm': '再点一次确认：这条回顾会被永久删掉',
        'note.memDeleted': function (f) { return '已删除回顾 ' + f },
        'note.deleteConfirm': '再点一次确认删除（不可恢复）',
        'note.deleted': '已删除',
        'note.deletedLost': '已删除（响应中断，列表已确认消失）',
        'note.compactConfirm': '再点一次确认：先压缩改写历史再删除，两者都不可逆',
        'note.compacted': function (m) { return '已压缩并删除，回顾 ' + m },
        'err.request': function (p) { return '请求没送回结果（' + p + '）' },
        'cal.hint': '点两天选区间，再点一次清空',
        'cal.clear': '清空',
        'cal.month': function (y, m) { return y + ' 年 ' + (m + 1) + ' 月' },
        'cal.dow': ['日', '一', '二', '三', '四', '五', '六'],
        'switch.on': '已开启',
        'switch.off': '已关闭',
        'box.injectOff': '（回顾注入已关闭，未注入任何内容）',
        'opt.group.inject': '回顾注入',
        'opt.inject': '回顾注入',
        'opt.inject.desc': '开启时按下面的设置把回顾注入上下文，提醒注入到设置选择的对应位置。默认开启。',
        'opt.inject.offDesc': '已关闭：停止一切注入行为；下面四项只变灰不可改，已存的值原样保留、暂不生效。',
        'opt.group.content': '回顾内容',
        'opt.fullLoad': '全量加载',
        'opt.fullLoad.desc': '开启后深度 3 不再过滤工具内容：载入框与真正注入的回顾都保留 ▸ / ◂ 和报错。默认关闭。',
        'opt.fullLoad.warn': '警告：开启此项后，每一次压缩后都将全文回灌！将出现“压缩后比压缩前上下文更长”的负面情况！本选项是为新会话完整接续而设立的，如果你拥有其他导入会话的手段，请关闭此项！',
        'opt.reminder': '概括提醒',
        'opt.reminder.systemDesc': '在系统侧提醒：作为系统提示词段发出（0.1.47 起的方式）。日记一写完，这一段自动消失。',
        'opt.reminder.contextDesc': '在上下文提醒（默认）：并进回顾正文（0.1.46 的做法）；几份回顾日记都空着时，一份一段全列在同一条提醒里。',
        'opt.reminder.context': '在上下文提醒',
        'opt.reminder.system': '在系统侧提醒',
        'opt.group.depth': '回顾深度',
        'opt.stop': '停止降低',
        'opt.stop.desc': '开启后所有回顾停在载入文件里记下的深度，不再按自然日衰减。默认关闭。',
        'opt.loadLevel': '载入数值',
        'opt.loadLevel.off': '停止降低已开启：这一项不可选，已回到「跟随深度载入」。',
        'opt.loadLevel.desc': '只改载入时用哪一级，不改已经标记好的深度。',
        'opt.loadLevel.now': function (n) { return ' 现在所有回顾按第 ' + n + ' 级载入。' },
        'opt.follow': '跟随深度载入',
        'opt.l3': '3 · 原文',
        'opt.l2': '2 · 摘要',
        'opt.l1': '1 · 日记',
        'opt.l0': '0 · 关键词',
        'opt.note': '选项对全部工作区生效；改完立刻生效——注入、载入框、深度徽章都按新设置重算。',
        'opt.group.tools': '工具固存',
        'help.toolStore': '这一组只管「工具组清单」那一段系统提示词：注不注入、什么时候重算。它和「自动回顾」「回顾注入」互不影响，单独生效。',
        'opt.tlRefresh': '清单词刷新时刻',
        'opt.tlRefresh.newSession': '新会话开始之前',
        'opt.tlRefresh.realtime': '会话内实时刷新',
        'opt.tlRefresh.newDesc': '默认。清单在会话第一次装配时取一次现词，之后固定到会话结束：会话中途新增工具脚本，系统提示词不变，下一句仍走缓存。要让已经聊起来的会话看到新工具，开一个新会话。',
        'opt.tlRefresh.realtimeDesc': '每轮现算清单（0.4.4 及以前的做法）：装/删工具脚本后下一句就用新的系统提示词，但那一句要把整份会话当作未缓存输入重发一次。',
        'tl.group': '工具组清单',
        'tl.inject': '注入工具组清单',
        'tl.desc': '开启时把工具组清单注进系统提示词末尾：每个工具脚本一行（id、用途、入口、参数）。它和「自动回顾」「回顾注入」互不影响，单独开关。默认开启。',
        'tl.offDesc': '已关闭：工具组清单这一段不再注入。回顾正文与日记提醒不归这一项管——它们看「选项」里的「自动回顾」总闸与「回顾注入」开关。',
        'tl.preview': '要注入的内容',
        'tl.bytes': function (n) { return ' · ' + n + ' 字节' },
        'tl.empty': '（工具组里还没有工具脚本，这一段是空的；装好第一个工具脚本之后才会出现）',
        'tl.off': '（已关闭，不会注入；下面这框是关掉前的原文）',
        'tl.note': '预览框用的是和装配同一个函数算出来的现词，看到的就是会进系统提示词的那几行。它什么时候真的换新：',
        'tl.note.newSession': '当前是「新会话开始之前」——上面这框是下一个新会话会拿到的原文；当前会话里再装/删工具，系统提示词不会变，下一句仍走缓存。',
        'tl.note.realtime': '当前是「会话内实时刷新」——装/删工具脚本后下一轮才变（系统提示词缓存会未命中一次）。',
        'tl.path': function (p) { return '工具路径：' + p },
        'tl.export': '导出',
        'tl.import': '导入',
        'tl.exported': function (file, files, size) { return '已导出到 ' + file + '（' + files + ' 个文件，' + size + ' 字节，压缩率 0）' },
        'tl.overwritten': '；覆盖了同名文件',
        'tl.noWorkspace': '读不到当前会话的工作区，先随便发一条消息再回来点一次',
        'tl.importPreview': function (n, m) { return '读到 ' + n + ' 个工具脚本' + (m > 0 ? ('，其中 ' + m + ' 个会覆盖本机同名的（旧目录留 .bak-）') : '，和本机的都不冲突') },
        'tl.importSkipLine': function (n) { return '另有 ' + n + ' 项不收（运行溢写、备份目录、越界路径之类）' },
        'tl.importConfirm': '确认导入',
        'tl.importCancel': '取消',
        'tl.imported': function (n, k) { return '已导入 ' + n + ' 个工具脚本' + (k > 0 ? ('（覆盖了 ' + k + ' 个）') : '') },
        'tl.importSkipped': function (n) { return '；跳过 ' + n + ' 项（运行溢写、备份目录、越界路径之类不收）' },
        // 清除缓存（0.5.1）：删回滚版本与运行日志，工具本身不动。
        'tl.clearCache': '清除缓存',
        'tl.clearCacheConfirm': '确认清除',
        'tl.clearCacheHint': '再点一次就删：所有 .bak- 回滚版本与 _runs 里的运行日志都会没掉，工具脚本本身和索引不动。',
        'tl.cacheCleared': function (b, r, size) { return '已清除 ' + b + ' 个回滚版本、' + r + ' 个运行日志（共 ' + size + '）' },
        'tl.cacheEmpty': '没有可清除的回滚版本和运行日志',
        'tl.cacheSkipped': function (n) { return '；正有一个导入在进行，跳过 ' + n + ' 个临时包' },
        'tl.cachePartial': function (n) { return '；有 ' + n + ' 项没删掉（被占用或没权限），其余已清除' },
        // 问号气泡（0.3.10）：两段只读说明，点问号才出现。
        'help.aria': '说明',
        'help.toolList': '本页列出模型已通过该插件工具总结的脚本工作流，对模型发送提示词“将上述流程总结成工具”可让模型通过调用session_tool_create_write工具制作脚本序列；跨会话时，如果拥有回顾，对模型发送提示词“将之前会话的流程总结成工具”，模型会自己先调用session_tool_create_read读取之前会话的回顾文件。通过这些方式总结成可直接通过session_tool_call调用的脚本序列，会作为一项工具组注入到系统提示词。',
        'help.injectGroup': '回顾划分为四级深度，载入内容分别为：3级，载入原对话文本；2级，载入压缩概述；1级，载入模型总结；0级，仅载入关键词作为索引。\n回顾深度降低点分别为第二天、第三天、第二十八天及以后，在被用户指出模型内容记忆有误时，模型自身会调用session_mem_read直接读取回顾文件的原会话对话文本，并且对对应回顾加权并锁定载入内容。使用过程中出现深度为1级、0级的空回顾时，这是正常现象，插件会通过注入提醒来让模型调用session_mem_write写总结与提取关键词，上下文侧与系统提示词侧的遵守程度不同，请根据实际情况选用。\n不建议开启“全量加载”，关键节点建议直接使用DSH自带的分支功能。',
        'opt.auto': '自动回顾',
        'opt.auto.desc': '开启时维持原来的行为：压缩后创建回顾文件，并按下面的设置将回顾注入上下文，将提醒注入到选择的位置。关闭后停止创建与注入，下面所有选项变为不可改。',
        'opt.auto.off': '未开启回顾功能，已停止回顾文件的创建与注入，如果你没有其他记忆插件或者回顾工作流系统，建议开启本项。'
      },
      en: {
        'app.title': 'Tool (script) manager',
        'tab.sessions': 'Sessions',
        'tab.memory': 'Reviews',
        'tab.toolList': 'toolList',
        'tab.options': 'Options',
        'loading': 'Loading…',
        'loading.first': 'Loading… (the first run scans session logs)',
        'empty.sessions': 'No sessions yet',
        'empty.memories': 'No reviews in this workspace yet',
        'health.failedTitle': 'Last auto review failed',
        'health.failed': function (when, msg) { return 'Last auto review failed (' + when + '): ' + msg },
        'host.degraded': function (blocks) { return 'Host capabilities are incomplete; affected features are off: ' + blocks },
        'digest.noZstd': 'This Node build lacks zstd decompression, so session titles and counts cannot be read (reviews themselves are unaffected)',
        'ws.archived': function (n) { return ' · ' + n + ' archived' },
        'badge.archived': 'archived',
        'ws.unknown': '(current workspace not found)',
        'box.none': '(no review is loaded right now)',
        'box.noContent': '(this review has no content)',
        'box.err': function (msg) { return '(' + msg + ')' },
        'head.base': 'Currently loaded reviews',
        'head.pick': function (id, chars, loading) {
          return ' · only ' + id + (loading ? ' · loading…' : ' · ' + chars + ' chars') + ' · click to show all'
        },
        'head.all': function (n, chars, level) {
          return ' · ' + n + ' reviews · ' + chars + ' chars' + (typeof level === 'number' ? ' · load depth ' + level : '')
        },
        'ws.count': function (cwd, n, ranged, inRange) {
          return cwd + ' · ' + n + ' reviews' + (ranged ? ' · ' + inRange + ' in range' : '')
        },
        'chip.depth': function (level, forced, pinned) {
          return 'depth ' + level + (forced ? ' · load override' : (pinned ? ' · locked' : ''))
        },
        'range.empty': function (from, to) {
          return 'No reviews in the selected range (' + from + (to !== from ? ' ~ ' + to : '') + ')'
        },
        'btn.delete': 'Delete',
        'btn.deleteCompact': 'Delete + review',
        'btn.confirm': 'Confirm delete?',
        'btn.confirmCompact': 'Confirm compact + delete?',
        'btn.memDelete': 'Delete this review',
        'note.saved': 'Saved',
        'note.memConfirm': 'Click again: this review will be deleted permanently',
        'note.memDeleted': function (f) { return 'Deleted review ' + f },
        'note.deleteConfirm': 'Click again to confirm delete (cannot be undone)',
        'note.deleted': 'Deleted',
        'note.deletedLost': 'Deleted (the response was lost; the list confirms it is gone)',
        'note.compactConfirm': 'Click again: compact the history first, then delete — neither can be undone',
        'note.compacted': function (m) { return 'Compacted and deleted; review ' + m },
        'err.request': function (p) { return 'No response from ' + p },
        'cal.hint': 'Click two days to pick a range; click again to clear',
        'cal.clear': 'Clear',
        'cal.month': function (y, m) {
          return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m] + ' ' + y
        },
        'cal.dow': ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
        'switch.on': 'On',
        'switch.off': 'Off',
        'box.injectOff': '(recall injection is off — nothing is injected)',
        'opt.group.inject': 'Recall injection',
        'opt.inject': 'Recall injection',
        'opt.inject.desc': 'When on, reviews are injected into the context and the system prompt per the options below. On by default.',
        'opt.inject.offDesc': 'Off: all injection stops; the four options below are greyed out and keep their stored values, which have no effect until this is turned back on.',
        'opt.group.content': 'Review content',
        'opt.fullLoad': 'Full load',
        'opt.fullLoad.desc': 'When on, depth 3 stops filtering tool content: both the preview and the real injection keep ▸ / ◂ and errors. Off by default.',
        'opt.fullLoad.warn': 'Warning: with this on, every compaction is replayed in full! The context after a compaction can end up longer than before it. This option exists so a new session can continue seamlessly; if you have another way to import sessions, turn it off.',
        'opt.reminder': 'Reminder',
        'opt.reminder.systemDesc': 'In system prompt: sent as a system-prompt section (the 0.1.47 way). It disappears as soon as the diary is written.',
        'opt.reminder.contextDesc': 'In context (default): merged into the review body (the 0.1.46 way); when several reviews still lack diaries, they are listed one after another in a single reminder.',
        'opt.reminder.context': 'In context',
        'opt.reminder.system': 'In system prompt',
        'opt.group.depth': 'Review depth',
        'opt.stop': 'Stop lowering',
        'opt.stop.desc': 'When on, every review stays at the depth recorded in its load file and never decays by calendar day. Off by default.',
        'opt.loadLevel': 'Load level',
        'opt.loadLevel.off': 'Stop lowering is on: this option is disabled and has been reset to “Follow depth”.',
        'opt.loadLevel.desc': 'Only changes which level is used when loading; it never changes the marked depth.',
        'opt.loadLevel.now': function (n) { return ' All reviews now load at level ' + n + '.' },
        'opt.follow': 'Follow depth',
        'opt.l3': '3 · transcript',
        'opt.l2': '2 · summary',
        'opt.l1': '1 · diary',
        'opt.l0': '0 · keywords',
        'opt.note': 'Options apply to every workspace and take effect immediately — injection, preview and depth chips all recompute.',
        'opt.group.tools': 'Sealed tools',
        'help.toolStore': 'This group governs only the toolSequence section of the system prompt: whether it is injected and when it is recomputed. It is independent of "Auto review" and "Recall injection".',
        'opt.tlRefresh': 'When the list is refreshed',
        'opt.tlRefresh.newSession': 'Before a new session starts',
        'opt.tlRefresh.realtime': 'Live within the session',
        'opt.tlRefresh.newDesc': 'Default. The list is taken once, when a session is first assembled, and then frozen until that session ends: installing a toolScript mid-session leaves the system prompt untouched and the next turn still hits the cache. To show an ongoing session the new tool, start a new session.',
        'opt.tlRefresh.realtimeDesc': 'The list is recomputed every turn (the behaviour up to 0.4.4): the next turn after installing or removing a toolScript uses the new system prompt, at the cost of re-sending the whole conversation as uncached input once.',
        'tl.group': 'ToolSequence list',
        'tl.inject': 'Inject toolSequence list',
        'tl.desc': 'When on, the toolSequence list is appended to the system prompt: one line per toolScript (id, purpose, entry, args). It is independent of "Auto review" and "Recall injection" and has its own switch. On by default.',
        'tl.offDesc': 'Off: this section is not injected. The review body and diary reminder are not governed by this switch — they follow "Auto review" and "Recall injection" in Options.',
        'tl.preview': 'What would be injected',
        'tl.bytes': function (n) { return ' · ' + n + ' bytes' },
        'tl.empty': '(the toolSequence has no toolScripts yet, so this section is empty; it appears once the first toolScript is installed)',
        'tl.off': '(off — nothing is injected; the box below shows the text from before it was turned off)',
        'tl.note': 'The preview calls the same function the assembler uses, so it is exactly the text that would enter the system prompt. When it actually changes:',
        'tl.note.newSession': 'currently "Before a new session starts" — the box above is what the next new session will get; installing or removing toolScripts in this session leaves the system prompt untouched.',
        'tl.note.realtime': 'currently "Live within the session" — it changes on the next turn after installing or removing a toolScript (one prompt-cache miss).',
        'tl.path': function (p) { return 'Tool path: ' + p },
        'tl.export': 'Export',
        'tl.import': 'Import',
        'tl.exported': function (file, files, size) { return 'Exported to ' + file + ' (' + files + ' files, ' + size + ' bytes, compression level 0)' },
        'tl.overwritten': '; the file with the same name was overwritten',
        'tl.noWorkspace': 'Cannot tell which workspace this session belongs to; send one message and come back',
        'tl.importPreview': function (n, m) { return n + ' toolScripts found' + (m > 0 ? ('; ' + m + ' overwrite local ones with the same id (the old folder is kept as .bak-)') : ', none clash with local ones') },
        'tl.importSkipLine': function (n) { return n + ' more entries are not taken (run spills, backup folders, out-of-range paths)' },
        'tl.importConfirm': 'Confirm import',
        'tl.importCancel': 'Cancel',
        'tl.imported': function (n, k) { return 'Imported ' + n + ' toolScripts' + (k > 0 ? (' (' + k + ' overwritten)') : '') },
        'tl.importSkipped': function (n) { return '; skipped ' + n + ' entries (run spills, backup folders and out-of-range paths are not taken)' },
        'tl.clearCache': 'Clear cache',
        'tl.clearCacheConfirm': 'Confirm clear',
        'tl.clearCacheHint': 'Click once more to delete: every .bak- rollback version and every run log in _runs goes away. The toolScripts themselves and the index stay.',
        'tl.cacheCleared': function (b, r, size) { return 'Cleared ' + b + ' rollback version(s) and ' + r + ' run log(s) (' + size + ' total)' },
        'tl.cacheEmpty': 'Nothing to clear — no rollback versions or run logs',
        'tl.cacheSkipped': function (n) { return '; an import is running, so ' + n + ' temporary package(s) were skipped' },
        'tl.cachePartial': function (n) { return '; ' + n + ' item(s) could not be removed (in use or no permission), the rest is gone' },
        'help.aria': 'Help',
        'help.toolList': 'This page lists the script workflows the model has already wrapped up with this plugin’s tools. Send the model “turn the flow above into a toolScript” and it will call session_tool_create_write to build one; across sessions, when a review exists, send “turn the previous session’s flow into a toolScript” and the model will first call session_tool_create_read to read that review file. ToolScripts gathered this way are runnable with session_tool_call, and the list is injected into the system prompt as a toolSequence section.',
        'help.injectGroup': 'A review has four depths, each loading something different: level 3, the original transcript; level 2, the compaction summary; level 1, the model’s own summary; level 0, keywords only, used as an index.\nDepths drop on the second day, the third day, and the twenty-eighth day onward. When you point out that the model misremembers something, the model itself calls session_mem_read to read that review’s original transcript, then weights and locks the loaded content of that review. An empty review at depth 1 or 0 is normal: the plugin injects a reminder telling the model to call session_mem_write with a summary and keywords. Compliance differs between the context channel and the system-prompt channel, so pick whichever fits.\nTurning on “Full load” is not recommended; for important checkpoints, use DSH’s own branching instead.',
        'opt.auto': 'Auto review',
        'opt.auto.desc': 'When on, behaviour stays as before: a review is created on every compaction and injected into the context and system prompt per the options below. When off, creation and injection stop and every option below becomes read-only.',
        'opt.auto.off': 'Review is off, so review files are neither created nor injected. If you have no other memory plugin or review workflow, turn this on.'
      },
      ja: {
        'app.title': 'ツール（スクリプト）管理',
        'tab.sessions': 'セッション',
        'tab.memory': 'レビュー',
        'tab.toolList': '自作ツール',
        'tab.options': 'オプション',
        'loading': '読み込み中…',
        'loading.first': '読み込み中…（初回はセッションログを走査します）',
        'empty.sessions': 'セッションはまだありません',
        'empty.memories': 'このワークスペースにはまだレビューがありません',
        'health.failedTitle': '前回の自動レビューに失敗しました',
        'health.failed': function (when, msg) { return '前回の自動レビューに失敗しました（' + when + '）：' + msg },
        'host.degraded': function (blocks) { return 'ホストの機能が不足しているため、関連機能を停止しました：' + blocks },
        'digest.noZstd': 'この Node には zstd 展開機能がないため、セッションのタイトルと件数を読めません（レビュー自体には影響しません）',
        'ws.archived': function (n) { return ' · アーカイブ ' + n + ' 件' },
        'badge.archived': 'アーカイブ',
        'ws.unknown': '(現在のワークスペースが見つかりません)',
        'box.none': '（現在読み込まれているレビューはありません）',
        'box.noContent': '（この項目には内容がありません）',
        'box.err': function (msg) { return '（' + msg + '）' },
        'head.base': '現在読み込まれているレビュー',
        'head.pick': function (id, chars, loading) {
          return ' · ' + id + ' のみ' + (loading ? ' · 読み込み中…' : ' · ' + chars + ' 文字') + ' · ここをクリックで全体に戻る'
        },
        'head.all': function (n, chars, level) {
          return ' · ' + n + ' 件 · ' + chars + ' 文字' + (typeof level === 'number' ? ' · 読み込み深度 ' + level : '')
        },
        'ws.count': function (cwd, n, ranged, inRange) {
          return cwd + ' · ' + n + ' 件のレビュー' + (ranged ? ' · 範囲内 ' + inRange + ' 件' : '')
        },
        'chip.depth': function (level, forced, pinned) {
          return '深度 ' + level + (forced ? ' · 読み込み上書き' : (pinned ? ' · ロック' : ''))
        },
        'range.empty': function (from, to) {
          return '選択した範囲にレビューはありません（' + from + (to !== from ? ' ~ ' + to : '') + '）'
        },
        'btn.delete': '削除',
        'btn.deleteCompact': '削除してレビュー',
        'btn.confirm': '削除を確認？',
        'btn.confirmCompact': '圧縮して削除を確認？',
        'btn.memDelete': 'このレビューを削除',
        'note.saved': '保存しました',
        'note.memConfirm': 'もう一度クリックで確定：このレビューは完全に削除されます',
        'note.memDeleted': function (f) { return 'レビューを削除しました ' + f },
        'note.deleteConfirm': 'もう一度クリックで削除を確定（元に戻せません）',
        'note.deleted': '削除しました',
        'note.deletedLost': '削除しました（応答が途切れましたが、一覧から消えたことを確認しました）',
        'note.compactConfirm': 'もう一度クリックで確定：先に履歴を圧縮してから削除します。どちらも元に戻せません',
        'note.compacted': function (m) { return '圧縮して削除しました。レビュー ' + m },
        'err.request': function (p) { return 'リクエストの結果が返ってきません（' + p + '）' },
        'cal.hint': '2 日をクリックで範囲選択、もう一度クリックで解除',
        'cal.clear': 'クリア',
        'cal.month': function (y, m) { return y + '年 ' + (m + 1) + '月' },
        'cal.dow': ['日', '月', '火', '水', '木', '金', '土'],
        'switch.on': 'オン',
        'switch.off': 'オフ',
        'box.injectOff': '（レビュー注入はオフです。何も注入していません）',
        'opt.group.inject': 'レビュー注入',
        'opt.inject': 'レビュー注入',
        'opt.inject.desc': 'オンにすると、以下の設定に従ってレビューをコンテキストに注入し、リマインダーを指定位置に注入します。既定はオン。',
        'opt.inject.offDesc': 'オフ：すべての注入を停止します。以下の 4 項目はグレー表示になり変更できませんが、保存済みの値はそのまま残ります。',
        'opt.group.content': 'レビュー内容',
        'opt.fullLoad': '全量読み込み',
        'opt.fullLoad.desc': 'オンにすると深度 3 でもツール内容を絞り込まず、プレビューと実際の注入の両方で ▸ / ◂ とエラーを残します。既定はオフ。',
        'opt.fullLoad.warn': '警告：オンにすると圧縮のたびに全文を再注入します。「圧縮後が圧縮前より長いコンテキスト」になる可能性があります。この項目は新しいセッションへ完全に引き継ぐためのもので、他にセッションを取り込む手段があるならオフにしてください。',
        'opt.reminder': '要約リマインダー',
        'opt.reminder.systemDesc': 'システム側で通知：システムプロンプトのセクションとして送ります（0.1.47 以降の方式）。日記を書けば自動的に消えます。',
        'opt.reminder.contextDesc': 'コンテキストで通知（既定）：レビュー本文に併合します（0.1.46 の方式）。日記が空のレビューが複数あるときは、1 つのリマインダーにまとめて列挙します。',
        'opt.reminder.context': 'コンテキストで通知',
        'opt.reminder.system': 'システム側で通知',
        'opt.group.depth': 'レビュー深度',
        'opt.stop': '低下を停止',
        'opt.stop.desc': 'オンにすると、すべてのレビューは読み込みファイルに記録された深度のまま止まり、暦日で減衰しません。既定はオフ。',
        'opt.loadLevel': '読み込み深度',
        'opt.loadLevel.off': '「低下を停止」がオンのため選択できません。「深度に従って読み込む」に戻しました。',
        'opt.loadLevel.desc': '読み込み時に使うレベルだけを変え、記録済みの深度は変えません。',
        'opt.loadLevel.now': function (n) { return ' 現在すべてのレビューをレベル ' + n + ' で読み込みます。' },
        'opt.follow': '深度に従って読み込む',
        'opt.l3': '3 · 原文',
        'opt.l2': '2 · 要約',
        'opt.l1': '1 · 日記',
        'opt.l0': '0 · キーワード',
        'opt.note': '設定はすべてのワークスペースに適用され、すぐ反映されます——注入・プレビュー・深度バッジは新しい設定で再計算されます。',
        'opt.group.tools': 'ツール封入',
        'help.toolStore': 'このグループはシステムプロンプトの「ツールグループ一覧」の段落だけを扱います：注入するか、いつ再計算するか。自動レビューやレビュー注入とは独立して効きます。',
        'opt.tlRefresh': '一覧を更新するタイミング',
        'opt.tlRefresh.newSession': '新しいセッションの開始前',
        'opt.tlRefresh.realtime': 'セッション内でリアルタイム',
        'opt.tlRefresh.newDesc': '既定。一覧はセッションの初回組み立て時に一度だけ取得され、その後セッション終了まで固定されます。途中でツールスクリプトを追加してもシステムプロンプトは変わらず、次の発話もキャッシュを使います。進行中のセッションに新しいツールを見せたいときは新しいセッションを開いてください。',
        'opt.tlRefresh.realtimeDesc': '毎ターン一覧を計算します（0.4.4 以前の方式）。ツールスクリプトの追加・削除の次の発話から新しいシステムプロンプトになりますが、その発話では会話全体を未キャッシュ入力として再送します。',
        'tl.group': 'ツールグループ一覧',
        'tl.inject': 'ツールグループ一覧を注入',
        'tl.desc': 'オンにすると、ツールグループ一覧をシステムプロンプトの末尾に注入します：ツールスクリプトごとに 1 行（id、用途、入口、引数）。自動レビューやレビュー注入とは独立したスイッチです。既定はオン。',
        'tl.offDesc': 'オフ：この段落は注入されません。レビュー本文と日記リマインダーはこの項目の対象外で、「オプション」の「自動レビュー」と「レビュー注入」に従います。',
        'tl.preview': '注入される内容',
        'tl.bytes': function (n) { return ' · ' + n + ' バイト' },
        'tl.empty': '（ツールグループにはまだツールスクリプトがありません。この段落は空で、最初のツールスクリプトを入れると現れます）',
        'tl.off': '（オフのため注入されません。下の枠はオフにする前の原文です）',
        'tl.note': 'プレビュー枠は組み立てと同じ関数で計算した現在の文言なので、表示されているのは実際にシステムプロンプトへ入る行です。本当に切り替わるタイミング：',
        'tl.note.newSession': '現在は「新しいセッションの開始前」——上の枠は次の新しいセッションが受け取る原文です。現在のセッションでツールを追加・削除してもシステムプロンプトは変わらず、次の発話もキャッシュを使います。',
        'tl.note.realtime': '現在は「セッション内でリアルタイム」——ツールスクリプトの追加・削除の次のターンで変わります（システムプロンプトのキャッシュが 1 回ミスします）。',
        'tl.path': function (p) { return 'ツールのパス：' + p },
        'tl.export': 'エクスポート',
        'tl.import': 'インポート',
        'tl.exported': function (file, files, size) { return 'エクスポートしました ' + file + '（' + files + ' ファイル、' + size + ' バイト、圧縮率 0）' },
        'tl.overwritten': '；同名ファイルを上書きしました',
        'tl.noWorkspace': '現在のセッションのワークスペースを特定できません。一度メッセージを送ってから戻ってきてください',
        'tl.importPreview': function (n, m) { return n + ' 個のツールスクリプトを読み取りました' + (m > 0 ? '（うち ' + m + ' 個は同名で上書きされ、旧フォルダは .bak- として残ります）' : '（ローカルと競合しません）') },
        'tl.importSkipLine': function (n) { return 'ほかに ' + n + ' 項目は取り込みません（実行ログ、バックアップフォルダ、範囲外パスなど）' },
        'tl.importConfirm': 'インポートを確定',
        'tl.importCancel': 'キャンセル',
        'tl.imported': function (n, k) { return n + ' 個のツールスクリプトをインポートしました' + (k > 0 ? '（' + k + ' 個を上書き）' : '') },
        'tl.importSkipped': function (n) { return '；' + n + ' 項目をスキップしました（実行ログ、バックアップフォルダ、範囲外パスなど）' },
        'tl.clearCache': 'キャッシュを消去',
        'tl.clearCacheConfirm': '消去を確定',
        'tl.clearCacheHint': 'もう一度クリックで削除：すべての .bak- ロールバック版と _runs の実行ログが消えます。ツールスクリプト本体とインデックスは残ります。',
        'tl.cacheCleared': function (b, r, size) { return 'ロールバック版 ' + b + ' 個、実行ログ ' + r + ' 個を消去しました（合計 ' + size + '）' },
        'tl.cacheEmpty': '消去できるロールバック版も実行ログもありません',
        'tl.cacheSkipped': function (n) { return '；インポート実行中のため、一時パッケージ ' + n + ' 個をスキップしました' },
        'tl.cachePartial': function (n) { return '；' + n + ' 項目を削除できませんでした（使用中または権限なし）。ほかは消去済みです' },
        'help.aria': '説明',
        'help.toolList': 'このページには、モデルがこのプラグインのツールでまとめたスクリプトの流れが並びます。モデルに「上の流れをツールにまとめて」と送ると、session_tool_create_write を呼んでスクリプト列を作ります。セッションをまたぐ場合は、レビューがあれば「前のセッションの流れをツールにまとめて」と送ると、モデルがまず session_tool_create_read でそのレビューの原文を読みます。こうしてまとめたスクリプト列は session_tool_call で直接実行でき、ツールグループとしてシステムプロンプトに注入されます。',
        'help.injectGroup': 'レビューは 4 段階の深度に分かれ、読み込む内容が異なります：レベル 3 は元の会話文、レベル 2 は圧縮要約、レベル 1 はモデル自身のまとめ、レベル 0 はキーワードのみ（索引として使う）。\n深度は 2 日目、3 日目、28 日目以降に下がります。モデルの記憶違いを指摘すると、モデルは session_mem_read を呼んでそのレビューの原文を読み直し、該当レビューの重みを上げて読み込み内容をロックします。レベル 1・0 の空レビューは正常で、プラグインは注入リマインダーでモデルに session_mem_write でまとめとキーワードを書かせます。コンテキスト側とシステムプロンプト側で遵守度が異なるため、状況に応じて選んでください。\n「全量読み込み」は推奨しません。重要な区切りでは DSH 標準のブランチ機能を使ってください。',
        'opt.auto': '自動レビュー',
        'opt.auto.desc': 'オンにすると従来どおり：圧縮のたびにレビューファイルを作り、以下の設定でレビューをコンテキストとシステムプロンプトに注入し、リマインダーを選択位置に注入します。オフにすると作成と注入を停止し、以下の設定はすべて変更できなくなります。',
        'opt.auto.off': 'レビュー機能はオフです。レビューファイルの作成も注入も停止しています。他の記憶プラグインやレビュー運用がない場合はこの項目をオンにしてください。'
      },
      es: {
        'app.title': 'Gestor de herramientas (scripts)',
        'tab.sessions': 'Sesiones',
        'tab.memory': 'Revisiones',
        'tab.toolList': 'Herramientas propias',
        'tab.options': 'Opciones',
        'loading': 'Cargando…',
        'loading.first': 'Cargando… (la primera vez se escanean los registros de sesión)',
        'empty.sessions': 'Aún no hay sesiones',
        'empty.memories': 'Este espacio de trabajo aún no tiene revisiones',
        'health.failedTitle': 'La última revisión automática falló',
        'health.failed': function (when, msg) { return 'La última revisión automática falló (' + when + '): ' + msg },
        'host.degraded': function (blocks) { return 'El host no ofrece todas las capacidades; se desactivaron las funciones afectadas: ' + blocks },
        'digest.noZstd': 'Este Node no tiene descompresión zstd, así que no se pueden leer los títulos ni los recuentos de sesión (las revisiones no se ven afectadas)',
        'ws.archived': function (n) { return ' · ' + n + ' archivadas' },
        'badge.archived': 'archivada',
        'ws.unknown': '(no se encuentra el espacio de trabajo actual)',
        'box.none': '(ahora mismo no hay ninguna revisión cargada)',
        'box.noContent': '(esta revisión no tiene contenido)',
        'box.err': function (msg) { return '(' + msg + ')' },
        'head.base': 'Revisiones cargadas ahora',
        'head.pick': function (id, chars, loading) {
          return ' · solo ' + id + (loading ? ' · cargando…' : ' · ' + chars + ' caracteres') + ' · clic para ver todo'
        },
        'head.all': function (n, chars, level) {
          return ' · ' + n + ' revisiones · ' + chars + ' caracteres' + (typeof level === 'number' ? ' · profundidad de carga ' + level : '')
        },
        'ws.count': function (cwd, n, ranged, inRange) {
          return cwd + ' · ' + n + ' revisiones' + (ranged ? ' · ' + inRange + ' en el rango' : '')
        },
        'chip.depth': function (level, forced, pinned) {
          return 'profundidad ' + level + (forced ? ' · carga forzada' : (pinned ? ' · bloqueada' : ''))
        },
        'range.empty': function (from, to) {
          return 'No hay revisiones en el rango elegido (' + from + (to !== from ? ' ~ ' + to : '') + ')'
        },
        'btn.delete': 'Eliminar',
        'btn.deleteCompact': 'Eliminar + revisión',
        'btn.confirm': '¿Confirmar eliminación?',
        'btn.confirmCompact': '¿Confirmar comprimir y eliminar?',
        'btn.memDelete': 'Eliminar esta revisión',
        'note.saved': 'Guardado',
        'note.memConfirm': 'Haz clic otra vez: esta revisión se eliminará para siempre',
        'note.memDeleted': function (f) { return 'Revisión eliminada ' + f },
        'note.deleteConfirm': 'Haz clic otra vez para confirmar la eliminación (no se puede deshacer)',
        'note.deleted': 'Eliminado',
        'note.deletedLost': 'Eliminado (se perdió la respuesta; la lista confirma que ya no está)',
        'note.compactConfirm': 'Haz clic otra vez: primero se comprime la historia y luego se elimina; nada de eso se puede deshacer',
        'note.compacted': function (m) { return 'Comprimido y eliminado; revisión ' + m },
        'err.request': function (p) { return 'No hubo respuesta de ' + p },
        'cal.hint': 'Haz clic en dos días para elegir un rango; otro clic para borrarlo',
        'cal.clear': 'Borrar',
        'cal.month': function (y, m) {
          return ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][m] + ' de ' + y
        },
        'cal.dow': ['D', 'L', 'M', 'X', 'J', 'V', 'S'],
        'switch.on': 'Activado',
        'switch.off': 'Desactivado',
        'box.injectOff': '(la inyección de revisiones está desactivada; no se inyecta nada)',
        'opt.group.inject': 'Inyección de revisiones',
        'opt.inject': 'Inyección de revisiones',
        'opt.inject.desc': 'Cuando está activada, las revisiones se inyectan en el contexto y el aviso en la posición elegida según las opciones de abajo. Activada por defecto.',
        'opt.inject.offDesc': 'Desactivada: se detiene toda inyección; las cuatro opciones de abajo quedan en gris y conservan sus valores guardados, que no surten efecto hasta volver a activarla.',
        'opt.group.content': 'Contenido de la revisión',
        'opt.fullLoad': 'Carga completa',
        'opt.fullLoad.desc': 'Cuando está activada, la profundidad 3 ya no filtra el contenido de herramientas: tanto la vista previa como la inyección real conservan ▸ / ◂ y los errores. Desactivada por defecto.',
        'opt.fullLoad.warn': 'Aviso: con esto activado, cada compactación se reinyecta entera y el contexto puede quedar más largo después de compactar que antes. Esta opción existe para continuar sin cortes en una sesión nueva; si tienes otra forma de importar sesiones, desactívala.',
        'opt.reminder': 'Recordatorio',
        'opt.reminder.systemDesc': 'En el sistema: se envía como sección del prompt del sistema (la forma desde 0.1.47). Desaparece en cuanto escribes el diario.',
        'opt.reminder.contextDesc': 'En el contexto (por defecto): se fusiona con el cuerpo de la revisión (la forma de 0.1.46); si varias revisiones no tienen diario, se listan una tras otra en un solo recordatorio.',
        'opt.reminder.context': 'En el contexto',
        'opt.reminder.system': 'En el sistema',
        'opt.group.depth': 'Profundidad de la revisión',
        'opt.stop': 'Dejar de bajar',
        'opt.stop.desc': 'Cuando está activada, cada revisión se queda en la profundidad registrada en su archivo de carga y no decae con los días. Desactivada por defecto.',
        'opt.loadLevel': 'Nivel de carga',
        'opt.loadLevel.off': '«Dejar de bajar» está activado: esta opción no se puede elegir y ha vuelto a «Seguir la profundidad».',
        'opt.loadLevel.desc': 'Solo cambia qué nivel se usa al cargar; nunca cambia la profundidad registrada.',
        'opt.loadLevel.now': function (n) { return ' Ahora todas las revisiones se cargan en el nivel ' + n + '.' },
        'opt.follow': 'Seguir la profundidad',
        'opt.l3': '3 · transcripción',
        'opt.l2': '2 · resumen',
        'opt.l1': '1 · diario',
        'opt.l0': '0 · palabras clave',
        'opt.note': 'Las opciones se aplican a todos los espacios de trabajo y surten efecto de inmediato: la inyección, la vista previa y las etiquetas de profundidad se recalculan.',
        'opt.group.tools': 'Herramientas selladas',
        'help.toolStore': 'Este grupo solo gobierna la sección «lista de herramientas» del prompt del sistema: si se inyecta y cuándo se recalcula. Es independiente de «Revisión automática» e «Inyección de revisiones».',
        'opt.tlRefresh': 'Cuándo se refresca la lista',
        'opt.tlRefresh.newSession': 'Antes de que empiece una sesión nueva',
        'opt.tlRefresh.realtime': 'En vivo dentro de la sesión',
        'opt.tlRefresh.newDesc': 'Por defecto. La lista se toma una vez, al ensamblar la sesión por primera vez, y queda fija hasta que esa sesión termina: instalar un toolScript a mitad de sesión no cambia el prompt del sistema y el siguiente turno sigue usando la caché. Para mostrar una herramienta nueva a una sesión en curso, abre una sesión nueva.',
        'opt.tlRefresh.realtimeDesc': 'La lista se recalcula en cada turno (el comportamiento hasta 0.4.4): el turno siguiente a instalar o quitar un toolScript usa el nuevo prompt del sistema, a costa de reenviar toda la conversación como entrada no cacheada una vez.',
        'tl.group': 'Lista de herramientas',
        'tl.inject': 'Inyectar la lista de herramientas',
        'tl.desc': 'Cuando está activada, la lista se añade al final del prompt del sistema: una línea por toolScript (id, propósito, entrada, argumentos). Es independiente de «Revisión automática» e «Inyección de revisiones» y tiene su propio interruptor. Activada por defecto.',
        'tl.offDesc': 'Desactivada: esta sección no se inyecta. El cuerpo de las revisiones y el recordatorio del diario no dependen de este interruptor: siguen «Revisión automática» e «Inyección de revisiones» en Opciones.',
        'tl.preview': 'Lo que se inyectaría',
        'tl.bytes': function (n) { return ' · ' + n + ' bytes' },
        'tl.empty': '(la lista aún no tiene toolScripts, así que esta sección está vacía; aparecerá al instalar el primero)',
        'tl.off': '(desactivada: no se inyecta nada; el cuadro de abajo muestra el texto de antes de desactivarla)',
        'tl.note': 'La vista previa usa la misma función que el ensamblador, así que es exactamente el texto que entraría en el prompt del sistema. Cuándo cambia de verdad:',
        'tl.note.newSession': 'ahora «Antes de que empiece una sesión nueva»: el cuadro de arriba es lo que recibirá la próxima sesión nueva; instalar o quitar toolScripts en esta sesión no cambia el prompt del sistema.',
        'tl.note.realtime': 'ahora «En vivo dentro de la sesión»: cambia en el turno siguiente a instalar o quitar un toolScript (un fallo de caché del prompt).',
        'tl.path': function (p) { return 'Ruta de herramientas: ' + p },
        'tl.export': 'Exportar',
        'tl.import': 'Importar',
        'tl.exported': function (file, files, size) { return 'Exportado a ' + file + ' (' + files + ' archivos, ' + size + ' bytes, compresión 0)' },
        'tl.overwritten': '; se sobrescribió el archivo con el mismo nombre',
        'tl.noWorkspace': 'No se puede saber a qué espacio de trabajo pertenece esta sesión; envía un mensaje y vuelve',
        'tl.importPreview': function (n, m) { return 'Se encontraron ' + n + ' toolScripts' + (m > 0 ? '; ' + m + ' sobrescriben los locales con el mismo id (la carpeta antigua queda como .bak-)' : ', ninguno choca con los locales') },
        'tl.importSkipLine': function (n) { return 'Otras ' + n + ' entradas no se toman (volcados de ejecución, carpetas de respaldo, rutas fuera de rango)' },
        'tl.importConfirm': 'Confirmar importación',
        'tl.importCancel': 'Cancelar',
        'tl.imported': function (n, k) { return 'Importados ' + n + ' toolScripts' + (k > 0 ? ' (' + k + ' sobrescritos)' : '') },
        'tl.importSkipped': function (n) { return '; se omitieron ' + n + ' entradas (volcados de ejecución, carpetas de respaldo y rutas fuera de rango no se toman)' },
        'tl.clearCache': 'Limpiar caché',
        'tl.clearCacheConfirm': 'Confirmar limpieza',
        'tl.clearCacheHint': 'Haz clic una vez más para borrar: se eliminarán todas las versiones de reversión .bak- y todos los registros de _runs. Los toolScripts y el índice se quedan.',
        'tl.cacheCleared': function (b, r, size) { return 'Se borraron ' + b + ' versiones de reversión y ' + r + ' registros de ejecución (' + size + ' en total)' },
        'tl.cacheEmpty': 'No hay versiones de reversión ni registros que borrar',
        'tl.cacheSkipped': function (n) { return '; hay una importación en curso, así que se omitieron ' + n + ' paquetes temporales' },
        'tl.cachePartial': function (n) { return '; no se pudieron borrar ' + n + ' elementos (en uso o sin permiso); el resto ya no está' },
        'help.aria': 'Ayuda',
        'help.toolList': 'Esta página lista los flujos de scripts que el modelo ya ha empaquetado con las herramientas de este plugin. Envía al modelo «convierte el flujo anterior en un toolScript» y llamará a session_tool_create_write para crearlo; entre sesiones, si existe una revisión, envía «convierte el flujo de la sesión anterior en un toolScript» y el modelo primero llamará a session_tool_create_read para leer ese archivo de revisión. Los toolScripts creados así se ejecutan con session_tool_call y la lista se inyecta en el prompt del sistema como sección de herramientas.',
        'help.injectGroup': 'Una revisión tiene cuatro profundidades, cada una carga algo distinto: nivel 3, la transcripción original; nivel 2, el resumen de la compactación; nivel 1, el resumen del propio modelo; nivel 0, solo palabras clave, como índice.\nLa profundidad baja al segundo día, al tercer día y del vigésimo octavo en adelante. Cuando señalas que el modelo recuerda algo mal, el propio modelo llama a session_mem_read para leer la transcripción de esa revisión y luego pondera y bloquea su contenido cargado. Una revisión vacía en nivel 1 o 0 es normal: el plugin inyecta un recordatorio para que el modelo llame a session_mem_write con un resumen y palabras clave. El cumplimiento difiere entre el canal de contexto y el del prompt del sistema, así que elige el que mejor te funcione.\nNo se recomienda activar «Carga completa»; para hitos importantes usa las ramas propias de DSH.',
        'opt.auto': 'Revisión automática',
        'opt.auto.desc': 'Cuando está activada, el comportamiento es el de siempre: se crea una revisión en cada compactación y se inyecta en el contexto y el prompt del sistema según las opciones de abajo. Al desactivarla, se detienen la creación y la inyección y todas las opciones de abajo quedan de solo lectura.',
        'opt.auto.off': 'La revisión está desactivada, así que no se crean ni se inyectan archivos de revisión. Si no tienes otro plugin de memoria ni un flujo de revisiones, actívala.'
      },
      fr: {
        'app.title': 'Gestion des outils (scripts)',
        'tab.sessions': 'Sessions',
        'tab.memory': 'Revues',
        'tab.toolList': 'Outils maison',
        'tab.options': 'Options',
        'loading': 'Chargement…',
        'loading.first': 'Chargement… (le premier passage parcourt les journaux de session)',
        'empty.sessions': 'Aucune session pour l’instant',
        'empty.memories': 'Cet espace de travail n’a pas encore de revue',
        'health.failedTitle': 'La dernière revue automatique a échoué',
        'health.failed': function (when, msg) { return 'La dernière revue automatique a échoué (' + when + ') : ' + msg },
        'host.degraded': function (blocks) { return 'L’hôte n’offre pas toutes les capacités ; les fonctions concernées sont désactivées : ' + blocks },
        'digest.noZstd': 'Cette version de Node n’a pas la décompression zstd : les titres et le nombre de sessions sont illisibles (les revues ne sont pas concernées)',
        'ws.archived': function (n) { return ' · ' + n + ' archivées' },
        'badge.archived': 'archivée',
        'ws.unknown': '(espace de travail actuel introuvable)',
        'box.none': '(aucune revue chargée pour le moment)',
        'box.noContent': '(cette revue n’a pas de contenu)',
        'box.err': function (msg) { return '(' + msg + ')' },
        'head.base': 'Revues chargées actuellement',
        'head.pick': function (id, chars, loading) {
          return ' · ' + id + ' seulement' + (loading ? ' · chargement…' : ' · ' + chars + ' caractères') + ' · cliquer pour tout afficher'
        },
        'head.all': function (n, chars, level) {
          return ' · ' + n + ' revues · ' + chars + ' caractères' + (typeof level === 'number' ? ' · profondeur de chargement ' + level : '')
        },
        'ws.count': function (cwd, n, ranged, inRange) {
          return cwd + ' · ' + n + ' revues' + (ranged ? ' · ' + inRange + ' dans la plage' : '')
        },
        'chip.depth': function (level, forced, pinned) {
          return 'profondeur ' + level + (forced ? ' · chargement forcé' : (pinned ? ' · verrouillée' : ''))
        },
        'range.empty': function (from, to) {
          return 'Aucune revue dans la plage choisie (' + from + (to !== from ? ' ~ ' + to : '') + ')'
        },
        'btn.delete': 'Supprimer',
        'btn.deleteCompact': 'Supprimer + revue',
        'btn.confirm': 'Confirmer la suppression ?',
        'btn.confirmCompact': 'Confirmer compression + suppression ?',
        'btn.memDelete': 'Supprimer cette revue',
        'note.saved': 'Enregistré',
        'note.memConfirm': 'Cliquez encore : cette revue sera supprimée définitivement',
        'note.memDeleted': function (f) { return 'Revue supprimée ' + f },
        'note.deleteConfirm': 'Cliquez encore pour confirmer la suppression (irréversible)',
        'note.deleted': 'Supprimé',
        'note.deletedLost': 'Supprimé (la réponse s’est perdue ; la liste confirme qu’elle a disparu)',
        'note.compactConfirm': 'Cliquez encore : l’historique est d’abord compressé, puis supprimé — les deux sont irréversibles',
        'note.compacted': function (m) { return 'Compressé puis supprimé ; revue ' + m },
        'err.request': function (p) { return 'Aucune réponse de ' + p },
        'cal.hint': 'Cliquez sur deux jours pour choisir une plage ; cliquez encore pour effacer',
        'cal.clear': 'Effacer',
        'cal.month': function (y, m) {
          return ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'][m] + ' ' + y
        },
        'cal.dow': ['D', 'L', 'M', 'M', 'J', 'V', 'S'],
        'switch.on': 'Activé',
        'switch.off': 'Désactivé',
        'box.injectOff': '(l’injection des revues est désactivée ; rien n’est injecté)',
        'opt.group.inject': 'Injection des revues',
        'opt.inject': 'Injection des revues',
        'opt.inject.desc': 'Quand c’est activé, les revues sont injectées dans le contexte et le rappel à l’emplacement choisi, selon les options ci-dessous. Activé par défaut.',
        'opt.inject.offDesc': 'Désactivé : toute injection s’arrête ; les quatre options ci-dessous sont grisées et gardent leurs valeurs enregistrées, sans effet jusqu’à la réactivation.',
        'opt.group.content': 'Contenu de la revue',
        'opt.fullLoad': 'Chargement complet',
        'opt.fullLoad.desc': 'Quand c’est activé, la profondeur 3 ne filtre plus le contenu des outils : l’aperçu et l’injection réelle gardent ▸ / ◂ et les erreurs. Désactivé par défaut.',
        'opt.fullLoad.warn': 'Attention : avec cette option, chaque compression est réinjectée en entier et le contexte peut devenir plus long après la compression qu’avant. Cette option sert à reprendre sans coupure dans une nouvelle session ; si vous avez un autre moyen d’importer des sessions, désactivez-la.',
        'opt.reminder': 'Rappel',
        'opt.reminder.systemDesc': 'Côté système : envoyé comme section du prompt système (la méthode depuis 0.1.47). Il disparaît dès que le journal est écrit.',
        'opt.reminder.contextDesc': 'Côté contexte (par défaut) : fusionné dans le corps de la revue (la méthode de 0.1.46) ; si plusieurs revues n’ont pas de journal, elles sont listées à la suite dans un seul rappel.',
        'opt.reminder.context': 'Côté contexte',
        'opt.reminder.system': 'Côté système',
        'opt.group.depth': 'Profondeur de la revue',
        'opt.stop': 'Arrêter la baisse',
        'opt.stop.desc': 'Quand c’est activé, chaque revue reste à la profondeur notée dans son fichier de chargement et ne baisse plus avec les jours. Désactivé par défaut.',
        'opt.loadLevel': 'Niveau de chargement',
        'opt.loadLevel.off': '« Arrêter la baisse » est activé : cette option est indisponible et est revenue à « Suivre la profondeur ».',
        'opt.loadLevel.desc': 'Change seulement le niveau utilisé au chargement ; ne change jamais la profondeur notée.',
        'opt.loadLevel.now': function (n) { return ' Toutes les revues sont maintenant chargées au niveau ' + n + '.' },
        'opt.follow': 'Suivre la profondeur',
        'opt.l3': '3 · transcription',
        'opt.l2': '2 · résumé',
        'opt.l1': '1 · journal',
        'opt.l0': '0 · mots-clés',
        'opt.note': 'Les options s’appliquent à tous les espaces de travail et prennent effet immédiatement : injection, aperçu et badges de profondeur sont recalculés.',
        'opt.group.tools': 'Outils scellés',
        'help.toolStore': 'Ce groupe ne gouverne que la section « liste d’outils » du prompt système : son injection et le moment de son recalcul. Il est indépendant de « Revue automatique » et de « Injection des revues ».',
        'opt.tlRefresh': 'Quand la liste est rafraîchie',
        'opt.tlRefresh.newSession': 'Avant le début d’une nouvelle session',
        'opt.tlRefresh.realtime': 'En direct dans la session',
        'opt.tlRefresh.newDesc': 'Par défaut. La liste est prise une fois, à la première composition de la session, puis figée jusqu’à la fin de cette session : installer un toolScript en cours de session ne change pas le prompt système et le tour suivant utilise encore le cache. Pour montrer un nouvel outil à une session en cours, ouvrez une nouvelle session.',
        'opt.tlRefresh.realtimeDesc': 'La liste est recalculée à chaque tour (le comportement jusqu’à 0.4.4) : le tour suivant l’installation ou la suppression d’un toolScript utilise le nouveau prompt système, au prix d’un renvoi complet de la conversation comme entrée non mise en cache.',
        'tl.group': 'Liste d’outils',
        'tl.inject': 'Injecter la liste d’outils',
        'tl.desc': 'Quand c’est activé, la liste d’outils est ajoutée à la fin du prompt système : une ligne par toolScript (id, but, entrée, arguments). Indépendant de « Revue automatique » et de « Injection des revues », avec son propre interrupteur. Activé par défaut.',
        'tl.offDesc': 'Désactivé : cette section n’est pas injectée. Le corps des revues et le rappel du journal ne dépendent pas de cet interrupteur — ils suivent « Revue automatique » et « Injection des revues » dans Options.',
        'tl.preview': 'Ce qui serait injecté',
        'tl.bytes': function (n) { return ' · ' + n + ' octets' },
        'tl.empty': '(la liste n’a pas encore de toolScript, cette section est donc vide ; elle apparaîtra dès le premier installé)',
        'tl.off': '(désactivé : rien n’est injecté ; l’encadré ci-dessous montre le texte d’avant la désactivation)',
        'tl.note': 'L’aperçu utilise la même fonction que l’assembleur : c’est exactement le texte qui entrerait dans le prompt système. Quand il change vraiment :',
        'tl.note.newSession': 'actuellement « Avant le début d’une nouvelle session » — l’encadré ci-dessus est ce que recevra la prochaine nouvelle session ; installer ou retirer des toolScripts dans cette session ne change pas le prompt système.',
        'tl.note.realtime': 'actuellement « En direct dans la session » — cela change au tour suivant l’installation ou la suppression d’un toolScript (un échec de cache du prompt).',
        'tl.path': function (p) { return 'Chemin des outils : ' + p },
        'tl.export': 'Exporter',
        'tl.import': 'Importer',
        'tl.exported': function (file, files, size) { return 'Exporté vers ' + file + ' (' + files + ' fichiers, ' + size + ' octets, compression 0)' },
        'tl.overwritten': ' ; le fichier du même nom a été écrasé',
        'tl.noWorkspace': 'Impossible de savoir à quel espace de travail appartient cette session ; envoyez un message puis revenez',
        'tl.importPreview': function (n, m) { return n + ' toolScripts trouvés' + (m > 0 ? ' ; ' + m + ' écrasent les locaux du même id (l’ancien dossier est gardé en .bak-)' : ', aucun conflit avec les locaux') },
        'tl.importSkipLine': function (n) { return n + ' autres entrées ne sont pas prises (déversements d’exécution, dossiers de sauvegarde, chemins hors limites)' },
        'tl.importConfirm': 'Confirmer l’import',
        'tl.importCancel': 'Annuler',
        'tl.imported': function (n, k) { return n + ' toolScripts importés' + (k > 0 ? ' (' + k + ' écrasés)' : '') },
        'tl.importSkipped': function (n) { return ' ; ' + n + ' entrées ignorées (déversements d’exécution, dossiers de sauvegarde et chemins hors limites ne sont pas pris)' },
        'tl.clearCache': 'Vider le cache',
        'tl.clearCacheConfirm': 'Confirmer le vidage',
        'tl.clearCacheHint': 'Cliquez encore une fois pour supprimer : toutes les versions de retour .bak- et tous les journaux d’exécution de _runs disparaîtront. Les toolScripts et l’index restent.',
        'tl.cacheCleared': function (b, r, size) { return 'Supprimé ' + b + ' version(s) de retour et ' + r + ' journal(aux) d’exécution (' + size + ' au total)' },
        'tl.cacheEmpty': 'Rien à supprimer — aucune version de retour ni journal d’exécution',
        'tl.cacheSkipped': function (n) { return ' ; un import est en cours, ' + n + ' paquet(s) temporaire(s) ont été ignorés' },
        'tl.cachePartial': function (n) { return ' ; ' + n + ' élément(s) n’ont pas pu être supprimés (utilisés ou sans permission), le reste est parti' },
        'help.aria': 'Aide',
        'help.toolList': 'Cette page liste les enchaînements de scripts que le modèle a déjà empaquetés avec les outils de ce plugin. Envoyez au modèle « transforme l’enchaînement ci-dessus en toolScript » : il appellera session_tool_create_write pour le créer ; entre sessions, si une revue existe, envoyez « transforme l’enchaînement de la session précédente en toolScript » et le modèle appellera d’abord session_tool_create_read pour lire ce fichier de revue. Les toolScripts ainsi obtenus s’exécutent avec session_tool_call, et la liste est injectée dans le prompt système comme section d’outils.',
        'help.injectGroup': 'Une revue a quatre profondeurs, chacune chargeant un contenu différent : niveau 3, la transcription d’origine ; niveau 2, le résumé de compaction ; niveau 1, le résumé du modèle lui-même ; niveau 0, les mots-clés seuls, comme index.\nLa profondeur baisse le deuxième jour, le troisième jour, puis à partir du vingt-huitième. Quand vous signalez un souvenir erroné, le modèle appelle lui-même session_mem_read pour relire la transcription de cette revue, puis pondère et verrouille son contenu chargé. Une revue vide en niveau 1 ou 0 est normale : le plugin injecte un rappel demandant au modèle d’appeler session_mem_write avec un résumé et des mots-clés. Le respect varie entre le canal contexte et le canal prompt système : choisissez celui qui vous convient.\nActiver « Chargement complet » n’est pas recommandé ; pour les étapes importantes, utilisez les branches natives de DSH.',
        'opt.auto': 'Revue automatique',
        'opt.auto.desc': 'Quand c’est activé, le comportement reste le même : une revue est créée à chaque compaction et injectée dans le contexte et le prompt système selon les options ci-dessous. Désactivé, la création et l’injection s’arrêtent et toutes les options ci-dessous deviennent en lecture seule.',
        'opt.auto.off': 'La revue est désactivée : les fichiers de revue ne sont ni créés ni injectés. Si vous n’avez pas d’autre plugin de mémoire ni d’enchaînement de revues, activez cette option.'
      },
      de: {
        'app.title': 'Werkzeug- (Skript-)Verwaltung',
        'tab.sessions': 'Sitzungen',
        'tab.memory': 'Reviews',
        'tab.toolList': 'Eigene Tools',
        'tab.options': 'Optionen',
        'loading': 'Wird geladen…',
        'loading.first': 'Wird geladen… (beim ersten Mal werden Sitzungsprotokolle durchsucht)',
        'empty.sessions': 'Noch keine Sitzungen',
        'empty.memories': 'Dieser Arbeitsbereich hat noch keine Reviews',
        'health.failedTitle': 'Die letzte automatische Review ist fehlgeschlagen',
        'health.failed': function (when, msg) { return 'Die letzte automatische Review ist fehlgeschlagen (' + when + '): ' + msg },
        'host.degraded': function (blocks) { return 'Der Host bietet nicht alle Fähigkeiten; betroffene Funktionen sind aus: ' + blocks },
        'digest.noZstd': 'Dieses Node hat keine zstd-Dekompression, daher lassen sich Sitzungstitel und -anzahl nicht lesen (die Reviews selbst sind nicht betroffen)',
        'ws.archived': function (n) { return ' · ' + n + ' archiviert' },
        'badge.archived': 'archiviert',
        'ws.unknown': '(aktueller Arbeitsbereich nicht gefunden)',
        'box.none': '(derzeit ist keine Review geladen)',
        'box.noContent': '(diese Review hat keinen Inhalt)',
        'box.err': function (msg) { return '(' + msg + ')' },
        'head.base': 'Derzeit geladene Reviews',
        'head.pick': function (id, chars, loading) {
          return ' · nur ' + id + (loading ? ' · wird geladen…' : ' · ' + chars + ' Zeichen') + ' · hier klicken für alles'
        },
        'head.all': function (n, chars, level) {
          return ' · ' + n + ' Reviews · ' + chars + ' Zeichen' + (typeof level === 'number' ? ' · Ladetiefe ' + level : '')
        },
        'ws.count': function (cwd, n, ranged, inRange) {
          return cwd + ' · ' + n + ' Reviews' + (ranged ? ' · ' + inRange + ' im Bereich' : '')
        },
        'chip.depth': function (level, forced, pinned) {
          return 'Tiefe ' + level + (forced ? ' · Ladung überschrieben' : (pinned ? ' · gesperrt' : ''))
        },
        'range.empty': function (from, to) {
          return 'Im gewählten Bereich gibt es keine Reviews (' + from + (to !== from ? ' ~ ' + to : '') + ')'
        },
        'btn.delete': 'Löschen',
        'btn.deleteCompact': 'Löschen + Review',
        'btn.confirm': 'Löschen bestätigen?',
        'btn.confirmCompact': 'Komprimieren und löschen bestätigen?',
        'btn.memDelete': 'Diese Review löschen',
        'note.saved': 'Gespeichert',
        'note.memConfirm': 'Noch einmal klicken: diese Review wird endgültig gelöscht',
        'note.memDeleted': function (f) { return 'Review gelöscht: ' + f },
        'note.deleteConfirm': 'Noch einmal klicken, um das Löschen zu bestätigen (nicht rückgängig zu machen)',
        'note.deleted': 'Gelöscht',
        'note.deletedLost': 'Gelöscht (die Antwort ging verloren; die Liste bestätigt, dass sie weg ist)',
        'note.compactConfirm': 'Noch einmal klicken: erst wird der Verlauf komprimiert, dann gelöscht — beides ist unumkehrbar',
        'note.compacted': function (m) { return 'Komprimiert und gelöscht; Review ' + m },
        'err.request': function (p) { return 'Keine Antwort von ' + p },
        'cal.hint': 'Zwei Tage anklicken, um einen Bereich zu wählen; erneut klicken zum Leeren',
        'cal.clear': 'Leeren',
        'cal.month': function (y, m) {
          return ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'][m] + ' ' + y
        },
        'cal.dow': ['S', 'M', 'D', 'M', 'D', 'F', 'S'],
        'switch.on': 'Ein',
        'switch.off': 'Aus',
        'box.injectOff': '(die Review-Injektion ist aus; es wird nichts injiziert)',
        'opt.group.inject': 'Review-Injektion',
        'opt.inject': 'Review-Injektion',
        'opt.inject.desc': 'Wenn ein, werden Reviews gemäß den Optionen unten in den Kontext injiziert und der Hinweis an die gewählte Stelle gesetzt. Standardmäßig ein.',
        'opt.inject.offDesc': 'Aus: jede Injektion stoppt; die vier Optionen unten werden ausgegraut und behalten ihre gespeicherten Werte, die erst nach dem Wiedereinschalten wirken.',
        'opt.group.content': 'Review-Inhalt',
        'opt.fullLoad': 'Vollständig laden',
        'opt.fullLoad.desc': 'Wenn ein, filtert Tiefe 3 den Tool-Inhalt nicht mehr: Vorschau und echte Injektion behalten ▸ / ◂ und Fehler. Standardmäßig aus.',
        'opt.fullLoad.warn': 'Warnung: damit wird jede Kompression vollständig erneut injiziert, und der Kontext kann nach der Kompression länger sein als davor. Diese Option existiert, damit eine neue Sitzung nahtlos weiterläuft; wenn du andere Wege hast, Sitzungen zu importieren, schalte sie aus.',
        'opt.reminder': 'Erinnerung',
        'opt.reminder.systemDesc': 'Systemseitig: als Abschnitt des System-Prompts gesendet (die Methode seit 0.1.47). Sie verschwindet, sobald das Tagebuch geschrieben ist.',
        'opt.reminder.contextDesc': 'Kontextseitig (Standard): in den Review-Text eingefügt (die Methode aus 0.1.46); fehlen bei mehreren Reviews die Tagebücher, werden sie in einer einzigen Erinnerung nacheinander aufgelistet.',
        'opt.reminder.context': 'Kontextseitig',
        'opt.reminder.system': 'Systemseitig',
        'opt.group.depth': 'Review-Tiefe',
        'opt.stop': 'Absenkung stoppen',
        'opt.stop.desc': 'Wenn ein, bleibt jede Review auf der in ihrer Ladungsdatei vermerkten Tiefe und sinkt nicht mehr mit den Tagen. Standardmäßig aus.',
        'opt.loadLevel': 'Ladetiefe',
        'opt.loadLevel.off': '„Absenkung stoppen“ ist ein: diese Option ist nicht wählbar und wurde auf „Tiefe folgen“ zurückgesetzt.',
        'opt.loadLevel.desc': 'Ändert nur, welche Stufe beim Laden verwendet wird; die vermerkte Tiefe bleibt unverändert.',
        'opt.loadLevel.now': function (n) { return ' Alle Reviews werden jetzt auf Stufe ' + n + ' geladen.' },
        'opt.follow': 'Tiefe folgen',
        'opt.l3': '3 · Original',
        'opt.l2': '2 · Zusammenfassung',
        'opt.l1': '1 · Tagebuch',
        'opt.l0': '0 · Stichwörter',
        'opt.note': 'Die Optionen gelten für alle Arbeitsbereiche und wirken sofort: Injektion, Vorschau und Tiefen-Badges werden neu berechnet.',
        'opt.group.tools': 'Versiegelte Tools',
        'help.toolStore': 'Diese Gruppe steuert nur den Abschnitt „Tool-Liste“ im System-Prompt: ob er injiziert wird und wann er neu berechnet wird. Sie ist unabhängig von „Automatische Review“ und „Review-Injektion“.',
        'opt.tlRefresh': 'Wann die Liste aktualisiert wird',
        'opt.tlRefresh.newSession': 'Bevor eine neue Sitzung beginnt',
        'opt.tlRefresh.realtime': 'Live innerhalb der Sitzung',
        'opt.tlRefresh.newDesc': 'Standard. Die Liste wird einmal beim ersten Zusammensetzen der Sitzung geholt und dann bis zum Sitzungsende eingefroren: ein toolScript mitten in der Sitzung zu installieren ändert den System-Prompt nicht, und der nächste Zug nutzt weiter den Cache. Um einer laufenden Sitzung ein neues Tool zu zeigen, öffne eine neue Sitzung.',
        'opt.tlRefresh.realtimeDesc': 'Die Liste wird in jedem Zug neu berechnet (das Verhalten bis 0.4.4): Der Zug nach dem Installieren oder Entfernen eines toolScript nutzt den neuen System-Prompt, dafür wird die ganze Unterhaltung einmal als ungecachte Eingabe neu gesendet.',
        'tl.group': 'Tool-Liste',
        'tl.inject': 'Tool-Liste injizieren',
        'tl.desc': 'Wenn ein, wird die Tool-Liste an das Ende des System-Prompts gehängt: eine Zeile je toolScript (id, Zweck, Einstieg, Argumente). Unabhängig von „Automatische Review“ und „Review-Injektion“, mit eigenem Schalter. Standardmäßig ein.',
        'tl.offDesc': 'Aus: dieser Abschnitt wird nicht injiziert. Review-Text und Tagebuch-Erinnerung hängen nicht an diesem Schalter — sie folgen „Automatische Review“ und „Review-Injektion“ in den Optionen.',
        'tl.preview': 'Was injiziert würde',
        'tl.bytes': function (n) { return ' · ' + n + ' Bytes' },
        'tl.empty': '(die Tool-Gruppe hat noch keine toolScripts, daher ist dieser Abschnitt leer; er erscheint mit dem ersten installierten)',
        'tl.off': '(aus: es wird nichts injiziert; das Feld unten zeigt den Text von vor dem Ausschalten)',
        'tl.note': 'Die Vorschau nutzt dieselbe Funktion wie der Assembler, ist also genau der Text, der in den System-Prompt käme. Wann er sich wirklich ändert:',
        'tl.note.newSession': 'derzeit „Bevor eine neue Sitzung beginnt“ — das Feld oben ist das, was die nächste neue Sitzung erhält; toolScripts in dieser Sitzung zu installieren oder zu entfernen ändert den System-Prompt nicht.',
        'tl.note.realtime': 'derzeit „Live innerhalb der Sitzung“ — es ändert sich im Zug nach dem Installieren oder Entfernen eines toolScript (ein Prompt-Cache-Fehlschlag).',
        'tl.path': function (p) { return 'Tool-Pfad: ' + p },
        'tl.export': 'Exportieren',
        'tl.import': 'Importieren',
        'tl.exported': function (file, files, size) { return 'Exportiert nach ' + file + ' (' + files + ' Dateien, ' + size + ' Bytes, Kompression 0)' },
        'tl.overwritten': '; die gleichnamige Datei wurde überschrieben',
        'tl.noWorkspace': 'Der Arbeitsbereich dieser Sitzung ist nicht ermittelbar; sende eine Nachricht und komm zurück',
        'tl.importPreview': function (n, m) { return n + ' toolScripts gefunden' + (m > 0 ? '; ' + m + ' überschreiben lokale mit gleicher id (der alte Ordner bleibt als .bak-)' : ', keines kollidiert mit lokalen') },
        'tl.importSkipLine': function (n) { return n + ' weitere Einträge werden nicht übernommen (Laufzeit-Ausgaben, Sicherungsordner, Pfade außerhalb)' },
        'tl.importConfirm': 'Import bestätigen',
        'tl.importCancel': 'Abbrechen',
        'tl.imported': function (n, k) { return n + ' toolScripts importiert' + (k > 0 ? ' (' + k + ' überschrieben)' : '') },
        'tl.importSkipped': function (n) { return '; ' + n + ' Einträge übersprungen (Laufzeit-Ausgaben, Sicherungsordner und Pfade außerhalb werden nicht übernommen)' },
        'tl.clearCache': 'Cache leeren',
        'tl.clearCacheConfirm': 'Leeren bestätigen',
        'tl.clearCacheHint': 'Noch einmal klicken zum Löschen: alle .bak--Rollback-Versionen und alle Laufzeit-Protokolle in _runs verschwinden. Die toolScripts und der Index bleiben.',
        'tl.cacheCleared': function (b, r, size) { return b + ' Rollback-Version(en) und ' + r + ' Laufzeit-Protokoll(e) gelöscht (' + size + ' gesamt)' },
        'tl.cacheEmpty': 'Nichts zu löschen — keine Rollback-Versionen und keine Laufzeit-Protokolle',
        'tl.cacheSkipped': function (n) { return '; ein Import läuft, ' + n + ' temporäre(s) Paket(e) wurden übersprungen' },
        'tl.cachePartial': function (n) { return '; ' + n + ' Element(e) konnten nicht gelöscht werden (in Benutzung oder keine Berechtigung), der Rest ist weg' },
        'help.aria': 'Hilfe',
        'help.toolList': 'Diese Seite listet die Skript-Abläufe, die das Modell bereits mit den Tools dieses Plugins gebündelt hat. Sende dem Modell „fasse den Ablauf oben als toolScript zusammen“ — es ruft dann session_tool_create_write auf; sitzungsübergreifend, wenn eine Review existiert, sende „fasse den Ablauf der vorigen Sitzung als toolScript zusammen“ und das Modell ruft zuerst session_tool_create_read auf, um diese Review-Datei zu lesen. So entstandene toolScripts laufen mit session_tool_call, und die Liste wird als Tool-Abschnitt in den System-Prompt injiziert.',
        'help.injectGroup': 'Eine Review hat vier Tiefen, die jeweils etwas anderes laden: Stufe 3 das ursprüngliche Transkript, Stufe 2 die Kompressions-Zusammenfassung, Stufe 1 die eigene Zusammenfassung des Modells, Stufe 0 nur Stichwörter als Index.\nDie Tiefe sinkt am zweiten Tag, am dritten Tag und ab dem achtundzwanzigsten. Wenn du dem Modell eine falsche Erinnerung nachweist, ruft es selbst session_mem_read auf, liest das Transkript dieser Review und gewichtet und sperrt danach den geladenen Inhalt. Eine leere Review auf Stufe 1 oder 0 ist normal: Das Plugin injiziert eine Erinnerung, damit das Modell session_mem_write mit Zusammenfassung und Stichwörtern aufruft. Die Befolgung unterscheidet sich zwischen Kontext- und System-Prompt-Kanal, wähle je nach Bedarf.\n„Vollständig laden“ ist nicht empfehlenswert; nutze für wichtige Punkte die Branches von DSH.',
        'opt.auto': 'Automatische Review',
        'opt.auto.desc': 'Wenn ein, bleibt das Verhalten wie bisher: Bei jeder Kompression wird eine Review angelegt und gemäß den Optionen unten in Kontext und System-Prompt injiziert. Wenn aus, stoppen Anlegen und Injizieren und alle Optionen unten werden schreibgeschützt.',
        'opt.auto.off': 'Die Review ist aus, es werden weder Review-Dateien angelegt noch injiziert. Wenn du kein anderes Speicher-Plugin oder keinen Review-Ablauf hast, schalte dies ein.'
      },
      ru: {
        'app.title': 'Управление инструментами (скриптами)',
        'tab.sessions': 'Сессии',
        'tab.memory': 'Обзоры',
        'tab.toolList': 'Свои инструменты',
        'tab.options': 'Параметры',
        'loading': 'Загрузка…',
        'loading.first': 'Загрузка… (в первый раз сканируются журналы сессий)',
        'empty.sessions': 'Сессий пока нет',
        'empty.memories': 'В этом рабочем пространстве ещё нет обзоров',
        'health.failedTitle': 'Последний автоматический обзор не удался',
        'health.failed': function (when, msg) { return 'Последний автоматический обзор не удался (' + when + '): ' + msg },
        'host.degraded': function (blocks) { return 'У хоста не хватает возможностей, связанные функции отключены: ' + blocks },
        'digest.noZstd': 'В этом Node нет распаковки zstd, поэтому заголовки и количество сессий не читаются (на сами обзоры это не влияет)',
        'ws.archived': function (n) { return ' · архивных: ' + n },
        'badge.archived': 'в архиве',
        'ws.unknown': '(текущее рабочее пространство не найдено)',
        'box.none': '(сейчас не загружено ни одного обзора)',
        'box.noContent': '(в этом обзоре нет содержимого)',
        'box.err': function (msg) { return '(' + msg + ')' },
        'head.base': 'Загруженные сейчас обзоры',
        'head.pick': function (id, chars, loading) {
          return ' · только ' + id + (loading ? ' · загрузка…' : ' · ' + chars + ' символов') + ' · нажмите, чтобы показать всё'
        },
        'head.all': function (n, chars, level) {
          return ' · ' + n + ' обзоров · ' + chars + ' символов' + (typeof level === 'number' ? ' · глубина загрузки ' + level : '')
        },
        'ws.count': function (cwd, n, ranged, inRange) {
          return cwd + ' · ' + n + ' обзоров' + (ranged ? ' · ' + inRange + ' в диапазоне' : '')
        },
        'chip.depth': function (level, forced, pinned) {
          return 'глубина ' + level + (forced ? ' · загрузка принудительно' : (pinned ? ' · закреплено' : ''))
        },
        'range.empty': function (from, to) {
          return 'В выбранном диапазоне обзоров нет (' + from + (to !== from ? ' ~ ' + to : '') + ')'
        },
        'btn.delete': 'Удалить',
        'btn.deleteCompact': 'Удалить + обзор',
        'btn.confirm': 'Подтвердить удаление?',
        'btn.confirmCompact': 'Подтвердить сжатие и удаление?',
        'btn.memDelete': 'Удалить этот обзор',
        'note.saved': 'Сохранено',
        'note.memConfirm': 'Нажмите ещё раз: этот обзор будет удалён навсегда',
        'note.memDeleted': function (f) { return 'Обзор удалён: ' + f },
        'note.deleteConfirm': 'Нажмите ещё раз, чтобы подтвердить удаление (необратимо)',
        'note.deleted': 'Удалено',
        'note.deletedLost': 'Удалено (ответ потерялся; список подтверждает, что его больше нет)',
        'note.compactConfirm': 'Нажмите ещё раз: сначала сжимается история, затем удаление — оба шага необратимы',
        'note.compacted': function (m) { return 'Сжато и удалено; обзор ' + m },
        'err.request': function (p) { return 'Нет ответа от ' + p },
        'cal.hint': 'Нажмите на два дня, чтобы выбрать диапазон; ещё раз — чтобы сбросить',
        'cal.clear': 'Сбросить',
        'cal.month': function (y, m) {
          return ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][m] + ' ' + y
        },
        'cal.dow': ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'],
        'switch.on': 'Вкл',
        'switch.off': 'Выкл',
        'box.injectOff': '(вставка обзоров выключена; ничего не вставляется)',
        'opt.group.inject': 'Вставка обзоров',
        'opt.inject': 'Вставка обзоров',
        'opt.inject.desc': 'Когда включено, обзоры вставляются в контекст, а напоминание — в выбранное место, согласно параметрам ниже. По умолчанию включено.',
        'opt.inject.offDesc': 'Выключено: любая вставка останавливается; четыре параметра ниже становятся серыми и сохраняют записанные значения, которые не действуют до повторного включения.',
        'opt.group.content': 'Содержимое обзора',
        'opt.fullLoad': 'Полная загрузка',
        'opt.fullLoad.desc': 'Когда включено, глубина 3 больше не отфильтровывает содержимое инструментов: и предпросмотр, и реальная вставка сохраняют ▸ / ◂ и ошибки. По умолчанию выключено.',
        'opt.fullLoad.warn': 'Внимание: при включении каждое сжатие вставляется целиком, и контекст после сжатия может стать длиннее, чем до него. Этот параметр нужен для бесшовного продолжения в новой сессии; если у вас есть другие способы переносить сессии, выключите его.',
        'opt.reminder': 'Напоминание',
        'opt.reminder.systemDesc': 'В системе: отправляется как раздел системного промпта (способ с 0.1.47). Исчезает, как только дневник написан.',
        'opt.reminder.contextDesc': 'В контексте (по умолчанию): вливается в текст обзора (способ 0.1.46); если у нескольких обзоров нет дневников, они перечисляются подряд в одном напоминании.',
        'opt.reminder.context': 'В контексте',
        'opt.reminder.system': 'В системе',
        'opt.group.depth': 'Глубина обзоров',
        'opt.stop': 'Остановить снижение',
        'opt.stop.desc': 'Когда включено, каждый обзор остаётся на глубине, записанной в его файле загрузки, и не снижается по дням. По умолчанию выключено.',
        'opt.loadLevel': 'Уровень загрузки',
        'opt.loadLevel.off': '«Остановить снижение» включено: этот параметр недоступен и возвращён к «Следовать глубине».',
        'opt.loadLevel.desc': 'Меняет только уровень, используемый при загрузке; записанную глубину не меняет.',
        'opt.loadLevel.now': function (n) { return ' Сейчас все обзоры загружаются на уровне ' + n + '.' },
        'opt.follow': 'Следовать глубине',
        'opt.l3': '3 · расшифровка',
        'opt.l2': '2 · итог',
        'opt.l1': '1 · дневник',
        'opt.l0': '0 · ключевые слова',
        'opt.note': 'Параметры действуют на все рабочие пространства и применяются сразу: вставка, предпросмотр и метки глубины пересчитываются.',
        'opt.group.tools': 'Закреплённые инструменты',
        'help.toolStore': 'Эта группа управляет только разделом «список инструментов» системного промпта: вставляется ли он и когда пересчитывается. Она не зависит от «Автоматического обзора» и «Вставки обзоров».',
        'opt.tlRefresh': 'Когда обновляется список',
        'opt.tlRefresh.newSession': 'Перед началом новой сессии',
        'opt.tlRefresh.realtime': 'В реальном времени в сессии',
        'opt.tlRefresh.newDesc': 'По умолчанию. Список берётся один раз при первой сборке сессии и затем замораживается до её конца: установка toolScript посреди сессии не меняет системный промпт, и следующий ход по-прежнему идёт из кэша. Чтобы показать новый инструмент текущей сессии, откройте новую сессию.',
        'opt.tlRefresh.realtimeDesc': 'Список пересчитывается на каждом ходу (поведение до 0.4.4): ход после установки или удаления toolScript использует новый системный промпт, но за это всю переписку один раз отправляют как некэшированный ввод.',
        'tl.group': 'Список инструментов',
        'tl.inject': 'Вставлять список инструментов',
        'tl.desc': 'Когда включено, список добавляется в конец системного промпта: по строке на toolScript (id, назначение, вход, аргументы). Не зависит от «Автоматического обзора» и «Вставки обзоров», имеет собственный переключатель. По умолчанию включено.',
        'tl.offDesc': 'Выключено: этот раздел не вставляется. Текст обзоров и напоминание о дневнике этим переключателем не управляются — они следуют «Автоматическому обзору» и «Вставке обзоров» в параметрах.',
        'tl.preview': 'Что будет вставлено',
        'tl.bytes': function (n) { return ' · ' + n + ' байт' },
        'tl.empty': '(в группе пока нет toolScript, поэтому раздел пуст; он появится после установки первого)',
        'tl.off': '(выключено: ничего не вставляется; поле ниже показывает текст до выключения)',
        'tl.note': 'Предпросмотр считает та же функция, что и сборщик, поэтому здесь ровно тот текст, который попадёт в системный промпт. Когда он действительно меняется:',
        'tl.note.newSession': 'сейчас «Перед началом новой сессии» — поле выше это то, что получит следующая новая сессия; установка или удаление toolScript в текущей сессии системный промпт не меняет.',
        'tl.note.realtime': 'сейчас «В реальном времени в сессии» — меняется на следующем ходу после установки или удаления toolScript (один промах кэша промпта).',
        'tl.path': function (p) { return 'Путь инструментов: ' + p },
        'tl.export': 'Экспорт',
        'tl.import': 'Импорт',
        'tl.exported': function (file, files, size) { return 'Экспортировано в ' + file + ' (' + files + ' файлов, ' + size + ' байт, сжатие 0)' },
        'tl.overwritten': '; файл с тем же именем перезаписан',
        'tl.noWorkspace': 'Не удаётся определить рабочее пространство текущей сессии; отправьте сообщение и вернитесь',
        'tl.importPreview': function (n, m) { return 'Найдено toolScript: ' + n + (m > 0 ? '; ' + m + ' перезапишут локальные с тем же id (старая папка останется как .bak-)' : ', ни один не конфликтует с локальными') },
        'tl.importSkipLine': function (n) { return 'Ещё ' + n + ' записей не берутся (выводы запусков, папки резервных копий, пути вне границ)' },
        'tl.importConfirm': 'Подтвердить импорт',
        'tl.importCancel': 'Отмена',
        'tl.imported': function (n, k) { return 'Импортировано toolScript: ' + n + (k > 0 ? ' (перезаписано ' + k + ')' : '') },
        'tl.importSkipped': function (n) { return '; пропущено ' + n + ' записей (выводы запусков, папки резервных копий и пути вне границ не берутся)' },
        'tl.clearCache': 'Очистить кэш',
        'tl.clearCacheConfirm': 'Подтвердить очистку',
        'tl.clearCacheHint': 'Нажмите ещё раз, чтобы удалить: все версии отката .bak- и все журналы запусков в _runs исчезнут. Сами toolScript и индекс остаются.',
        'tl.cacheCleared': function (b, r, size) { return 'Удалено версий отката: ' + b + ', журналов запусков: ' + r + ' (всего ' + size + ')' },
        'tl.cacheEmpty': 'Нечего удалять — нет ни версий отката, ни журналов запусков',
        'tl.cacheSkipped': function (n) { return '; идёт импорт, поэтому пропущено временных пакетов: ' + n },
        'tl.cachePartial': function (n) { return '; не удалось удалить ' + n + ' элементов (заняты или нет прав), остальное удалено' },
        'help.aria': 'Справка',
        'help.toolList': 'На этой странице перечислены цепочки скриптов, которые модель уже оформила инструментами этого плагина. Отправьте модели «оформи цепочку выше как toolScript» — она вызовет session_tool_create_write; между сессиями, если есть обзор, отправьте «оформи цепочку прошлой сессии как toolScript», и модель сначала вызовет session_tool_create_read, чтобы прочитать файл этого обзора. Так полученные toolScript запускаются через session_tool_call, а список вставляется в системный промпт как раздел инструментов.',
        'help.injectGroup': 'У обзора четыре глубины, каждая загружает своё: уровень 3 — исходная расшифровка; уровень 2 — итог сжатия; уровень 1 — собственный итог модели; уровень 0 — только ключевые слова как индекс.\nГлубина снижается на второй день, на третий и начиная с двадцать восьмого. Когда вы указываете модели на ошибку в памяти, она сама вызывает session_mem_read, читает расшифровку этого обзора, затем повышает вес и закрепляет загруженное содержимое. Пустой обзор на уровне 1 или 0 — это нормально: плагин вставляет напоминание, чтобы модель вызвала session_mem_write с итогом и ключевыми словами. Соблюдение различается для канала контекста и канала системного промпта, выбирайте по ситуации.\nВключать «Полную загрузку» не рекомендуется; для важных точек используйте ветвления самого DSH.',
        'opt.auto': 'Автоматический обзор',
        'opt.auto.desc': 'Когда включено, поведение прежнее: при каждом сжатии создаётся обзор и вставляется в контекст и системный промпт согласно параметрам ниже. Когда выключено, создание и вставка останавливаются, а все параметры ниже становятся только для чтения.',
        'opt.auto.off': 'Обзоры выключены, файлы обзоров не создаются и не вставляются. Если у вас нет другого плагина памяти или процесса обзоров, включите этот параметр.'
      },
      pt: {
        'app.title': 'Gerenciador de ferramentas (scripts)',
        'tab.sessions': 'Sessões',
        'tab.memory': 'Revisões',
        'tab.toolList': 'Ferramentas próprias',
        'tab.options': 'Opções',
        'loading': 'Carregando…',
        'loading.first': 'Carregando… (na primeira vez os registros de sessão são varridos)',
        'empty.sessions': 'Ainda não há sessões',
        'empty.memories': 'Este espaço de trabalho ainda não tem revisões',
        'health.failedTitle': 'A última revisão automática falhou',
        'health.failed': function (when, msg) { return 'A última revisão automática falhou (' + when + '): ' + msg },
        'host.degraded': function (blocks) { return 'O host não tem todas as capacidades; os recursos afetados foram desligados: ' + blocks },
        'digest.noZstd': 'Este Node não tem descompressão zstd, então títulos e contagens de sessão não podem ser lidos (as revisões não são afetadas)',
        'ws.archived': function (n) { return ' · ' + n + ' arquivadas' },
        'badge.archived': 'arquivada',
        'ws.unknown': '(espaço de trabalho atual não encontrado)',
        'box.none': '(nenhuma revisão carregada no momento)',
        'box.noContent': '(esta revisão não tem conteúdo)',
        'box.err': function (msg) { return '(' + msg + ')' },
        'head.base': 'Revisões carregadas agora',
        'head.pick': function (id, chars, loading) {
          return ' · apenas ' + id + (loading ? ' · carregando…' : ' · ' + chars + ' caracteres') + ' · clique para ver tudo'
        },
        'head.all': function (n, chars, level) {
          return ' · ' + n + ' revisões · ' + chars + ' caracteres' + (typeof level === 'number' ? ' · profundidade de carga ' + level : '')
        },
        'ws.count': function (cwd, n, ranged, inRange) {
          return cwd + ' · ' + n + ' revisões' + (ranged ? ' · ' + inRange + ' no intervalo' : '')
        },
        'chip.depth': function (level, forced, pinned) {
          return 'profundidade ' + level + (forced ? ' · carga forçada' : (pinned ? ' · travada' : ''))
        },
        'range.empty': function (from, to) {
          return 'Nenhuma revisão no intervalo escolhido (' + from + (to !== from ? ' ~ ' + to : '') + ')'
        },
        'btn.delete': 'Excluir',
        'btn.deleteCompact': 'Excluir + revisão',
        'btn.confirm': 'Confirmar exclusão?',
        'btn.confirmCompact': 'Confirmar compactar e excluir?',
        'btn.memDelete': 'Excluir esta revisão',
        'note.saved': 'Salvo',
        'note.memConfirm': 'Clique de novo: esta revisão será excluída permanentemente',
        'note.memDeleted': function (f) { return 'Revisão excluída ' + f },
        'note.deleteConfirm': 'Clique de novo para confirmar a exclusão (não dá para desfazer)',
        'note.deleted': 'Excluído',
        'note.deletedLost': 'Excluído (a resposta se perdeu; a lista confirma que sumiu)',
        'note.compactConfirm': 'Clique de novo: primeiro o histórico é compactado e depois excluído — nada disso pode ser desfeito',
        'note.compacted': function (m) { return 'Compactado e excluído; revisão ' + m },
        'err.request': function (p) { return 'Sem resposta de ' + p },
        'cal.hint': 'Clique em dois dias para escolher um intervalo; clique de novo para limpar',
        'cal.clear': 'Limpar',
        'cal.month': function (y, m) {
          return ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'][m] + ' de ' + y
        },
        'cal.dow': ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'],
        'switch.on': 'Ligado',
        'switch.off': 'Desligado',
        'box.injectOff': '(a injeção de revisões está desligada; nada é injetado)',
        'opt.group.inject': 'Injeção de revisões',
        'opt.inject': 'Injeção de revisões',
        'opt.inject.desc': 'Quando ligado, as revisões são injetadas no contexto e o lembrete no local escolhido, conforme as opções abaixo. Ligado por padrão.',
        'opt.inject.offDesc': 'Desligado: toda injeção para; as quatro opções abaixo ficam cinza e mantêm os valores salvos, sem efeito até ligar de novo.',
        'opt.group.content': 'Conteúdo da revisão',
        'opt.fullLoad': 'Carga completa',
        'opt.fullLoad.desc': 'Quando ligado, a profundidade 3 deixa de filtrar o conteúdo de ferramentas: a prévia e a injeção real mantêm ▸ / ◂ e os erros. Desligado por padrão.',
        'opt.fullLoad.warn': 'Aviso: com isto ligado, cada compactação é reinjetada inteira e o contexto pode ficar mais longo depois de compactar do que antes. Esta opção existe para continuar sem cortes em uma nova sessão; se você tem outra forma de importar sessões, desligue.',
        'opt.reminder': 'Lembrete',
        'opt.reminder.systemDesc': 'No sistema: enviado como seção do prompt do sistema (o modo desde 0.1.47). Desaparece assim que o diário é escrito.',
        'opt.reminder.contextDesc': 'No contexto (padrão): fundido ao corpo da revisão (o modo de 0.1.46); quando várias revisões não têm diário, elas são listadas em sequência em um único lembrete.',
        'opt.reminder.context': 'No contexto',
        'opt.reminder.system': 'No sistema',
        'opt.group.depth': 'Profundidade da revisão',
        'opt.stop': 'Parar de baixar',
        'opt.stop.desc': 'Quando ligado, cada revisão fica na profundidade registrada em seu arquivo de carga e não cai com os dias. Desligado por padrão.',
        'opt.loadLevel': 'Nível de carga',
        'opt.loadLevel.off': '“Parar de baixar” está ligado: esta opção não pode ser escolhida e voltou para “Seguir a profundidade”.',
        'opt.loadLevel.desc': 'Muda apenas qual nível é usado ao carregar; nunca muda a profundidade registrada.',
        'opt.loadLevel.now': function (n) { return ' Agora todas as revisões carregam no nível ' + n + '.' },
        'opt.follow': 'Seguir a profundidade',
        'opt.l3': '3 · transcrição',
        'opt.l2': '2 · resumo',
        'opt.l1': '1 · diário',
        'opt.l0': '0 · palavras-chave',
        'opt.note': 'As opções valem para todos os espaços de trabalho e têm efeito imediato: injeção, prévia e etiquetas de profundidade são recalculadas.',
        'opt.group.tools': 'Ferramentas seladas',
        'help.toolStore': 'Este grupo governa apenas a seção “lista de ferramentas” do prompt do sistema: se é injetada e quando é recalculada. É independente de “Revisão automática” e “Injeção de revisões”.',
        'opt.tlRefresh': 'Quando a lista é atualizada',
        'opt.tlRefresh.newSession': 'Antes de uma nova sessão começar',
        'opt.tlRefresh.realtime': 'Ao vivo dentro da sessão',
        'opt.tlRefresh.newDesc': 'Padrão. A lista é obtida uma vez, na primeira montagem da sessão, e então congelada até o fim dela: instalar um toolScript no meio da sessão não muda o prompt do sistema e o próximo turno ainda usa o cache. Para mostrar uma ferramenta nova a uma sessão em andamento, abra uma nova sessão.',
        'opt.tlRefresh.realtimeDesc': 'A lista é recalculada a cada turno (o comportamento até 0.4.4): o turno seguinte a instalar ou remover um toolScript usa o novo prompt do sistema, ao custo de reenviar a conversa inteira como entrada não cacheada uma vez.',
        'tl.group': 'Lista de ferramentas',
        'tl.inject': 'Injetar a lista de ferramentas',
        'tl.desc': 'Quando ligado, a lista é anexada ao fim do prompt do sistema: uma linha por toolScript (id, finalidade, entrada, argumentos). É independente de “Revisão automática” e “Injeção de revisões”, com interruptor próprio. Ligado por padrão.',
        'tl.offDesc': 'Desligado: esta seção não é injetada. O corpo das revisões e o lembrete do diário não dependem deste interruptor — seguem “Revisão automática” e “Injeção de revisões” nas Opções.',
        'tl.preview': 'O que seria injetado',
        'tl.bytes': function (n) { return ' · ' + n + ' bytes' },
        'tl.empty': '(a lista ainda não tem toolScripts, então esta seção está vazia; ela aparece quando o primeiro é instalado)',
        'tl.off': '(desligado: nada é injetado; a caixa abaixo mostra o texto de antes de desligar)',
        'tl.note': 'A prévia usa a mesma função do montador, então é exatamente o texto que entraria no prompt do sistema. Quando ele muda de fato:',
        'tl.note.newSession': 'agora “Antes de uma nova sessão começar” — a caixa acima é o que a próxima sessão nova vai receber; instalar ou remover toolScripts nesta sessão não muda o prompt do sistema.',
        'tl.note.realtime': 'agora “Ao vivo dentro da sessão” — muda no turno seguinte a instalar ou remover um toolScript (um erro de cache do prompt).',
        'tl.path': function (p) { return 'Caminho das ferramentas: ' + p },
        'tl.export': 'Exportar',
        'tl.import': 'Importar',
        'tl.exported': function (file, files, size) { return 'Exportado para ' + file + ' (' + files + ' arquivos, ' + size + ' bytes, compressão 0)' },
        'tl.overwritten': '; o arquivo de mesmo nome foi sobrescrito',
        'tl.noWorkspace': 'Não dá para saber a que espaço de trabalho esta sessão pertence; envie uma mensagem e volte',
        'tl.importPreview': function (n, m) { return n + ' toolScripts encontrados' + (m > 0 ? '; ' + m + ' sobrescrevem os locais de mesmo id (a pasta antiga fica como .bak-)' : ', nenhum conflita com os locais') },
        'tl.importSkipLine': function (n) { return 'Outras ' + n + ' entradas não são aceitas (saídas de execução, pastas de backup, caminhos fora do limite)' },
        'tl.importConfirm': 'Confirmar importação',
        'tl.importCancel': 'Cancelar',
        'tl.imported': function (n, k) { return n + ' toolScripts importados' + (k > 0 ? ' (' + k + ' sobrescritos)' : '') },
        'tl.importSkipped': function (n) { return '; ' + n + ' entradas ignoradas (saídas de execução, pastas de backup e caminhos fora do limite não são aceitos)' },
        'tl.clearCache': 'Limpar cache',
        'tl.clearCacheConfirm': 'Confirmar limpeza',
        'tl.clearCacheHint': 'Clique mais uma vez para excluir: todas as versões de reversão .bak- e todos os registros de execução em _runs somem. Os toolScripts e o índice ficam.',
        'tl.cacheCleared': function (b, r, size) { return 'Excluídas ' + b + ' versão(ões) de reversão e ' + r + ' registro(s) de execução (' + size + ' no total)' },
        'tl.cacheEmpty': 'Nada para limpar — sem versões de reversão nem registros de execução',
        'tl.cacheSkipped': function (n) { return '; há uma importação em andamento, então ' + n + ' pacote(s) temporário(s) foram ignorados' },
        'tl.cachePartial': function (n) { return '; ' + n + ' item(ns) não puderam ser excluídos (em uso ou sem permissão), o resto já foi' },
        'help.aria': 'Ajuda',
        'help.toolList': 'Esta página lista os fluxos de scripts que o modelo já empacotou com as ferramentas deste plugin. Envie ao modelo “transforme o fluxo acima em um toolScript” e ele chamará session_tool_create_write para criar; entre sessões, se houver uma revisão, envie “transforme o fluxo da sessão anterior em um toolScript” e o modelo primeiro chamará session_tool_create_read para ler esse arquivo de revisão. Os toolScripts assim obtidos rodam com session_tool_call, e a lista é injetada no prompt do sistema como seção de ferramentas.',
        'help.injectGroup': 'Uma revisão tem quatro profundidades, cada uma carregando algo diferente: nível 3, a transcrição original; nível 2, o resumo da compactação; nível 1, o resumo do próprio modelo; nível 0, apenas palavras-chave como índice.\nA profundidade cai no segundo dia, no terceiro dia e a partir do vigésimo oitavo. Quando você aponta que o modelo lembra algo errado, o próprio modelo chama session_mem_read para reler a transcrição dessa revisão e então pondera e trava o conteúdo carregado. Uma revisão vazia em nível 1 ou 0 é normal: o plugin injeta um lembrete para o modelo chamar session_mem_write com resumo e palavras-chave. O cumprimento difere entre o canal de contexto e o do prompt do sistema, escolha conforme o caso.\nAtivar “Carga completa” não é recomendado; para marcos importantes use as ramificações do próprio DSH.',
        'opt.auto': 'Revisão automática',
        'opt.auto.desc': 'Quando ligado, o comportamento é o de sempre: uma revisão é criada a cada compactação e injetada no contexto e no prompt do sistema conforme as opções abaixo. Quando desligado, criação e injeção param e todas as opções abaixo ficam somente leitura.',
        'opt.auto.off': 'A revisão está desligada, então arquivos de revisão não são criados nem injetados. Se você não tem outro plugin de memória nem um fluxo de revisões, ligue esta opção.'
      }
    }

    /**
     * 取一条界面文案。0.5.2：缺当前语言就回英文，再回中文，绝不留空。
     * （8 种语言的表都在上面；新语言漏一条时也不会露出裸 key。）
     */
    function tr(key) {
      var dict = TEXTS[LANG] || TEXTS.zh
      var value = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined
      if (value === undefined) value = Object.prototype.hasOwnProperty.call(TEXTS.en, key) ? TEXTS.en[key] : TEXTS.zh[key]
      if (typeof value === 'function') return value.apply(null, Array.prototype.slice.call(arguments, 1))
      return value === undefined ? key : value
    }

    // 右侧拖条：::-webkit-scrollbar 是伪元素，内联样式改不到，只能注入一段真 CSS。
    // 四个滚动容器共用 .recall-scroll 这个 class。
    var SCROLL_CSS = [
      '.recall-scroll { overflow-y: auto; overscroll-behavior: contain; }',
      '.recall-scroll::-webkit-scrollbar { width: 20px; height: 20px; }',
      '.recall-scroll::-webkit-scrollbar-button { display: none; width: 0; height: 0; }',
      '.recall-scroll::-webkit-scrollbar-track { background: transparent; }',
      '.recall-scroll::-webkit-scrollbar-thumb { background-color: rgba(0,0,0,.38); border-radius: 20px; border: 3px solid transparent; background-clip: content-box; min-height: 48px; }',
      '.recall-scroll::-webkit-scrollbar-thumb:active { background-color: rgba(0,0,0,.62); }',
      '.recall-scroll::-webkit-scrollbar-corner { background: transparent; }'
    ].join('')

    /** 只注入一次；没有 document 的环境直接跳过。 */
    function ensureScrollCss() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.getElementById('dsh-seal-scripts-css')) return
      var el = document.createElement('style')
      el.id = 'dsh-seal-scripts-css'
      el.textContent = SCROLL_CSS
      document.head.appendChild(el)
    }

    // 样式规矩（踩过的坑）：
    //   1. 不要用 JS 改 inline style，会和 React 的 style diff 打架；
    //   2. border 简写与 borderColor 不能混用 —— 撤销时 removeProperty 会回退到 currentColor（黑框）；
    //      所以归档左边条用一个独立的绝对定位子元素画虚线，完全不碰行的 border。
    var S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 },
      head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
      h1: { fontSize: 15, fontWeight: 600 },
      sub: { fontSize: 12, opacity: 0.6 },
      tabs: { display: 'flex', gap: 8, borderBottom: '1px solid #e5e5e5', paddingBottom: 8 },
      tab: { padding: '6px 14px', borderRadius: 8, border: '1px solid transparent', background: 'transparent', cursor: 'pointer', fontSize: 14, color: 'inherit', opacity: 0.62 },
      tabOn: { padding: '6px 14px', borderRadius: 8, border: '1px solid #e5e5e5', background: '#f6f6f6', cursor: 'pointer', fontSize: 14, color: 'inherit', opacity: 1, fontWeight: 600 },
      ws: { fontSize: 12, opacity: 0.6, margin: '12px 0 6px', fontFamily: 'ui-monospace, monospace' },
      list: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '42vh', overflowY: 'auto' },
      row: { position: 'relative', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 10, border: '1px solid #e5e5e5', cursor: 'pointer', fontSize: 13, background: 'transparent', color: 'inherit', textAlign: 'left', width: '100%', boxSizing: 'border-box', outline: 'none', boxShadow: 'none', WebkitTapHighlightColor: 'transparent', userSelect: 'none' },
      rowOn: { background: 'rgba(64,120,255,0.12)', border: '1px solid #4078ff' },
      leftBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 0, borderLeft: '1px dashed #9a9a9a', pointerEvents: 'none' },
      dot: { width: 9, height: 9, borderRadius: 999, border: '1px solid currentColor', flex: '0 0 auto', opacity: 0.4 },
      dotOn: { width: 9, height: 9, borderRadius: 999, background: '#4078ff', border: '1px solid #4078ff', flex: '0 0 auto' },
      title: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      muted: { opacity: 0.62 },
      badge: { fontSize: 10, padding: '1px 6px', borderRadius: 999, border: '1px dashed #9a9a9a', opacity: 0.8, flex: '0 0 auto' },
      footer: { display: 'flex', gap: 10, paddingTop: 12, borderTop: '1px solid #e5e5e5', marginTop: 12 },
      btn: { padding: '8px 16px', borderRadius: 9, border: '1px solid #e5e5e5', background: '#f6f6f6', cursor: 'pointer', fontSize: 13, color: 'inherit' },
      btnDanger: { padding: '8px 16px', borderRadius: 9, border: '1px solid #d9534f', background: 'transparent', color: '#d9534f', cursor: 'pointer', fontSize: 13 },
      btnOff: { padding: '8px 16px', borderRadius: 9, border: '1px solid #e5e5e5', background: 'transparent', color: 'inherit', opacity: 0.35, cursor: 'not-allowed', fontSize: 13 },
      note: { fontSize: 12, opacity: 0.6, minHeight: 18 },
      err: { fontSize: 12, color: '#d9534f', minHeight: 18 },
      chip: { fontSize: 11, padding: '1px 7px', borderRadius: 999, border: '1px solid #ddd', opacity: 0.85, flex: '0 0 auto' },
      // 锁定过的深度用实心蓝底，跟普通灰框一眼分得开（锁定意味着不再衰减）。
      chipLocked: { fontSize: 11, padding: '1px 7px', borderRadius: 999, border: '1px solid #4078ff', background: '#4078ff', color: '#fff', fontWeight: 600, flex: '0 0 auto' },
      // 「载入数值」强制某一级时：蓝框不填色，和锁定（实心）分得开。
      chipForced: { fontSize: 11, padding: '1px 7px', borderRadius: 999, border: '1px dashed #4078ff', color: '#4078ff', fontWeight: 600, flex: '0 0 auto' },
      cal: { border: '1px solid #e5e5e5', borderRadius: 10, padding: 10, marginTop: 10 },
      calHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
      calGrid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 },
      calDow: { fontSize: 10, opacity: 0.5, textAlign: 'center' },
      day: { textAlign: 'center', fontSize: 12, padding: '6px 0', borderRadius: 7, cursor: 'pointer', border: '1px solid transparent', color: 'inherit', background: 'transparent' },
      dayEmpty: { textAlign: 'center', fontSize: 12, padding: '6px 0', opacity: 0.15 },
      dayHas: { fontWeight: 600 },
      dayRange: { background: 'rgba(64,120,255,0.16)' },
      dayEdge: { background: '#4078ff', color: '#fff' },
      dayToday: { border: '1px solid #4078ff' },
      disc: { display: 'flex', alignItems: 'center' },
      discBtn: { width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid #e5e5e5', background: '#f6f6f6', cursor: 'pointer', fontSize: 13, color: 'inherit', textAlign: 'left', boxSizing: 'border-box', outline: 'none' },
      caret: { fontSize: 11, opacity: 0.6, width: 12, flex: '0 0 auto' },
      page: { maxHeight: '60vh', overflowY: 'auto', overscrollBehavior: 'contain' },
      // 选项页内容一屏装得下：不套 60vh 滚动框，右侧就不会多出一道拉条（0.2.1）。
      pageFlat: { minHeight: 0 },
      preWide: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.6, background: '#f8f8f8', border: '1px solid #e5e5e5', borderRadius: 10, padding: 12, maxHeight: '52vh', overflowY: 'auto', fontFamily: 'inherit' },
      // 选项页：一组一块，标签在左、开关/下拉在右。
      optGroup: { fontSize: 12, opacity: 0.6, paddingBottom: 6, borderBottom: '1px solid #ececec', marginTop: 6 },
      optRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, padding: '10px 0', borderBottom: '1px solid #f4f4f4' },
      optText: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      optLabel: { fontSize: 13, fontWeight: 600 },
      optDesc: { fontSize: 12, opacity: 0.62, lineHeight: 1.55 },
      // 全量加载开启后整段警示标红：不用 0.62 透明度，红字要压得住。
      optDescWarn: { fontSize: 12, lineHeight: 1.55, color: '#d9534f', fontWeight: 600 },
      // 「自创工具」页的预览框：等宽、可折行，自己的高度上限里滚，不撑破整页。
      expPre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.6, fontFamily: 'ui-monospace, monospace', background: '#f8f8f8', border: '1px solid #e5e5e5', borderRadius: 10, padding: 12, maxHeight: '38vh', overflowY: 'auto' },
      // 大类标题 + 问号（0.3.10）：问号贴着标题，气泡以它为锚点弹出来。
      // 标题本身 0.6 透明（S.groupTitle），外层不透明——否则气泡里的字也被压淡。
      groupHead: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', opacity: 1 },
      groupTitle: { opacity: 0.6, fontSize: 12 },
      helpWrap: { position: 'relative', display: 'inline-flex', alignItems: 'center', flex: '0 0 auto' },
      helpBtn: { width: 16, height: 16, padding: 0, lineHeight: '14px', borderRadius: 999, border: '1px solid #c9c9c9', background: 'transparent', color: 'inherit', fontSize: 11, cursor: 'pointer', opacity: 0.75, flex: '0 0 auto' },
      helpBtnOn: { width: 16, height: 16, padding: 0, lineHeight: '14px', borderRadius: 999, border: '1px solid #4078ff', background: 'transparent', color: '#4078ff', fontSize: 11, cursor: 'pointer', fontWeight: 600, flex: '0 0 auto' },
      // 气泡压在下面的行上面：绝对定位 + zIndex，不改任何父容器的定位与溢出。
      helpBubble: { position: 'absolute', top: '135%', left: 0, zIndex: 60, width: 400, maxWidth: '76vw', padding: '10px 12px', borderRadius: 10, border: '1px solid #d6d6d6', background: '#f8f8f8', color: 'inherit', boxShadow: '0 6px 20px rgba(0,0,0,.18)', fontSize: 12, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word', textAlign: 'left', fontWeight: 'normal', maxHeight: '46vh', overflowY: 'auto' },
      // 工具组目录那一行：等宽、可选中复制（路径要能被人直接拿去用）。
      pathLine: { fontSize: 12, fontFamily: 'ui-monospace, monospace', opacity: 0.72, wordBreak: 'break-all', margin: '2px 0 0', userSelect: 'text' },
      swOn: { flex: '0 0 auto', padding: '5px 12px', borderRadius: 999, border: '1px solid #4078ff', background: '#4078ff', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
      swOff: { flex: '0 0 auto', padding: '5px 12px', borderRadius: 999, border: '1px solid #c9c9c9', background: 'transparent', color: 'inherit', fontSize: 12, cursor: 'pointer', opacity: 0.7 },
      select: { flex: '0 0 auto', padding: '6px 8px', borderRadius: 8, border: '1px solid #e5e5e5', background: '#fff', color: 'inherit', fontSize: 12, maxWidth: 210 },
      selectOff: { flex: '0 0 auto', padding: '6px 8px', borderRadius: 8, border: '1px solid #e5e5e5', background: '#f4f4f4', color: 'inherit', fontSize: 12, maxWidth: 210, opacity: 0.42, cursor: 'not-allowed' },
      // 导入确认弹窗（0.4.3）：照 persona-select 的 ConfirmDialog —— 全屏遮罩 + 居中盒子 + Esc 取消。
      modalOverlay: { position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(0,0,0,0.42)' },
      modalBox: { maxWidth: 440, width: '100%', display: 'flex', flexDirection: 'column', gap: 14, padding: 16, borderRadius: 10, border: '1px solid rgba(127,127,127,0.35)', background: 'var(--dsw-alias-bg-elevated, Canvas)', color: 'inherit', boxShadow: '0 12px 40px rgba(0,0,0,0.35)' },
      modalBody: { margin: 0, fontSize: 13, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      btnPrimary: { padding: '8px 16px', borderRadius: 9, border: '1px solid #4078ff', background: '#4078ff', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
      btnGhost: { padding: '8px 16px', borderRadius: 9, border: '1px solid #e5e5e5', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13 }
    }

    function pad(n) { return String(n).padStart(2, '0') }

    /** 从文件名取短标识：20261028-171157-29e68643.md -> 29e68643 */
    function shortId(file) {
      var s = String(file === undefined || file === null ? '' : file).replace(/\.md$/, '')
      var parts = s.split('-')
      return parts.length > 1 ? parts[parts.length - 1] : s
    }
    function ym(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) }
    function ymd(d) { return ym(d) + '-' + pad(d.getDate()) }
    /** 失败心跳的时间：本地「月-日 时:分」，读不出就空着。 */
    function dayTime(ms) {
      var d = new Date(Number(ms) || 0)
      if (isNaN(d.getTime())) return ''
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    // 回顾页必须跟着「当前正在看的会话」走。以前它只认手选的工作区或
    // 「按目录名排第一的有回顾工作区」，所以在别的工作区打开设置，看到的
    // 还是原来那份回顾 —— 那就是这次报上来的 bug。
    var sessionsHolder = { service: null }

    /** 拿到会话服务（宿主没给 useSessions 时用它）。拿不到就一直是 null。 */
    function bindSessions(ctx) {
      try {
        var got = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        sessionsHolder.service = got || ctx.sessions || sessionsHolder.service
      } catch (e) { /* 老宿主没有 ctx.get，退回 props.useSessions */ }
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['sessions'], function (scoped) {
            sessionsHolder.service = (scoped && scoped.sessions) || sessionsHolder.service
          })
        }
      } catch (e) { /* 没有会话服务就只靠 props */ }
    }

    /** 从会话快照里取「主视图当前那条」的 id；取不到给空串。 */
    function currentSessionIdOf(state) {
      if (!state || typeof state !== 'object') return ''
      if (typeof state.current === 'string' && state.current !== '') return state.current
      var byId = state.byId
      if (!byId || typeof byId !== 'object') return ''
      for (var key in byId) {
        var row = byId[key]
        if (!row || typeof row !== 'object') continue
        var kept = row.retainedBy && typeof row.retainedBy.mainView === 'number' ? row.retainedBy.mainView : 0
        if (kept > 0) return typeof row.id === 'string' && row.id !== '' ? row.id : key
      }
      return ''
    }

    /** 订阅会话服务拿当前会话 id（宿主没给 useSessions 时的退路）。 */
    function useSessionStoreId() {
      var s = React.useState('')
      var setId = s[1]
      React.useEffect(function () {
        var store = sessionsHolder.service && sessionsHolder.service.list
        function read() {
          var snapshot = null
          try { snapshot = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null } catch (e) { snapshot = null }
          setId(currentSessionIdOf(snapshot))
        }
        read()
        if (!store || typeof store.subscribe !== 'function') return undefined
        return store.subscribe(read)
      }, [])
      return s[0]
    }

    async function post(path, body) {
      var res
      try {
        res = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      } catch (e) { throw new Error(tr('err.request', path)) }
      var json = await res.json().catch(function () { return {} })
      if (!res.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status))
      return json
    }

    /** 一行：点谁选谁。归档用左侧内阴影标记，不碰 border。 */
    function Row(props) {
      var style = Object.assign({}, S.row, props.archived ? S.rowArchived : {}, props.on ? S.rowOn : {})
      return h('div', {
        title: props.title || undefined,
        style: style,
        onClick: props.onClick,
        onMouseDown: function (e) { e.preventDefault() },
        onTouchStart: function (e) { if (e.cancelable) e.preventDefault() }
      }, props.archived ? h('span', { style: S.leftBar }) : null, props.children)
    }

    /** 月历：点两下选起止日，区间高亮。 */
    function Calendar(props) {
      var cursor = React.useState(props.initial || new Date())
      var at = cursor[0], setAt = cursor[1]
      var year = at.getFullYear(), month = at.getMonth()
      var firstDow = new Date(year, month, 1).getDay()
      var days = new Date(year, month + 1, 0).getDate()
      var cells = []
      for (var i = 0; i < firstDow; i++) cells.push(null)
      for (var d = 1; d <= days; d++) cells.push(d)
      var todayKey = ymd(new Date())

      function shift(n) { setAt(new Date(year, month + n, 1)) }

      return h('div', { style: S.cal },
        h('div', { style: S.calHead },
          h('button', { style: S.btn, onClick: function () { shift(-1) } }, '‹'),
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, tr('cal.month', year, month)),
          h('button', { style: S.btn, onClick: function () { shift(1) } }, '›')
        ),
        h('div', { style: S.calGrid },
          tr('cal.dow').map(function (w) { return h('div', { key: w, style: S.calDow }, w) }),
          cells.map(function (day, idx) {
            if (day === null) return h('div', { key: 'e' + idx, style: S.dayEmpty });
            var key = year + '-' + pad(month + 1) + '-' + pad(day)
            var has = props.dates && props.dates[key] === true
            var inRange = props.range && props.range.from && props.range.to && key >= props.range.from && key <= props.range.to
            var isEdge = props.range && (key === props.range.from || key === props.range.to)
            var style = Object.assign({}, S.day,
              has ? S.dayHas : {},
              inRange ? S.dayRange : {},
              isEdge ? S.dayEdge : {},
              key === todayKey ? S.dayToday : {});
            return h('button', { key: key, style: style, onClick: function () { props.onPick(key) } }, String(day));
          })
        ),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 } },
          h('span', { style: S.sub }, props.range && props.range.from
            ? (props.range.from === props.range.to ? props.range.from : props.range.from + ' ~ ' + props.range.to)
            : tr('cal.hint')),
          h('button', { style: S.btn, onClick: function () { props.onClear() } }, tr('cal.clear'))
        )
      )
    }

    /** 开关样子的按钮：开着实心蓝，关着灰框。 */
    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.on ? 'true' : 'false',
        style: props.on ? S.swOn : S.swOff,
        disabled: props.disabled === true,
        onClick: props.onClick
      }, props.on ? (props.onText || tr('switch.on')) : (props.offText || tr('switch.off')))
    }

    /** 选项页的一行：左边标签 + 说明，右边控件。 */
    function OptionRow(props) {
      return h('div', { style: S.optRow },
        h('div', { style: S.optText },
          h('div', { style: S.optLabel }, props.label),
          props.desc ? h('div', { style: props.descStyle || S.optDesc }, props.desc) : null
        ),
        props.control
      )
    }

    /**
     * 问号（0.3.10）：点一下在气泡里显示一段只读说明，再点一下、或点页面别处就收起。
     * 气泡是绝对定位的，不改父容器的定位与溢出；点气泡里面不会把它顺手关掉。
     */
    function HelpDot(props) {
      var st = React.useState(false)
      var open = st[0], setOpen = st[1]
      var box = React.useRef(null)
      React.useEffect(function () {
        if (!open) return undefined
        var doc = typeof document !== 'undefined' ? document : null
        if (!doc || typeof doc.addEventListener !== 'function') return undefined
        function away(e) {
          var node = box.current
          if (node && typeof node.contains === 'function' && e && e.target && node.contains(e.target)) return
          setOpen(false)
        }
        doc.addEventListener('click', away)
        return function () { doc.removeEventListener('click', away) }
      }, [open])
      return h('span', { ref: box, style: S.helpWrap },
        h('button', {
          type: 'button',
          'aria-label': tr('help.aria'),
          'aria-expanded': open ? 'true' : 'false',
          title: tr('help.aria'),
          style: open ? S.helpBtnOn : S.helpBtn,
          onClick: function () { setOpen(!open) },
          onMouseDown: function (e) { e.preventDefault() }
        }, '?'),
        open ? h('div', { role: 'note', style: S.helpBubble }, props.text) : null
      )
    }

    /** 下拉：options 是 [值, 文字] 的数组，值统一按字符串传。 */
    function Select(props) {
      return h('select', {
        style: props.disabled ? S.selectOff : S.select,
        value: String(props.value),
        disabled: props.disabled === true,
        onChange: function (e) { props.onChange(e.target.value) }
      }, (props.options || []).map(function (pair) {
        return h('option', { key: pair[0], value: pair[0] }, pair[1])
      }))
    }

    function Section(props) {
      var hasHost = props !== null && props !== undefined && typeof props.useSessions === 'function'
      return hasHost ? h(SectionHost, props) : h(SectionFallback)
    }

    // 两个变体各自是独立组件类型，钩子顺序才不会在两种宿主之间跳变。
    function SectionHost(props) {
      var id = props.useSessions(currentSessionIdOf)
      return h(SectionImpl, { currentSessionId: typeof id === 'string' ? id : '' })
    }

    function SectionFallback() {
      return h(SectionImpl, { currentSessionId: useSessionStoreId() })
    }

    function SectionImpl(props) {
      useLangTick()
      // 每次渲染现读一次语言：设置页在语言切换后重新挂载时，这里就能拿到新值。
      syncLangFromService()
      var currentSessionId = typeof props.currentSessionId === 'string' ? props.currentSessionId : ''
      var s = React.useState({ loading: true, error: '', workspaces: [] })
      var data = s[0], setData = s[1]
      var t = React.useState('toolList')
      var tab = t[0], setTab = t[1]
      var sel = React.useState(null)
      var selected = sel[0], setSelected = sel[1]
      var rng = React.useState(null)
      var range = rng[0], setRange = rng[1]
      // 回执（0.5.1）：带上它属于哪个标签。以前是一条全页共享的字符串，而那一行
      // 渲染在标签内容区外面，所以在「选项」页存完设置、切到别的页也能看见「已保存」。
      var nt = React.useState(null); var note = nt[0], setNote = nt[1]
      var err = React.useState(''); var setErr = err[1]
      var ldi = React.useState(null); var loadInfo = ldi[0], setLoadInfo = ldi[1]
      var op = React.useState(false); var open = op[0], setOpen = op[1]
      var mp = React.useState(null); var memPick = mp[0], setMemPick = mp[1]
      var mc = React.useState(''); var memConfirm = mc[0], setMemConfirm = mc[1]
      var busy = React.useState(false); var isBusy = busy[0], setBusy = busy[1]
      var confirm = React.useState(''); var confirming = confirm[0], setConfirming = confirm[1]
      // 已经请求过上下文的工作区。用它当守卫，不依赖服务器回传的 cwd，避免来回重试。
      var ctxCwd = React.useRef('')
      // 选中某一条时它单独那份渲染；没选时载入框用整段（loadInfo）。
      var pk = React.useState(null); var pickInfo = pk[0], setPickInfo = pk[1]
      // 连点两条时，晚到的旧响应不能盖掉新的。
      var pickSeq = React.useRef(0)
      // 选项（「选项」标签）。/state 一起带回来；拿不到就单独 GET 一次。
      var so = React.useState(null); var options = so[0], setOptions = so[1]
      // 「自创工具」标签那一段的原文（/api/session-seal-scripts.toolSequence 现算的）。
      var tk = React.useState(null); var toolSequence = tk[0], setToolList = tk[1]
      // 「导入 / 导出」（0.4.3）：选中的那个包、预演结果（还没写盘）、隐藏的文件选择框。
      var impFile = React.useState(null); var importFile = impFile[0], setImportFile = impFile[1]
      var impPlan = React.useState(null); var importPlan = impPlan[0], setImportPlan = impPlan[1]
      // 导入 / 导出的回执（0.4.4）：只属于「自创工具」页，渲染在那一页里。
      // 以前它写进全页共享的 note——那条行在标签内容区外面，切到别的页也会一直挂着。
      var impNote = React.useState(''); var importNote = impNote[0], setImportNote = impNote[1]
      // 「清除缓存」（0.5.1）：第一下只是举刀（按钮变红、旁边说明），第二下才真删。
      var cca = React.useState(false); var clearArmed = cca[0], setClearArmed = cca[1]
      var ccn = React.useState(''); var cacheNote = ccn[0], setCacheNote = ccn[1]
      var fileInput = React.useRef(null)

      var load = React.useCallback(async function () {
        try {
          var res = await fetch(API + 'state')
          var json = await res.json()
          if (!res.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status))
          setData({ loading: false, error: '', workspaces: json.workspaces || [], capabilities: json.capabilities || null })
          if (json.options) setOptions(json.options)
          return json
        } catch (e) {
          setData({ loading: false, error: String(e.message || e), workspaces: [] })
          return null
        }
      }, [])

      React.useEffect(function () { load() }, [])

      // 切标签就把上一页的回执和「举刀」状态收掉：它们只属于生成它们的那一页（0.5.1）。
      React.useEffect(function () { setNote(null); setClearArmed(false) }, [tab])

      var selectedWorkspace = selected
        ? data.workspaces.filter(function (w) { return w.cwd === selected.cwd })[0]
        : null

      // 当前会话落在哪个工作区：拿会话 id 去 /state 里反查。反查不到才算「不知道」。
      var currentWorkspace = null
      if (currentSessionId !== '') {
        for (var wi = 0; wi < data.workspaces.length; wi++) {
          var wsj = data.workspaces[wi]
          if ((wsj.sessions || []).some(function (x) { return x.id === currentSessionId })) { currentWorkspace = wsj; break }
        }
      }

      // 回顾页看哪个工作区：手选的 > 当前会话所在的 > （不知道当前会话时）第一个有回顾的。
      var wsForMem = selectedWorkspace || currentWorkspace ||
        data.workspaces.filter(function (w) { return w.memories.length > 0 })[0] || null
      var memCwd = wsForMem ? wsForMem.cwd : ''

      /** 写一条本页回执：记下当前标签。切页时由下面的 effect 清掉。 */
      function showNote(text) { setNote({ tab: tab, text: text }) }

      // 换会话就把上一轮的选择清掉，否则会拿着旧工作区的选中项继续显示。
      React.useEffect(function () {
        setSelected(null); setMemPick(null); setRange(null); setConfirming(''); setNote(null)
      }, [currentSessionId])

      // 换工作区时清掉这条回顾的选择与日期区间。
      React.useEffect(function () {
        setMemPick(null); setRange(null); setConfirming('')
      }, [memCwd])

      React.useEffect(function () {
        if (tab !== 'memory' || data.loading || data.error || memCwd === '') return
        if (ctxCwd.current === memCwd) return
        ctxCwd.current = memCwd
        loadContext(memCwd)
      }, [tab, data, memCwd])

      // 选中某条回顾：只取这一条会被注入成什么，框里跟着换。
      React.useEffect(function () {
        if (tab !== 'memory' || memCwd === '' || !memPick) { setPickInfo(null); return }
        loadPick(memCwd, memPick)
      }, [tab, memCwd, memPick])

      // 进「选项」标签时还没有选项（老宿主不往 /state 里带），单独取一次。
      React.useEffect(function () {
        if (tab !== 'options' || options !== null) return
        loadOptions()
      }, [tab, options])

      // 进「自创工具」标签：取一次要注入的原文（和装配同一个函数算出来的）。
      React.useEffect(function () {
        if (tab !== 'toolList') return
        loadToolList()
      }, [tab])

      async function loadOptions() {
        try {
          var res = await fetch(API + 'options')
          var json = await res.json()
          if (!res.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status))
          if (json.options) setOptions(json.options)
        } catch (e) { setErr(String(e.message || e)) }
      }

      async function loadToolList() {
        try {
          var res = await fetch(API + 'toolSequence')
          var json = await res.json()
          if (!res.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status))
          setToolList({ enabled: json.enabled !== false, path: json.path || '', text: json.text || '', bytes: json.bytes || 0 })
        } catch (e) { setErr(String(e.message || e)) }
      }

      /**
       * 0.4.11：导入不再把文件读成 base64 再塞进 JSON，直接把 File 当请求体发过去。
       * 服务端流式落盘再逐条解包，包多大都不吃内存。
       */
      function importUrl(name, dryRun) {
        return API + 'toolSequence/import?name=' + encodeURIComponent(name || 'toolSequence.zip') +
          (dryRun ? '&dryRun=1' : '')
      }

      /** 点「导入」：先把隐藏的 file 选择框清空再点，选同一个文件也要能触发。 */
      function pickImportFile() {
        if (isBusy) return
        setErr(''); setImportNote(''); setImportPlan(null); setImportFile(null)
        var el = fileInput.current
        if (el) { el.value = ''; el.click() }
      }

      /** 选好文件先走一遍 dryRun：只报会装什么，不写盘。确认之后才真装。 */
      async function onImportChosen(ev) {
        var file = ev && ev.target && ev.target.files && ev.target.files[0]
        if (!file) return
        setBusy(true); setErr(''); setImportNote(''); setImportPlan(null); setImportFile(null)
        try {
          var res = await fetch(importUrl(file.name, true), {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
            body: file
          })
          var json = await res.json()
          if (!res.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status))
          setImportFile({ name: file.name, file: file })
          setImportPlan({ imported: json.imported || [], overwritten: json.overwritten || [], skipped: json.skipped || [] })
        } catch (e) {
          setErr(String(e.message || e))
        } finally { setBusy(false) }
      }

      /** 确认导入：同一个包再发一次，这次 dryRun 为假。 */
      async function confirmImport() {
        if (isBusy || !importFile) return
        setBusy(true); setErr(''); setImportNote('')
        try {
          var res = await fetch(importUrl(importFile.name, false), {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
            body: importFile.file
          })
          var json = await res.json()
          if (!res.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status))
          var n = (json.imported || []).length
          var k = (json.overwritten || []).length
          var missed = (json.skipped || []).length
          setImportNote(tr('tl.imported', n, k) + (missed > 0 ? tr('tl.importSkipped', missed) : ''))
          setImportFile(null); setImportPlan(null)
          await loadToolList()
          await load()
        } catch (e) {
          setErr(String(e.message || e))
        } finally { setBusy(false) }
      }

      /**
       * 导出：让宿主把 toolSequence.zip 直接写进当前会话所在的工作区文件夹。
       * 落点由宿主算（它拿得到真实路径），界面只负责把它念出来。
       */
      async function doExport() {
        if (isBusy) return
        var outDir = currentWorkspace && currentWorkspace.cwd
          ? currentWorkspace.cwd
          : ((data.workspaces && data.workspaces[0] && data.workspaces[0].cwd) ? data.workspaces[0].cwd : '')
        if (outDir === '') { setErr(tr('tl.noWorkspace')); return }
        setBusy(true); setErr(''); setImportNote('')
        try {
          var res = await fetch(API + 'toolSequence/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cwd: outDir })
          })
          var json = await res.json()
          if (!res.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status))
          setImportNote(tr('tl.exported', json.file || '', json.files || 0, json.size || 0) +
            (json.overwritten ? tr('tl.overwritten') : ''))
        } catch (e) {
          setErr(String(e.message || e))
        } finally { setBusy(false) }
      }

      /** 字节数说人话：清缓存回执里用。 */
      function fmtBytes(n) {
        var v = Number(n) || 0
        if (v < 1024) return v + ' B'
        if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
        return (v / (1024 * 1024)).toFixed(1) + ' MB'
      }

      /**
       * 清除缓存（0.5.1）：删掉工具的回滚版本（<id>.bak-*）和 _runs/ 里的运行日志。
       * 两下才动手：第一下只把按钮换成「确认清除」并写明会删什么。
       */
      async function doClearCache() {
        if (isBusy) return
        if (!clearArmed) { setClearArmed(true); setCacheNote(''); setImportNote(''); return }
        setClearArmed(false)
        setBusy(true); setErr(''); setImportNote(''); setCacheNote('')
        try {
          var res = await fetch(API + 'toolSequence/clear-cache', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          })
          var json = await res.json()
          if (!res.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status))
          var nb = (json.backups && json.backups.count) || 0
          var nr = (json.runs && json.runs.files) || 0
          var size = (json.total && json.total.bytes) || 0
          var skipped = (json.runs && json.runs.skipped) ? json.runs.skipped.length : 0
          var failed = (json.failed || []).length
          var text = (nb + nr) === 0 ? tr('tl.cacheEmpty') : tr('tl.cacheCleared', nb, nr, fmtBytes(size))
          if (skipped > 0) text += tr('tl.cacheSkipped', skipped)
          if (failed > 0) text += tr('tl.cachePartial', failed)
          setCacheNote(text)
          await loadToolList()
        } catch (e) { setErr(String(e.message || e)) }
        finally { setBusy(false) }
      }

      /** 关掉导入弹窗：包和预演结果一起作废，不写盘。 */
      function closeImportDialog() {
        if (isBusy) return
        setImportFile(null); setImportPlan(null)
      }

      // Esc 关弹窗：和 persona-select 的 ConfirmDialog 一样只认 Esc，不劫持遮罩点击。
      React.useEffect(function () {
        if (importPlan === null) return undefined
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        function onKey(e) { if (e && e.key === 'Escape') closeImportDialog() }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [importPlan, isBusy])

      /**
       * 导入确认弹窗（0.4.3）：结构照 persona-select 的 ConfirmDialog ——
       * 固定遮罩 + 居中盒子 + role=dialog/aria-modal + 右下主次两个键。
       */
      function importDialogView() {
        if (importPlan === null) return null
        var missed = (importPlan.skipped || []).length
        return h('div', { style: S.modalOverlay, 'data-import-dialog': '1' },
          h('div', { style: S.modalBox, role: 'dialog', 'aria-modal': 'true' },
            h('p', { style: S.modalBody }, tr('tl.importPreview', importPlan.imported.length, importPlan.overwritten.length)),
            missed > 0 ? h('p', { style: S.modalBody }, tr('tl.importSkipLine', missed)) : null,
            h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' } },
              h('button', {
                type: 'button',
                style: isBusy ? S.btnOff : S.btnPrimary,
                disabled: isBusy,
                'data-confirm-action': 'primary',
                onClick: confirmImport
              }, tr('tl.importConfirm')),
              h('button', {
                type: 'button',
                style: isBusy ? S.btnOff : S.btnGhost,
                disabled: isBusy,
                'data-confirm-action': 'cancel',
                onClick: closeImportDialog
              }, tr('tl.importCancel'))
            )
          )
        )
      }

      /**
       * 改一个或多个选项。落盘后把回顾页的预览与深度徽章全部作废重取：
       * 选项只改载入时的装配，不改载入文件里记下的深度，所以重取就能看到新内容。
       */
      async function patchOptions(patch) {
        if (isBusy) return
        setBusy(true); setErr(''); setNote(null)
        try {
          var res = await post('options', patch)
          if (res.options) setOptions(res.options)
          showNote(tr('note.saved'))
          // 让两个 effect 重新取：载入框、单条预览、工作区级别都按新选项重算。
          ctxCwd.current = ''
          setLoadInfo(null)
          setPickInfo(null)
          await load()
          if (tab === 'toolList') await loadToolList()
        } catch (e) { setErr(String(e.message || e)) }
        finally { setBusy(false) }
      }

      async function doMemDelete() {
        if (!memPick) return
        if (memConfirm !== 'mem') { setMemConfirm('mem'); showNote(tr('note.memConfirm')); return }
        var cwd = loadInfo ? loadInfo.cwd : null
        if (!cwd) return
        setBusy(true); setErr(''); setNote(null)
        try {
          await post('memory-delete', { cwd: cwd, file: memPick })
          showNote(tr('note.memDeleted', memPick))
          setMemPick(null); setMemConfirm('')
          await load()
          await loadContext(cwd)
        } catch (e) { setErr(String(e.message || e)) }
        finally { setBusy(false) }
      }

      async function loadContext(cwd) {
        if (!cwd) return
        ctxCwd.current = cwd
        try {
          var res = await post('memory-context', { cwd: cwd })
          setLoadInfo(Object.assign({}, res, { cwd: cwd }))
        } catch (e) { setErr(String(e.message || e)) }
      }

      /** 只取一条回顾的渲染文本；连点时只有最后一次的响应算数。 */
      async function loadPick(cwd, file) {
        var my = ++pickSeq.current
        var key = cwd + '\u0000' + file
        try {
          var res = await post('memory-context', { cwd: cwd, file: file })
          if (my !== pickSeq.current) return
          setPickInfo({ key: key, text: res.text || '', chars: res.chars || 0, error: res.error || null })
        } catch (e) {
          if (my !== pickSeq.current) return
          setErr(String(e.message || e))
        }
      }

      /** 点日历：没有起点 -> 设起点；有起点没终点 -> 设终点；都有 -> 重新开始。 */
      function pickDay(key) {
        // 选完区间就把列表摊开，否则列表收着，看不出区间生效了。
        setOpen(true)
        if (range === null || range.from === null) { setRange({ from: key, to: key }); return }
        if (range.from === range.to) {
          if (key < range.from) setRange({ from: key, to: range.from })
          else setRange({ from: range.from, to: key })
          return
        }
        setRange({ from: key, to: key })
      }

      async function doDelete() {
        if (!selected) return
        if (confirming !== 'delete') { setConfirming('delete'); showNote(tr('note.deleteConfirm')); return }
        setBusy(true); setErr(''); setNote(null); setConfirming('')
        var target = selected.id
        try {
          await post('delete', { sessionId: target })
          showNote(tr('note.deleted')); setSelected(null)
          await load()
        } catch (e) {
          var fresh = await load()
          var alive = fresh !== null && (fresh.workspaces || []).some(function (w) {
            return (w.sessions || []).some(function (x) { return x.id === target })
          })
          if (fresh !== null && !alive) { showNote(tr('note.deletedLost')); setSelected(null) }
          else setErr(String(e.message || e))
        } finally { setBusy(false) }
      }

      async function doCompactDelete() {
        if (!selected) return
        if (confirming !== 'compact') { setConfirming('compact'); showNote(tr('note.compactConfirm')); return }
        setBusy(true); setErr(''); setNote(null); setConfirming('')
        var target = selected.id
        try {
          var res = await post('compact-delete', { sessionId: target })
          showNote(tr('note.compacted', res.memory)); setSelected(null)
          await load()
        } catch (e) {
          var fresh2 = await load()
          var alive2 = fresh2 !== null && (fresh2.workspaces || []).some(function (w) {
            return (w.sessions || []).some(function (x) { return x.id === target })
          })
          if (fresh2 !== null && !alive2) { showNote(tr('note.deletedLost')); setSelected(null) }
          else setErr(String(e.message || e))
        } finally { setBusy(false) }
      }

      /**
       * 「选项」标签：0.2.8 起「回顾注入」是一组，开头先是总开关，再是原来的两组。
       * 0.3.11：同一组开头先放「自动回顾」总闸，再放「回顾注入」（0.3.10 误放在组标题上面）。
       * 总闸或总开关关掉时，下面不可改的部分整片变灰——已经存的值一个都不动（服务端也不动它们）。
       * 停止降低开启时载入数值禁用（服务端也会把它收回「跟随深度载入」），
       * 客户端只是把这件事显示出来，不自己决定怎么存。
       */
      /**
       * 「自创工具」标签（0.3.1）：只管工具组清单（A 段）。
       * 拆出来的理由：「不想让回顾铺满上下文」和「不想把自己的手收走」是两件事。
       * 0.4.5：「注入工具组清单」这个开关连同新的「清单词刷新时刻」一起挪到「选项」页的
       * 「工具固存」大类；这一页只留路径、预览、导入导出，并写明开关去哪了。
       */
      function toolListView() {
        if (options === null) return h('div', { style: S.note }, tr('loading'))
        var on = options.toolListEnabled !== false
        var refreshMode = options.toolListRefresh === 'realtime' ? 'realtime' : 'newSession'
        var preview = toolSequence === null ? tr('loading') : (toolSequence.text || tr('tl.empty'))
        // 工具路径（0.3.10）：/toolSequence 现算回来的工具组目录，就是 session_tool_call 取脚本的地方。
        var pathText = toolSequence !== null && toolSequence.path ? tr('tl.path', toolSequence.path) : ''
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('div', { style: Object.assign({}, S.optGroup, S.groupHead) },
              h('span', { style: S.groupTitle }, tr('tl.group')),
              h(HelpDot, { text: tr('help.toolList') })
            ),
            pathText ? h('div', { style: S.pathLine }, pathText) : null
          ),
          h('div', { style: S.optGroup },
            tr('tl.preview') + (toolSequence !== null && toolSequence.bytes ? tr('tl.bytes', toolSequence.bytes) : '') +
            (on ? '' : ' ' + tr('tl.off'))),
          h('pre', { className: 'recall-scroll', style: S.expPre }, preview),
          h('div', { style: S.note }, tr('tl.note')),
          h('div', { style: S.note, 'data-tl-refresh': refreshMode },
            refreshMode === 'realtime' ? tr('tl.note.realtime') : tr('tl.note.newSession')),
          importNote ? h('div', { style: S.note, 'data-import-note': '1' }, importNote) : null,
          h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', paddingTop: 12, borderTop: '1px solid #ececec' } },
            h('button', { style: isBusy ? S.btnOff : S.btn, disabled: isBusy, onClick: pickImportFile }, tr('tl.import')),
            h('button', { style: isBusy ? S.btnOff : S.btn, disabled: isBusy, onClick: doExport }, tr('tl.export')),
            // 0.5.1：清除缓存放在这一行最右边（规则：新的放在末尾）。
            h('button', {
              style: isBusy ? S.btnOff : (clearArmed ? S.btnDanger : S.btn),
              disabled: isBusy,
              'data-clear-cache': '1',
              onClick: doClearCache
            }, clearArmed ? tr('tl.clearCacheConfirm') : tr('tl.clearCache'))
          ),
          clearArmed ? h('div', { style: S.note, 'data-clear-cache-hint': '1' }, tr('tl.clearCacheHint')) : null,
          cacheNote ? h('div', { style: S.note, 'data-clear-cache-note': '1' }, cacheNote) : null,
          h('input', {
            type: 'file',
            accept: '.zip,application/zip',
            style: { display: 'none' },
            ref: fileInput,
            onChange: onImportChosen
          }),
          importDialogView()
        )
      }

      function optionsView() {
        if (options === null) return h('div', { style: S.note }, tr('loading'))
        var o = options
        // 0.3.10：「自动回顾」是总闸。关着时服务端返回的 injectEnabled 已经是 false，
        // 下面整片变灰不可改；再打开时，原来存的那些值一个都没动过。
        var autoOn = o.autoReviewEnabled === true
        var injectOn = autoOn && o.injectEnabled !== false
        var locked = !injectOn
        // 0.4.5：「工具固存」这一组不跟「自动回顾」「回顾注入」连带，自己看自己的开关。
        var tlOn = o.toolListEnabled !== false
        var refresh = o.toolListRefresh === 'realtime' ? 'realtime' : 'newSession'
        var levelOptions = [
          ['follow', tr('opt.follow')],
          ['3', tr('opt.l3')],
          ['2', tr('opt.l2')],
          ['1', tr('opt.l1')],
          ['0', tr('opt.l0')]
        ]
        var levelNow = o.loadLevel === 'follow' ? 'follow' : String(o.loadLevel)
        // 0.3.11：总闸关着时，连「回顾注入」这一行也要跟着变灰（它已经点不动了）；
        // 只关注入时，这一行保持清楚，只有它下面那四行——0.2.8 的样子。
        var dimStyle = { display: 'flex', flexDirection: 'column', gap: 14, opacity: 0.42 }
        var plainStyle = { display: 'flex', flexDirection: 'column', gap: 14 }
        var tailDim = autoOn ? plainStyle : dimStyle
        var belowDim = locked && autoOn ? dimStyle : plainStyle
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          // 0.4.5：「工具固存」独立一类，排在「回顾注入」之前。它只管工具组清单那一段，
          // 不受「自动回顾」总闸与「回顾注入」开关连带——那两项管的是回顾正文与日记提醒。
          h('div', { style: Object.assign({}, S.optGroup, S.groupHead) },
            h('span', { style: S.groupTitle }, tr('opt.group.tools')),
            h(HelpDot, { text: tr('help.toolStore') })
          ),
          h(OptionRow, {
            label: tr('tl.inject'),
            desc: tlOn ? tr('tl.desc') : tr('tl.offDesc'),
            descStyle: tlOn ? null : S.optDescWarn,
            control: h(Switch, {
              on: tlOn,
              onClick: function () { patchOptions({ toolListEnabled: !tlOn }) }
            })
          }),
          h(OptionRow, {
            label: tr('opt.tlRefresh'),
            desc: refresh === 'realtime' ? tr('opt.tlRefresh.realtimeDesc') : tr('opt.tlRefresh.newDesc'),
            control: h(Select, {
              value: refresh,
              options: [['newSession', tr('opt.tlRefresh.newSession')], ['realtime', tr('opt.tlRefresh.realtime')]],
              disabled: !tlOn,
              onChange: function (v) { patchOptions({ toolListRefresh: v === 'realtime' ? 'realtime' : 'newSession' }) }
            })
          }),
          // 「自动回顾」在「回顾注入」这一类里面，排在「回顾注入」这一项之前（0.3.11）。
          h('div', { style: Object.assign({}, S.optGroup, S.groupHead) },
            h('span', { style: S.groupTitle }, tr('opt.group.inject')),
            h(HelpDot, { text: tr('help.injectGroup') })
          ),
          h(OptionRow, {
            label: tr('opt.auto'),
            desc: autoOn ? tr('opt.auto.desc') : tr('opt.auto.off'),
            descStyle: autoOn ? null : S.optDescWarn,
            control: h(Switch, {
              on: autoOn,
              onClick: function () { patchOptions({ autoReviewEnabled: !autoOn }) }
            })
          }),
          h('div', { style: tailDim },
            h(OptionRow, {
              label: tr('opt.inject'),
              desc: injectOn ? tr('opt.inject.desc') : tr('opt.inject.offDesc'),
              descStyle: injectOn ? null : S.optDescWarn,
              control: h(Switch, {
                on: injectOn,
                disabled: !autoOn,
                onClick: function () { patchOptions({ injectEnabled: !injectOn }) }
              })
            }),
            h('div', { style: belowDim },
            h('div', { style: S.optGroup }, tr('opt.group.content')),
            h(OptionRow, {
              label: tr('opt.fullLoad'),
              desc: o.fullLoad ? tr('opt.fullLoad.warn') : tr('opt.fullLoad.desc'),
              descStyle: o.fullLoad ? S.optDescWarn : null,
              control: h(Switch, {
                on: o.fullLoad,
                disabled: locked,
                onClick: function () { patchOptions({ fullLoad: !o.fullLoad }) }
              })
            }),
            h(OptionRow, {
              label: tr('opt.reminder'),
              desc: o.reminderChannel === 'system'
                ? tr('opt.reminder.systemDesc')
                : tr('opt.reminder.contextDesc'),
              control: h(Select, {
                value: o.reminderChannel,
                options: [['context', tr('opt.reminder.context')], ['system', tr('opt.reminder.system')]],
                disabled: locked,
                onChange: function (v) { patchOptions({ reminderChannel: v }) }
              })
            }),
            h('div', { style: S.optGroup }, tr('opt.group.depth')),
            h(OptionRow, {
              label: tr('opt.stop'),
              desc: tr('opt.stop.desc'),
              control: h(Switch, {
                on: o.stopLowering,
                disabled: locked,
                onClick: function () { patchOptions({ stopLowering: !o.stopLowering }) }
              })
            }),
            h(OptionRow, {
              label: tr('opt.loadLevel'),
              desc: (o.stopLowering
                ? tr('opt.loadLevel.off')
                : tr('opt.loadLevel.desc'))
                + (levelNow === 'follow' ? '' : tr('opt.loadLevel.now', levelNow)),
              control: h(Select, {
                value: levelNow,
                options: levelOptions,
                disabled: locked || o.stopLowering,
                onChange: function (v) { patchOptions({ loadLevel: v === 'follow' ? 'follow' : Number(v) }) }
              })
            })
            ) // 「回顾内容」「回顾深度」两组（belowDim）
          ), // 「回顾注入」这一类：自动回顾 + 回顾注入 + 下面两组
          h('div', { style: S.note }, tr('opt.note'))
        )
      }

      var head = h('div', { style: S.head },
        h('div', { style: S.h1 }, tr('app.title'))
      )

      // 0.3.10：「自创工具」提到第一个位置，打开设置页先落这一页。
      var tabs = h('div', { style: S.tabs },
        h('button', { style: tab === 'toolList' ? S.tabOn : S.tab, onClick: function () { setTab('toolList') } }, tr('tab.toolList')),
        h('button', { style: tab === 'sessions' ? S.tabOn : S.tab, onClick: function () { setTab('sessions') } }, tr('tab.sessions')),
        h('button', { style: tab === 'memory' ? S.tabOn : S.tab, onClick: function () { setTab('memory') } }, tr('tab.memory')),
        h('button', { style: tab === 'options' ? S.tabOn : S.tab, onClick: function () { setTab('options') } }, tr('tab.options'))
      )

      var body = null
      if (data.loading) body = h('div', { style: S.note }, tr('loading.first'))
      else if (data.error) body = h('div', { style: S.err }, data.error)
      else if (tab === 'toolList') body = toolListView()
      else if (tab === 'options') body = optionsView()
      else if (data.workspaces.length === 0) body = h('div', { style: S.note }, tr('empty.sessions'))
      else if (tab === 'sessions') {
        // E3：有会话读不出标题时，列表顶部明说原因；别让「空会话」冒充结论。
        var noZstd = false
        for (var nz = 0; nz < data.workspaces.length; nz++) {
          if (data.workspaces[nz].sessions.some(function (x) { return x.digestCode === 'no-zstd' })) { noZstd = true; break }
        }
        body = h('div', null,
          noZstd ? h('div', { style: S.note }, tr('digest.noZstd')) : null,
          data.workspaces.map(function (ws) {
          if (ws.sessions.length === 0) return null
          var ac = ws.sessions.filter(function (x) { return x.archived }).length
          return h('div', { key: ws.cwd },
            h('div', { style: S.ws }, ws.cwd + (ac > 0 ? tr('ws.archived', ac) : '')),
            h('div', { className: 'recall-scroll', style: S.list }, ws.sessions.map(function (sess) {
              var on = selected && selected.id === sess.id
              return h(Row, {
                key: sess.id, title: sess.id, on: on, archived: sess.archived,
                onClick: function () { setSelected({ id: sess.id, cwd: ws.cwd }); setConfirming(''); setNote(null) }
              },
                h('span', { style: on ? S.dotOn : S.dot }),
                h('span', { style: Object.assign({}, S.title, sess.hasTitle ? {} : S.muted) }, sess.title),
                sess.archived ? h('span', { style: S.badge }, tr('badge.archived')) : null
              )
            }))
          )
        }))
      } else {
        if (!wsForMem || wsForMem.memories.length === 0) {
          body = h('div', null,
            h('div', { style: S.ws }, memCwd !== '' ? memCwd : tr('ws.unknown')),
            h('div', { style: S.note }, tr('empty.memories'))
          )
        } else {
          // 日历高亮和列表显示都用本地日期：compactedAt 是 UTC，直接切前 10 位在
          // 北京时间会差一天（00:55 压的记在昨天那一格）。
          var dayOf = function (m) { return ymd(new Date(m.compactedAt)) }
          var dates = {}
          wsForMem.memories.forEach(function (m) { dates[dayOf(m)] = true })
          var info = loadInfo && loadInfo.cwd === wsForMem.cwd ? loadInfo : null
          // 选区生效时，列表只留区间内的条目（按同一个本地日期比较）。
          var ranged = range !== null && range.from !== null && range.from !== undefined
          var shown = info === null ? [] : info.entries.filter(function (e) {
            if (!ranged) return true
            var d = dayOf(e)
            return d >= range.from && d <= range.to
          })
          // 载入框两种状态：没选回顾看整段注入；选了只看那一条（跟注入同一套 renderEntry）。
          // 注入总开关关掉时框里明说「没有注入」，不拿旧文本冒充（0.2.8）。
          var pickKey = wsForMem.cwd + '\u0000' + (memPick || '')
          var picked = memPick && pickInfo && pickInfo.key === pickKey ? pickInfo : null
          var boxText = ''
          if (!memPick) {
            boxText = info ? (info.disabled ? tr('box.injectOff') : (info.text || tr('box.none'))) : ''
          } else if (picked) {
            boxText = picked.disabled ? tr('box.injectOff')
              : (picked.error ? tr('box.err', picked.error) : (picked.text || tr('box.noContent')))
          }
          var headText = tr('head.base')
          if (memPick) headText += tr('head.pick', shortId(memPick), picked ? picked.chars : 0, !picked)
          else if (info) headText += tr('head.all', info.entries.length, info.chars,
            info.loadForced && info.entries.length > 0 ? info.entries[0].level : null)
          body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            h('div', { style: S.ws }, tr('ws.count', wsForMem.cwd, wsForMem.memories.length, ranged, shown.length)),
            h(Calendar, {
              dates: dates,
              range: range,
              initial: new Date(wsForMem.memories[0].compactedAt),
              onPick: pickDay,
              onClear: function () { setRange(null) }
            }),
            h('div', { style: S.disc },
              h('button', {
                style: S.discBtn,
                onClick: function () {
                  // 选中了某条时，点列表头先回到「全部」，不收起 —— 收起就看不到内容了。
                  if (memPick) { setMemPick(null); setMemConfirm(''); setNote(null); if (!open) setOpen(true); return }
                  setOpen(!open)
                }
              },
                h('span', { style: S.caret }, open ? '▾' : '▸'),
                h('span', { style: { flex: 1, textAlign: 'left' } }, headText)
              )
            ),
            open
              ? (info === null
                ? h('div', { style: S.note }, tr('loading'))
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                      shown.map(function (e) {
                        var picked = memPick === e.file
                        return h(Row, {
                          key: e.file, title: e.file, on: picked,
                          onClick: function () { setMemPick(e.file); setMemConfirm(''); setNote(null) }
                        },
                          h('span', { style: picked ? S.dotOn : S.dot }),
                          h('span', { style: { fontSize: 12, opacity: 0.72, flex: '0 0 auto' } }, ymd(new Date(e.compactedAt))),
                          h('span', { style: e.loadForced ? S.chipForced : (e.pinned ? S.chipLocked : S.chip) },
                            tr('chip.depth', e.level, e.loadForced, e.pinned)),
                          h('span', { style: Object.assign({}, S.title, S.muted) }, shortId(e.file))
                        )
                      })
                    ),
                    ranged && shown.length === 0
                      ? h('div', { style: S.note }, tr('range.empty', range.from, range.to))
                      : null,
                    h('div', { className: 'recall-scroll', style: S.preWide }, memPick && !picked ? tr('loading') : boxText),
                    h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
                      h('button', {
                        style: !memPick || isBusy ? S.btnOff : S.btnDanger,
                        disabled: !memPick || isBusy,
                        onClick: doMemDelete
                      }, memConfirm ? tr('btn.confirm') : tr('btn.memDelete'))
                    )
                  ))
              : null
          )
        }
      }

      // 上次自动回顾失败（F6）：回顾页顶部一行红字。
      // 以前失败只落日志，用户看到的是「一份看起来完全正常、只是不再增长的列表」。
      if (tab === 'memory' && wsForMem && wsForMem.health && wsForMem.health.ok === false) {
        body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { style: S.err }, tr('health.failed', dayTime(wsForMem.health.at), wsForMem.health.message || tr('health.failedTitle'))),
          body)
      }

      var footer = tab === 'sessions' ? h('div', { style: S.footer },
        h('button', { style: !selected || isBusy ? S.btnOff : S.btnDanger, disabled: !selected || isBusy, onClick: doDelete },
          confirming === 'delete' ? tr('btn.confirm') : tr('btn.delete')),
        h('button', { style: !selected || isBusy ? S.btnOff : S.btn, disabled: !selected || isBusy, onClick: doCompactDelete },
          confirming === 'compact' ? tr('btn.confirmCompact') : tr('btn.deleteCompact'))
      ) : null

      // 会话、回顾两页内容可能很长，仍走 .recall-scroll；选项页只四行，不要滚动框。
      // 0.4.3：自创工具页多了导入/导出一块，整页不再保证一屏装得下，跟着一起滚。
      var pageBox = tab === 'options'
        ? h('div', { style: S.pageFlat }, body)
        : h('div', { className: 'recall-scroll', style: S.page }, body)

      // E1：宿主能力不全时，在每页顶部都说清缺了什么、哪块被关了。
      var missingCaps = data.capabilities && data.capabilities.ok === false
        && Array.isArray(data.capabilities.missing) ? data.capabilities.missing : []
      var capWarn = missingCaps.length > 0
        ? h('div', { style: S.err }, tr('host.degraded', missingCaps.map(function (m) { return m.block }).join(', ')))
        : null

      return h('div', { style: S.wrap },
        head, tabs, capWarn, pageBox, footer,
        note && note.tab === tab ? h('div', { style: S.note }, note.text) : null,
        err[0] ? h('div', { style: S.err }, err[0]) : null
      )
    }

    // 'locale' 必须写进依赖：DSH 按依赖注入服务，只有声明了才会把 ctx.locale 交给插件。
    var inject = ['slots', 'locale']

    function apply(ctx) {
      ensureScrollCss()
      bindSessions(ctx)
      watchLocale(ctx)
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: NS,
          order: 32,
          // 导航里的名字：每次投影现读，切语言后跟着变。
          label: function () { syncLangFromService(); return tr('app.title') }
        }, Section)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})

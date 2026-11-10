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

    function normalizeLangId(id) {
      var s = String(id === undefined || id === null ? '' : id).trim().toLowerCase()
      return s === 'en' || s.indexOf('en-') === 0 || s.indexOf('en_') === 0 ? 'en' : 'zh'
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
        'help.aria': 'Help',
        'help.toolList': 'This page lists the script workflows the model has already wrapped up with this plugin’s tools. Send the model “turn the flow above into a toolScript” and it will call session_tool_create_write to build one; across sessions, when a review exists, send “turn the previous session’s flow into a toolScript” and the model will first call session_tool_create_read to read that review file. ToolScripts gathered this way are runnable with session_tool_call, and the list is injected into the system prompt as a toolSequence section.',
        'help.injectGroup': 'A review has four depths, each loading something different: level 3, the original transcript; level 2, the compaction summary; level 1, the model’s own summary; level 0, keywords only, used as an index.\nDepths drop on the second day, the third day, and the twenty-eighth day onward. When you point out that the model misremembers something, the model itself calls session_mem_read to read that review’s original transcript, then weights and locks the loaded content of that review. An empty review at depth 1 or 0 is normal: the plugin injects a reminder telling the model to call session_mem_write with a summary and keywords. Compliance differs between the context channel and the system-prompt channel, so pick whichever fits.\nTurning on “Full load” is not recommended; for important checkpoints, use DSH’s own branching instead.',
        'opt.auto': 'Auto review',
        'opt.auto.desc': 'When on, behaviour stays as before: a review is created on every compaction and injected into the context and system prompt per the options below. When off, creation and injection stop and every option below becomes read-only.',
        'opt.auto.off': 'Review is off, so review files are neither created nor injected. If you have no other memory plugin or review workflow, turn this on.'
      }
    }

    /** 取一条界面文案；缺英文就回中文，绝不留空。 */
    function tr(key) {
      var dict = TEXTS[LANG] || TEXTS.zh
      var value = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : TEXTS.zh[key]
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
      var note = React.useState(''); var setNote = note[1]
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

      // 换会话就把上一轮的选择清掉，否则会拿着旧工作区的选中项继续显示。
      React.useEffect(function () {
        setSelected(null); setMemPick(null); setRange(null); setConfirming(''); setNote('')
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
        setBusy(true); setErr(''); setNote('')
        try {
          var res = await post('options', patch)
          if (res.options) setOptions(res.options)
          setNote(tr('note.saved'))
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
        if (memConfirm !== 'mem') { setMemConfirm('mem'); setNote(tr('note.memConfirm')); return }
        var cwd = loadInfo ? loadInfo.cwd : null
        if (!cwd) return
        setBusy(true); setErr(''); setNote('')
        try {
          await post('memory-delete', { cwd: cwd, file: memPick })
          setNote(tr('note.memDeleted', memPick))
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
        if (confirming !== 'delete') { setConfirming('delete'); setNote(tr('note.deleteConfirm')); return }
        setBusy(true); setErr(''); setNote(''); setConfirming('')
        var target = selected.id
        try {
          await post('delete', { sessionId: target })
          setNote(tr('note.deleted')); setSelected(null)
          await load()
        } catch (e) {
          var fresh = await load()
          var alive = fresh !== null && (fresh.workspaces || []).some(function (w) {
            return (w.sessions || []).some(function (x) { return x.id === target })
          })
          if (fresh !== null && !alive) { setNote(tr('note.deletedLost')); setSelected(null) }
          else setErr(String(e.message || e))
        } finally { setBusy(false) }
      }

      async function doCompactDelete() {
        if (!selected) return
        if (confirming !== 'compact') { setConfirming('compact'); setNote(tr('note.compactConfirm')); return }
        setBusy(true); setErr(''); setNote(''); setConfirming('')
        var target = selected.id
        try {
          var res = await post('compact-delete', { sessionId: target })
          setNote(tr('note.compacted', res.memory)); setSelected(null)
          await load()
        } catch (e) {
          var fresh2 = await load()
          var alive2 = fresh2 !== null && (fresh2.workspaces || []).some(function (w) {
            return (w.sessions || []).some(function (x) { return x.id === target })
          })
          if (fresh2 !== null && !alive2) { setNote(tr('note.deletedLost')); setSelected(null) }
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
            h('button', { style: isBusy ? S.btnOff : S.btn, disabled: isBusy, onClick: doExport }, tr('tl.export'))
          ),
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
                onClick: function () { setSelected({ id: sess.id, cwd: ws.cwd }); setConfirming(''); setNote('') }
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
                  if (memPick) { setMemPick(null); setMemConfirm(''); setNote(''); if (!open) setOpen(true); return }
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
                          onClick: function () { setMemPick(e.file); setMemConfirm(''); setNote('') }
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
        note[0] ? h('div', { style: S.note }, note[0]) : null,
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

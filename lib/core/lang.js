/**
 * 语言层（0.5.2）：跟随 DSH 的 8 种语言。
 *
 * 回顾文件里的中文标记就是「通配键」：文件本身一个字节不改，
 * 注入与注入框预览按 DSH 当前语言换成对应文字——切换语言只改显示，不改数据。
 *
 * 文件里存在的通配键：
 *   正文行首   [用户] / [模型]
 *   ◂ 行的尾巴 报错：… / 完成
 *   空位      （空）/（未总结）
 * 每种语言在这里各有一张显示映射（见 BODY_MARKS）。
 *
 * 支持的语言（与 DSH 一致）：zh en ja es fr de ru pt。
 * 认不出的 id 一律按中文（老安装没有语言文件时的历史行为）。
 *
 * 这里只放纯函数与词条，不碰文件系统。
 */

/** 插件认识的全部语言，顺序与 DSH 的语言列表一致。 */
export const LANGS = Object.freeze(['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'])

/** 中文、英文两个常量保留（老代码与测试在用）。 */
export const LANG_ZH = 'zh'
export const LANG_EN = 'en'

/** 提醒里「缺什么」的两项。 */
export const MISSING_KEYWORDS = 'keywords'
export const MISSING_DIARY = 'diary'

/**
 * 把 DSH 的 locale id 收成插件认识的 8 种之一。
 * 先按主语言子标签匹配（ja-JP → ja），认不出就按中文。
 * @param {string|undefined|null} id
 */
export function normalizeLang(id) {
  const s = typeof id === 'string' ? id.trim().toLowerCase() : ''
  if (s === '') return LANG_ZH
  const primary = s.split(/[-_]/)[0]
  return LANGS.includes(primary) ? primary : LANG_ZH
}

/* ────────────────────────── 注入词条 ────────────────────────── */

const ZH = Object.freeze({
  preamble: () => '以下是本工作区的历史回顾，按时间从旧到新排列（越靠后离现在越近）。',
  reviewHead: (date) => '【回顾 · ' + date + '】',
  none: '（未总结）',
  noDialogue: '（这段没有对话）',
  noSummary: '（这段没有摘要）',
  noBody: '（这段没有原文）',
  keywordsWord: '关键词',
  diaryWord: '日记',
  missingLabel: (list) => list.join('、'),
  errorTag: '报错：',
  doneTag: '完成',
  reminderHead: (n) => (n <= 1
    ? '【必须这一轮补齐回顾】这份回顾的关键词和日记还空着。在这一轮里补完，不要分几次做：'
    : '【必须这一轮补齐回顾】本工作区有 ' + n + ' 份回顾的关键词和日记还空着。在这一轮里全部补完，不要一份一份分开做：'),
  reminderItem: (tag, file, date, day, missing) =>
    tag + file + '（' + date + ' 压缩，第 ' + day + ' 天；缺：' + missing + '）',
  reminderSteps: (files) => {
    const list = Array.isArray(files) ? files : [files]
    const sample = list.map((f) => '{ file: "' + f + '", keywords: ["<关键词>"], diary: "<日记>" }').join(', ')
    return [
      '1. 先读原文（只含对话，不含工具调用）：' + list.map((f) => 'session_mem_write({ file: "' + f + '" })').join('、'),
      '2. 再用一次调用把' + (list.length <= 1 ? '它' : '全部') + '写完：session_mem_write({ writes: [' + sample + '] })',
      '3. 全部写完再继续，不要写一份就停下来。'
    ]
  },
  reminderTail: () => '以上是硬性要求：写完不要为了核对再读一遍文件，也不要在回复里复述日记内容。'
})

const EN = Object.freeze({
  preamble: () => 'Earlier reviews from this workspace, oldest first (the later ones are closer to now).',
  reviewHead: (date) => '【Review · ' + date + '】',
  none: '(none)',
  noDialogue: '(no dialogue in this segment)',
  noSummary: '(no summary for this segment)',
  noBody: '(no original text in this segment)',
  keywordsWord: 'keywords',
  diaryWord: 'diary',
  missingLabel: (list) => list.join(' + '),
  errorTag: 'error: ',
  doneTag: 'done',
  reminderHead: (n) => (n <= 1
    ? '【ACTION REQUIRED — DO IT NOW】This review\'s keywords and diary are still empty. Finish it in THIS turn, not in several rounds:'
    : '【ACTION REQUIRED — DO IT NOW】' + n + ' reviews in this workspace still lack keywords and/or diary. ' +
      'Finish them all in THIS turn, not one at a time:'),
  reminderItem: (tag, file, date, day, missing) =>
    tag + file + ' (compacted ' + date + ', day ' + day + '; missing: ' + missing + ')',
  reminderSteps: (files) => {
    const list = Array.isArray(files) ? files : [files]
    const sample = list.map((f) => '{ file: "' + f + '", keywords: ["<keywords>"], diary: "<diary>" }').join(', ')
    return [
      '1. Read each original first (dialogue only, tool calls excluded): ' + list.map((f) => 'session_mem_write({ file: "' + f + '" })').join(', '),
      '2. Then write ' + (list.length <= 1 ? 'it' : 'all of them') + ' in one call: session_mem_write({ writes: [' + sample + '] })',
      '3. Finish all of them before continuing; do not stop after one file.'
    ]
  },
  reminderTail: () => 'This is a hard requirement: do not re-read files to verify afterwards, and do not repeat the diary content in your reply.'
})

const JA = Object.freeze({
  preamble: () => '以下はこのワークスペースの過去のレビューです（古い順、後ろほど現在に近い）。',
  reviewHead: (date) => '【レビュー · ' + date + '】',
  none: '（未要約）',
  noDialogue: '（この区間に会話はありません）',
  noSummary: '（この区間に要約はありません）',
  noBody: '（この区間に原文はありません）',
  keywordsWord: 'キーワード',
  diaryWord: '日記',
  missingLabel: (list) => list.join('、'),
  errorTag: 'エラー：',
  doneTag: '完了',
  reminderHead: (n) => (n <= 1
    ? '【このターンでレビューを補完してください】このレビューのキーワードと日記がまだ空です。このターンで書き終えてください（何回にも分けない）：'
    : '【このターンでレビューを補完してください】このワークスペースにはキーワードや日記が空のレビューが ' + n + ' 件あります。このターンですべて書き終えてください（1 件ずつ分けない）：'),
  reminderItem: (tag, file, date, day, missing) =>
    tag + file + '（' + date + ' に圧縮、' + day + ' 日目；不足：' + missing + '）',
  reminderSteps: (files) => {
    const list = Array.isArray(files) ? files : [files]
    const sample = list.map((f) => '{ file: "' + f + '", keywords: ["<キーワード>"], diary: "<日記>" }').join(', ')
    return [
      '1. まず原文を読む（会話のみ、ツール呼び出しは含まない）：' + list.map((f) => 'session_mem_write({ file: "' + f + '" })').join('、'),
      '2. 次に 1 回の呼び出しで' + (list.length <= 1 ? 'それ' : 'すべて') + 'を書き終える：session_mem_write({ writes: [' + sample + '] })',
      '3. すべて書き終えてから続ける。1 件書いただけで止めない。'
    ]
  },
  reminderTail: () => '以上は必須要件です：書き終えた後に確認のため読み直さないこと、返信で日記の内容を繰り返さないこと。'
})

const ES = Object.freeze({
  preamble: () => 'Estas son las revisiones anteriores de este espacio de trabajo, de la más antigua a la más reciente (las últimas están más cerca del presente).',
  reviewHead: (date) => '【Revisión · ' + date + '】',
  none: '(sin resumen)',
  noDialogue: '(no hay diálogo en este tramo)',
  noSummary: '(no hay resumen en este tramo)',
  noBody: '(no hay texto original en este tramo)',
  keywordsWord: 'palabras clave',
  diaryWord: 'diario',
  missingLabel: (list) => list.join(' + '),
  errorTag: 'error: ',
  doneTag: 'hecho',
  reminderHead: (n) => (n <= 1
    ? '【ACCIÓN REQUERIDA — HAZLO AHORA】Las palabras clave y el diario de esta revisión siguen vacíos. Termínalo en ESTE turno, no en varios:'
    : '【ACCIÓN REQUERIDA — HAZLO AHORA】En este espacio de trabajo hay ' + n + ' revisiones sin palabras clave o sin diario. Termínalas todas en ESTE turno, no una por una:'),
  reminderItem: (tag, file, date, day, missing) =>
    tag + file + ' (comprimida el ' + date + ', día ' + day + '; falta: ' + missing + ')',
  reminderSteps: (files) => {
    const list = Array.isArray(files) ? files : [files]
    const sample = list.map((f) => '{ file: "' + f + '", keywords: ["<palabras clave>"], diary: "<diario>" }').join(', ')
    return [
      '1. Lee primero cada original (solo diálogo, sin llamadas a herramientas): ' + list.map((f) => 'session_mem_write({ file: "' + f + '" })').join(', '),
      '2. Después escribe ' + (list.length <= 1 ? 'esa' : 'todas') + ' en una sola llamada: session_mem_write({ writes: [' + sample + '] })',
      '3. Termínalas todas antes de continuar; no pares tras una.'
    ]
  },
  reminderTail: () => 'Esto es obligatorio: no vuelvas a leer los archivos para comprobar y no repitas el contenido del diario en tu respuesta.'
})

const FR = Object.freeze({
  preamble: () => 'Voici les revues précédentes de cet espace de travail, de la plus ancienne à la plus récente (les dernières sont les plus proches de maintenant).',
  reviewHead: (date) => '【Revue · ' + date + '】',
  none: '(non résumé)',
  noDialogue: '(aucun dialogue dans ce segment)',
  noSummary: '(aucun résumé dans ce segment)',
  noBody: '(aucun texte original dans ce segment)',
  keywordsWord: 'mots-clés',
  diaryWord: 'journal',
  missingLabel: (list) => list.join(' + '),
  errorTag: 'erreur : ',
  doneTag: 'terminé',
  reminderHead: (n) => (n <= 1
    ? '【ACTION REQUISE — À FAIRE MAINTENANT】Les mots-clés et le journal de cette revue sont encore vides. Terminez-les dans CE tour, pas en plusieurs fois :'
    : '【ACTION REQUISE — À FAIRE MAINTENANT】' + n + ' revues de cet espace de travail n\'ont pas encore de mots-clés et/ou de journal. Terminez-les toutes dans CE tour, pas une par une :'),
  reminderItem: (tag, file, date, day, missing) =>
    tag + file + ' (compressée le ' + date + ', jour ' + day + ' ; manque : ' + missing + ')',
  reminderSteps: (files) => {
    const list = Array.isArray(files) ? files : [files]
    const sample = list.map((f) => '{ file: "' + f + '", keywords: ["<mots-clés>"], diary: "<journal>" }').join(', ')
    return [
      '1. Lisez d\'abord chaque original (dialogue seul, appels d\'outils exclus) : ' + list.map((f) => 'session_mem_write({ file: "' + f + '" })').join(', '),
      '2. Puis écrivez ' + (list.length <= 1 ? 'la' : 'toutes') + ' en un seul appel : session_mem_write({ writes: [' + sample + '] })',
      '3. Terminez-les toutes avant de continuer ; ne vous arrêtez pas après une.'
    ]
  },
  reminderTail: () => 'C\'est une exigence stricte : ne relisez pas les fichiers pour vérifier ensuite, et ne répétez pas le contenu du journal dans votre réponse.'
})

const DE = Object.freeze({
  preamble: () => 'Hier sind die früheren Reviews dieses Arbeitsbereichs, älteste zuerst (die letzten liegen am nächsten an jetzt).',
  reviewHead: (date) => '【Rückblick · ' + date + '】',
  none: '(nicht zusammengefasst)',
  noDialogue: '(kein Dialog in diesem Abschnitt)',
  noSummary: '(keine Zusammenfassung in diesem Abschnitt)',
  noBody: '(kein Originaltext in diesem Abschnitt)',
  keywordsWord: 'Schlüsselwörter',
  diaryWord: 'Tagebuch',
  missingLabel: (list) => list.join(' + '),
  errorTag: 'Fehler: ',
  doneTag: 'erledigt',
  reminderHead: (n) => (n <= 1
    ? '【HANDLUNG ERFORDERLICH — JETZT ERLEDIGEN】Schlüsselwörter und Tagebuch dieser Review sind noch leer. Erledige es in DIESEM Zug, nicht über mehrere:'
    : '【HANDLUNG ERFORDERLICH — JETZT ERLEDIGEN】In diesem Arbeitsbereich fehlen bei ' + n + ' Reviews Schlüsselwörter und/oder Tagebuch. Erledige alle in DIESEM Zug, nicht eine nach der anderen:'),
  reminderItem: (tag, file, date, day, missing) =>
    tag + file + ' (komprimiert am ' + date + ', Tag ' + day + '; fehlt: ' + missing + ')',
  reminderSteps: (files) => {
    const list = Array.isArray(files) ? files : [files]
    const sample = list.map((f) => '{ file: "' + f + '", keywords: ["<Schlüsselwörter>"], diary: "<Tagebuch>" }').join(', ')
    return [
      '1. Lies zuerst jedes Original (nur Dialog, ohne Tool-Aufrufe): ' + list.map((f) => 'session_mem_write({ file: "' + f + '" })').join(', '),
      '2. Schreibe dann ' + (list.length <= 1 ? 'sie' : 'alle') + ' in einem Aufruf: session_mem_write({ writes: [' + sample + '] })',
      '3. Beende alle, bevor du weitermachst; höre nicht nach einer Datei auf.'
    ]
  },
  reminderTail: () => 'Das ist eine harte Vorgabe: Lies die Dateien danach nicht zur Kontrolle erneut, und wiederhole den Tagebuchinhalt nicht in deiner Antwort.'
})

const RU = Object.freeze({
  preamble: () => 'Ниже — прошлые обзоры этого рабочего пространства, от старых к новым (последние ближе к настоящему).',
  reviewHead: (date) => '【Обзор · ' + date + '】',
  none: '(без итога)',
  noDialogue: '(в этом фрагменте нет диалога)',
  noSummary: '(в этом фрагменте нет итога)',
  noBody: '(в этом фрагменте нет исходного текста)',
  keywordsWord: 'ключевые слова',
  diaryWord: 'дневник',
  missingLabel: (list) => list.join(' + '),
  errorTag: 'ошибка: ',
  doneTag: 'готово',
  reminderHead: (n) => (n <= 1
    ? '【ТРЕБУЕТСЯ ДЕЙСТВИЕ — СДЕЛАЙТЕ СЕЙЧАС】Ключевые слова и дневник этого обзора всё ещё пусты. Завершите в ЭТОМ ходе, а не за несколько:'
    : '【ТРЕБУЕТСЯ ДЕЙСТВИЕ — СДЕЛАЙТЕ СЕЙЧАС】В этом рабочем пространстве у ' + n + ' обзоров нет ключевых слов и/или дневника. Завершите все в ЭТОМ ходе, а не по одному:'),
  reminderItem: (tag, file, date, day, missing) =>
    tag + file + ' (сжат ' + date + ', день ' + day + '; не хватает: ' + missing + ')',
  reminderSteps: (files) => {
    const list = Array.isArray(files) ? files : [files]
    const sample = list.map((f) => '{ file: "' + f + '", keywords: ["<ключевые слова>"], diary: "<дневник>" }').join(', ')
    return [
      '1. Сначала прочитай каждый оригинал (только диалог, без вызовов инструментов): ' + list.map((f) => 'session_mem_write({ file: "' + f + '" })').join(', '),
      '2. Затем запиши ' + (list.length <= 1 ? 'его' : 'все') + ' одним вызовом: session_mem_write({ writes: [' + sample + '] })',
      '3. Заверши все, прежде чем продолжать; не останавливайся после одного файла.'
    ]
  },
  reminderTail: () => 'Это жёсткое требование: не перечитывай файлы для проверки и не повторяй содержимое дневника в ответе.'
})

const PT = Object.freeze({
  preamble: () => 'Estas são as revisões anteriores deste espaço de trabalho, da mais antiga para a mais recente (as últimas estão mais perto de agora).',
  reviewHead: (date) => '【Revisão · ' + date + '】',
  none: '(sem resumo)',
  noDialogue: '(não há diálogo neste trecho)',
  noSummary: '(não há resumo neste trecho)',
  noBody: '(não há texto original neste trecho)',
  keywordsWord: 'palavras-chave',
  diaryWord: 'diário',
  missingLabel: (list) => list.join(' + '),
  errorTag: 'erro: ',
  doneTag: 'concluído',
  reminderHead: (n) => (n <= 1
    ? '【AÇÃO NECESSÁRIA — FAÇA AGORA】As palavras-chave e o diário desta revisão ainda estão vazios. Termine NESTE turno, não em vários:'
    : '【AÇÃO NECESSÁRIA — FAÇA AGORA】Neste espaço de trabalho há ' + n + ' revisões sem palavras-chave e/ou diário. Termine todas NESTE turno, não uma de cada vez:'),
  reminderItem: (tag, file, date, day, missing) =>
    tag + file + ' (compactada em ' + date + ', dia ' + day + '; falta: ' + missing + ')',
  reminderSteps: (files) => {
    const list = Array.isArray(files) ? files : [files]
    const sample = list.map((f) => '{ file: "' + f + '", keywords: ["<palavras-chave>"], diary: "<diário>" }').join(', ')
    return [
      '1. Leia primeiro cada original (só diálogo, sem chamadas de ferramentas): ' + list.map((f) => 'session_mem_write({ file: "' + f + '" })').join(', '),
      '2. Depois escreva ' + (list.length <= 1 ? 'essa' : 'todas') + ' em uma única chamada: session_mem_write({ writes: [' + sample + '] })',
      '3. Termine todas antes de continuar; não pare depois de uma.'
    ]
  },
  reminderTail: () => 'Isto é obrigatório: não releia os arquivos para conferir depois e não repita o conteúdo do diário na resposta.'
})

const PHRASES = Object.freeze({ zh: ZH, en: EN, ja: JA, es: ES, fr: FR, de: DE, ru: RU, pt: PT })

/**
 * 取这一种语言的词条。
 * @param {string} lang
 * @returns {object}
 */
export function phrasesFor(lang) {
  return PHRASES[normalizeLang(lang)] || ZH
}

/* ─────────────────────── 正文标记的语言映射 ─────────────────────── */

/**
 * 文件里永远写中文标记（render.js 的 MARK）；显示时按语言换字。
 * 中文即原样，所以中文不在这张表里。
 */
const BODY_MARKS = Object.freeze({
  en: { user: '[user] ', model: '[model] ', err: '◂ error: ', done: '◂ done' },
  ja: { user: '[ユーザー] ', model: '[モデル] ', err: '◂ エラー：', done: '◂ 完了' },
  es: { user: '[usuario] ', model: '[modelo] ', err: '◂ error: ', done: '◂ hecho' },
  fr: { user: '[utilisateur] ', model: '[modèle] ', err: '◂ erreur : ', done: '◂ terminé' },
  de: { user: '[Benutzer] ', model: '[Modell] ', err: '◂ Fehler: ', done: '◂ erledigt' },
  ru: { user: '[пользователь] ', model: '[модель] ', err: '◂ ошибка: ', done: '◂ готово' },
  pt: { user: '[usuário] ', model: '[modelo] ', err: '◂ erro: ', done: '◂ concluído' }
})

/**
 * 把原文正文按语言换字。中文原样返回（文件里的中文就是通配键本身）。
 * @param {string} body
 * @param {string} lang
 * @returns {string}
 */
export function localizeBody(body, lang) {
  const text = String(body ?? '')
  const id = normalizeLang(lang)
  const marks = BODY_MARKS[id]
  if (id === LANG_ZH || !marks) return text
  return text
    .replace(/^\[用户\] /gm, marks.user)
    .replace(/^\[模型\] /gm, marks.model)
    .replace(/^◂ 报错：/gm, marks.err)
    .replace(/^◂ 完成$/gm, marks.done)
}

/** 日记区算不算空：空串、文件里的旧占位、各语言的不总结占位都算。 */
export function isBlankDiary(diary) {
  const t = String(diary === undefined || diary === null ? '' : diary).trim()
  if (t === '' || t === '（空）' || t === '(空)') return true
  return LANGS.some((id) => t === PHRASES[id].none)
}

/** 关键词算不算没写：空串、旧文件哨兵、各语言的不总结占位都算。 */
export function isBlankKeywords(keywords) {
  const t = String(keywords === undefined || keywords === null ? '' : keywords).trim()
  if (t === '' || t === '未总结') return true
  return LANGS.some((id) => t === PHRASES[id].none || t === PHRASES[id].keywordsWord)
}

/* ─────────────── 回顾文件本身的语言（8 种，写时定、读时认）─────────────── */

/** 文件头字段名，8 种语言各一套。 */
const HEADERS = Object.freeze({
  zh: Object.freeze({
    title: '回顾', covers: '覆盖 seq', branchFrom: '承接自', tokens: '被压 token',
    toolCalls: '工具调用', keywords: '关键词', depth: '深度', locked: '锁定'
  }),
  en: Object.freeze({
    title: 'Review', covers: 'covers seq', branchFrom: 'branched from', tokens: 'compacted tokens',
    toolCalls: 'tool calls', keywords: 'keywords', depth: 'depth', locked: 'locked'
  }),
  ja: Object.freeze({
    title: 'レビュー', covers: '対象 seq', branchFrom: '引き継ぎ元', tokens: '圧縮トークン',
    toolCalls: 'ツール呼び出し', keywords: 'キーワード', depth: '深さ', locked: 'ロック'
  }),
  es: Object.freeze({
    title: 'Revisión', covers: 'cubre seq', branchFrom: 'continúa desde', tokens: 'tokens comprimidos',
    toolCalls: 'llamadas a herramientas', keywords: 'palabras clave', depth: 'profundidad', locked: 'bloqueado'
  }),
  fr: Object.freeze({
    title: 'Revue', covers: 'couvre seq', branchFrom: 'repris de', tokens: 'tokens compactés',
    toolCalls: 'appels d’outils', keywords: 'mots-clés', depth: 'profondeur', locked: 'verrouillé'
  }),
  de: Object.freeze({
    title: 'Rückblick', covers: 'deckt seq ab', branchFrom: 'übernommen von', tokens: 'komprimierte Token',
    toolCalls: 'Tool-Aufrufe', keywords: 'Schlüsselwörter', depth: 'Tiefe', locked: 'gesperrt'
  }),
  ru: Object.freeze({
    title: 'Обзор', covers: 'покрывает seq', branchFrom: 'продолжено с', tokens: 'сжатых токенов',
    toolCalls: 'вызовов инструментов', keywords: 'ключевые слова', depth: 'глубина', locked: 'закреплено'
  }),
  pt: Object.freeze({
    title: 'Revisão', covers: 'cobre seq', branchFrom: 'continua de', tokens: 'tokens compactados',
    toolCalls: 'chamadas de ferramentas', keywords: 'palavras-chave', depth: 'profundidade', locked: 'bloqueado'
  })
})

/** 三个分区的标题。 */
const SECTION_TITLES = Object.freeze({
  zh: Object.freeze({ sum: '摘要', body: '原文', diary: '日记' }),
  en: Object.freeze({ sum: 'Summary', body: 'Original', diary: 'Diary' }),
  ja: Object.freeze({ sum: '要約', body: '原文', diary: '日記' }),
  es: Object.freeze({ sum: 'Resumen', body: 'Original', diary: 'Diario' }),
  fr: Object.freeze({ sum: 'Résumé', body: 'Original', diary: 'Journal' }),
  de: Object.freeze({ sum: 'Zusammenfassung', body: 'Original', diary: 'Tagebuch' }),
  ru: Object.freeze({ sum: 'Итог', body: 'Исходный текст', diary: 'Дневник' }),
  pt: Object.freeze({ sum: 'Resumo', body: 'Original', diary: 'Diário' })
})

/**
 * 写文件头时用的字段名。
 * @param {string} lang
 * @returns {object}
 */
export function headerLabels(lang) {
  return HEADERS[normalizeLang(lang)] || HEADERS.zh
}

/**
 * 一个逻辑字段的全部写法（8 种语言，去重）。
 * @param {string} field
 * @returns {string[]}
 */
export function headerAliases(field) {
  const out = []
  for (const id of LANGS) {
    const v = HEADERS[id][field]
    if (typeof v === 'string' && v !== '' && !out.includes(v)) out.push(v)
  }
  return out
}

/**
 * 从 parseMemory 的 meta 里取一个逻辑字段；8 种语言的写法都认。
 * @param {Record<string,string>|undefined|null} meta
 * @param {string} field
 * @returns {string}
 */
export function readField(meta, field) {
  if (!meta || typeof meta !== 'object') return ''
  for (const key of headerAliases(field)) {
    if (Object.prototype.hasOwnProperty.call(meta, key)) return meta[key]
  }
  return ''
}

/**
 * 分区标题。
 * @param {string} lang
 * @param {'sum'|'body'|'diary'} key
 * @returns {string}
 */
export function sectionTitle(lang, key) {
  const table = SECTION_TITLES[normalizeLang(lang)] || SECTION_TITLES.zh
  return table[key]
}

/**
 * 这份文件的分区标题是哪种语言：按各语言的标题去认，认不出按中文。
 * @param {string} text
 * @returns {string}
 */
export function sectionLangOf(text) {
  const src = String(text ?? '')
  const lines = src.split('\n').map((line) => line.trim())
  // 先认文件头标题（每种语言的 title 都不同），认不出再看分区标题。
  const first = lines.find((line) => line !== '') || ''
  for (const id of LANGS) {
    if (first.startsWith('# ' + HEADERS[id].title + ' ·')) return id
  }
  for (const id of LANGS) {
    const title = '## ' + SECTION_TITLES[id].body
    if (lines.some((line) => line === title)) return id
  }
  return LANG_ZH
}

/** 文件头各字段的值（随语言）。 */
export function coversValue(lang, start, end, count) {
  const id = normalizeLang(lang)
  const n = String(count)
  if (id === 'zh') return start + '–' + end + '（' + n + ' 条）'
  if (id === 'ja') return start + '–' + end + '（' + n + ' 件）'
  if (id === 'de') return start + '–' + end + ' (' + n + ' Einträge)'
  if (id === 'ru') return start + '–' + end + ' (' + n + ' записей)'
  if (id === 'fr') return start + '–' + end + ' (' + n + ' entrées)'
  if (id === 'es') return start + '–' + end + ' (' + n + ' entradas)'
  if (id === 'pt') return start + '–' + end + ' (' + n + ' entradas)'
  return start + '–' + end + ' (' + n + ' entries)'
}

export function branchValue(lang, file, line) {
  const id = normalizeLang(lang)
  if (id === 'zh') return file + ' 第 ' + line + ' 行'
  if (id === 'ja') return file + ' ' + line + ' 行目'
  if (id === 'es') return file + ' línea ' + line
  if (id === 'fr') return file + ' ligne ' + line
  if (id === 'de') return file + ' Zeile ' + line
  if (id === 'ru') return file + ' строка ' + line
  if (id === 'pt') return file + ' linha ' + line
  return file + ' line ' + line
}

export function toolCallsValue(lang, calls, failures) {
  const id = normalizeLang(lang)
  if (id === 'zh') return calls + ' 次（失败 ' + failures + '）'
  if (id === 'ja') return calls + ' 回（失敗 ' + failures + '）'
  if (id === 'es') return calls + ' llamadas (' + failures + ' fallidas)'
  if (id === 'fr') return calls + ' appels (' + failures + ' échoués)'
  if (id === 'de') return calls + ' Aufrufe (' + failures + ' fehlgeschlagen)'
  if (id === 'ru') return calls + ' вызовов (' + failures + ' с ошибкой)'
  if (id === 'pt') return calls + ' chamadas (' + failures + ' falhas)'
  return calls + ' calls (' + failures + ' failed)'
}

export function lockedValue(lang, locked) {
  const on = locked === true
  const id = normalizeLang(lang)
  if (id === 'zh') return on ? '是' : '否'
  if (id === 'ja') return on ? 'はい' : 'いいえ'
  if (id === 'es') return on ? 'sí' : 'no'
  if (id === 'fr') return on ? 'oui' : 'non'
  if (id === 'de') return on ? 'ja' : 'nein'
  if (id === 'ru') return on ? 'да' : 'нет'
  if (id === 'pt') return on ? 'sim' : 'não'
  return on ? 'yes' : 'no'
}

/**
 * 从「工具调用」这一行的值里取次数与失败数。
 * 0.5.2 起这个值可能带任何语言的后缀，只认前两个整数；认不出给 0。
 * @param {string} text
 */
export function parseToolCounts(text) {
  const s = String(text === undefined || text === null ? '' : text)
  const m = /(\d+)[^0-9]+(\d+)/.exec(s)
  if (m) return { calls: Number(m[1]), failures: Number(m[2]) }
  const one = /(\d+)/.exec(s)
  return { calls: one ? Number(one[1]) : 0, failures: 0 }
}

/* ─────────────────── 工具组清单那一段（8 种语言）─────────────────── */

/** 系统提示词里「工具组清单」的标题、指引与条目格式。 */
const CATALOG = Object.freeze({
  zh: {
    empty: '【工具组 · 空】还没有固化任何工具脚本。',
    header: (n) => '【工具组 · ' + n + ' 个工具脚本】已经固化好的脚本，直接用 session_tool_call 跑；不用自己写代码，也不用重新找命令。',
    runHint: '跑之前想看命令，就给 session_tool_call 加 dryRun: true。',
    guide: '用户说「把那套总结成工具 / 封装成流程 / 以后照这个做」时，要的产物就是工具脚本——能直接跑的脚本，不是 md 笔记，也不是教方法的 skill。用 session_tool_create_write 写下来：命令来自刚跑通的步骤、经 session_tool_create_read 翻出的回顾原文，或工作区里现成的材料。调用 session_tool_create_write 之前，脚本必须已经跑通；写进去的就是跑通的那一份，不是装好再改的草稿。装完再改，等于把整段上下文重发一遍。',
    args: '参数 ',
    entry: (id, title, purpose, entry, params) => '· ' + id + '（' + title + '）：' + purpose + '｜入口 ' + entry + params
  },
  en: {
    empty: '【ToolSequence · empty】Nothing sealed yet. ',
    header: (n) => '【ToolSequence · ' + n + ' toolScript(s)】Whole scripts, sealed: the exact commands from paths that worked. Run them with session_tool_call — do not rewrite them, do not re-derive commands.',
    runHint: 'Look before running: pass "dryRun": true to session_tool_call. ',
    guide: 'When the user asks to turn a working setup into a reusable procedure (summarize it into a toolScript / seal it as a workflow / do it this way next time), the artifact is a toolScript — the exact commands to run again, not a markdown note and not a skill that only states a method. Write it with session_tool_create_write: from the steps you just ran, from a recall original via session_tool_create_read, or from material already in the workspace. Call session_tool_create_write only with a script that already ran clean, never a draft; editing after installing re-sends the whole context.',
    args: 'args ',
    entry: (id, title, purpose, entry, params) => '· ' + id + ' (' + title + '): ' + purpose + '｜entry ' + entry + params
  },
  ja: {
    empty: '【ツールグループ · 空】まだツールスクリプトは封入されていません。',
    header: (n) => '【ツールグループ · ' + n + ' 個のツールスクリプト】封入済みのスクリプトです。session_tool_call でそのまま実行してください。コードを書き直す必要も、コマンドを探し直す必要もありません。',
    runHint: '実行前にコマンドを見たいときは、session_tool_call に dryRun: true を渡してください。',
    guide: 'ユーザーが「その一連の作業をツールにまとめて／手順として固めて／次から同じやり方で」と言ったとき、成果物はツールスクリプトです——そのまま実行できるコマンドであり、md のメモでも、方法だけを述べた skill でもありません。session_tool_create_write で書き出してください：直前に通した手順、session_tool_create_read で読み戻したレビューの原文、またはワークスペースに既にある材料から作ります。session_tool_create_write に渡すのは、すでに正常終了したスクリプトだけです（下書きは不可）。インストール後に書き換えると、コンテキスト全体を送り直すことになります。',
    args: '引数 ',
    entry: (id, title, purpose, entry, params) => '· ' + id + '（' + title + '）：' + purpose + '｜入口 ' + entry + params
  },
  es: {
    empty: '【Grupo de herramientas · vacío】Todavía no hay ningún toolScript sellado.',
    header: (n) => '【Grupo de herramientas · ' + n + ' toolScript(s)】Scripts completos y sellados: los comandos exactos de rutas que funcionaron. Ejecútalos con session_tool_call; no los reescribas ni vuelvas a deducir los comandos.',
    runHint: 'Para ver los comandos antes de ejecutar, pasa "dryRun": true a session_tool_call. ',
    guide: 'Cuando el usuario pida convertir un flujo de trabajo en un procedimiento reutilizable (resumirlo en un toolScript / sellarlo como flujo / hacerlo así la próxima vez), el artefacto es un toolScript: los comandos exactos para volver a ejecutar, no una nota markdown ni una skill que solo describe un método. Escríbelo con session_tool_create_write: a partir de los pasos que acabas de ejecutar, del original de una revisión vía session_tool_create_read, o de material que ya está en el espacio de trabajo. Llama a session_tool_create_write solo con un script que ya se ejecutó sin errores, nunca con un borrador; editarlo después de instalarlo reenvía todo el contexto.',
    args: 'args ',
    entry: (id, title, purpose, entry, params) => '· ' + id + ' (' + title + '): ' + purpose + '｜entrada ' + entry + params
  },
  fr: {
    empty: '【Groupe d’outils · vide】Aucun toolScript n’est encore scellé.',
    header: (n) => '【Groupe d’outils · ' + n + ' toolScript(s)】Scripts complets et scellés : les commandes exactes de procédures qui ont fonctionné. Exécutez-les avec session_tool_call ; ne les réécrivez pas et ne redéduisez pas les commandes.',
    runHint: 'Pour voir les commandes avant d’exécuter, passez "dryRun": true à session_tool_call. ',
    guide: 'Quand l’utilisateur demande de transformer une procédure qui marche en procédure réutilisable (la résumer en toolScript / la sceller comme workflow / refaire ainsi la prochaine fois), l’artefact est un toolScript : les commandes exactes à rejouer, pas une note markdown ni une skill qui ne fait que décrire une méthode. Écrivez-le avec session_tool_create_write : à partir des étapes que vous venez d’exécuter, de l’original d’une revue via session_tool_create_read, ou de matière déjà présente dans l’espace de travail. N’appelez session_tool_create_write qu’avec un script qui s’est déjà exécuté proprement, jamais un brouillon ; le modifier après installation renvoie tout le contexte.',
    args: 'args ',
    entry: (id, title, purpose, entry, params) => '· ' + id + ' (' + title + ') : ' + purpose + '｜entrée ' + entry + params
  },
  de: {
    empty: '【Tool-Gruppe · leer】Es ist noch kein toolScript versiegelt.',
    header: (n) => '【Tool-Gruppe · ' + n + ' toolScript(s)】Vollständige, versiegelte Skripte: die exakten Befehle aus Abläufen, die funktioniert haben. Führe sie mit session_tool_call aus; schreibe sie nicht neu und leite die Befehle nicht neu ab.',
    runHint: 'Um die Befehle vor der Ausführung zu sehen, übergib "dryRun": true an session_tool_call. ',
    guide: 'Wenn der Nutzer einen funktionierenden Ablauf in eine wiederverwendbare Prozedur verwandeln will (als toolScript zusammenfassen / als Workflow versiegeln / beim nächsten Mal genauso machen), ist das Ergebnis ein toolScript — die exakten Befehle zum erneuten Ausführen, keine Markdown-Notiz und keine Skill, die nur eine Methode beschreibt. Schreibe es mit session_tool_create_write: aus den gerade ausgeführten Schritten, aus dem Original einer Review via session_tool_create_read oder aus Material, das bereits im Arbeitsbereich liegt. Rufe session_tool_create_write nur mit einem Skript auf, das bereits sauber gelaufen ist, nie mit einem Entwurf; Änderungen nach der Installation senden den gesamten Kontext erneut.',
    args: 'Argumente ',
    entry: (id, title, purpose, entry, params) => '· ' + id + ' (' + title + '): ' + purpose + '｜Einstieg ' + entry + params
  },
  ru: {
    empty: '【Группа инструментов · пусто】Пока не запечатано ни одного toolScript.',
    header: (n) => '【Группа инструментов · ' + n + ' toolScript】Готовые скрипты целиком: точные команды из рабочих путей. Запускайте их через session_tool_call — не переписывайте и не выводите команды заново.',
    runHint: 'Чтобы увидеть команды до запуска, передайте "dryRun": true в session_tool_call. ',
    guide: 'Когда пользователь просит превратить рабочий процесс в повторяемую процедуру (свести в toolScript / запечатать как workflow / делать так в следующий раз), результатом является toolScript — точные команды для повторного запуска, а не markdown-заметка и не skill, который лишь описывает метод. Записывайте его через session_tool_create_write: из только что выполненных шагов, из оригинала обзора через session_tool_create_read или из материалов, уже лежащих в рабочем пространстве. Вызывайте session_tool_create_write только со скриптом, который уже отработал без ошибок, никогда с черновиком; правка после установки отправит весь контекст заново.',
    args: 'аргументы ',
    entry: (id, title, purpose, entry, params) => '· ' + id + ' (' + title + '): ' + purpose + '｜вход ' + entry + params
  },
  pt: {
    empty: '【Grupo de ferramentas · vazio】Nenhum toolScript selado ainda.',
    header: (n) => '【Grupo de ferramentas · ' + n + ' toolScript(s)】Scripts completos e selados: os comandos exatos de caminhos que funcionaram. Execute-os com session_tool_call; não os reescreva e não deduza os comandos novamente.',
    runHint: 'Para ver os comandos antes de executar, passe "dryRun": true para session_tool_call. ',
    guide: 'Quando o usuário pedir para transformar um fluxo que funciona em um procedimento reutilizável (resumir em um toolScript / selar como workflow / fazer assim da próxima vez), o artefato é um toolScript: os comandos exatos para executar de novo, não uma nota markdown nem uma skill que apenas descreve um método. Escreva-o com session_tool_create_write: a partir dos passos que você acabou de executar, do original de uma revisão via session_tool_create_read, ou de material que já existe no espaço de trabalho. Chame session_tool_create_write apenas com um script que já rodou limpo, nunca com um rascunho; editar depois de instalar reenvia todo o contexto.',
    args: 'args ',
    entry: (id, title, purpose, entry, params) => '· ' + id + ' (' + title + '): ' + purpose + '｜entrada ' + entry + params
  }
})

/**
 * 工具组清单那一段的词条（8 种语言）。
 * @param {string} lang
 */
export function catalogPhrases(lang) {
  return CATALOG[normalizeLang(lang)] || CATALOG.zh
}

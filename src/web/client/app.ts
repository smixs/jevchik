type Dict = Record<string, unknown>

interface TelegramWebApp {
  initData: string
  ready?: () => void
  expand?: () => void
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp }
  }
}

const webApp = window.Telegram?.WebApp
const initData = webApp?.initData ?? ''
const root = document.getElementById('app') as HTMLElement
const nav = document.getElementById('nav') as HTMLElement

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)
const list = (v: unknown): Dict[] => (Array.isArray(v) ? (v as Dict[]) : [])
const dict = (v: unknown): Dict => (typeof v === 'object' && v !== null ? (v as Dict) : {})
const fmt = (v: unknown): string => n(v).toFixed(2)

type Child = Node | string | null | undefined | false

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  for (const child of children) if (child) el.append(child)
  return el
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Dict,
  ) {
    super(s(body.error) || `http ${status}`)
  }
}

/** The chat chosen on the chat screen, sent with every request when the Mini App was opened without start_param. */
let chosenChat: number | null = null

async function api(path: string, init: RequestInit = {}): Promise<Dict> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>), Authorization: `tma ${initData}` }
  if (chosenChat !== null) headers['X-Chat-Id'] = String(chosenChat)
  const response = await fetch(path, { ...init, headers })
  const body = dict(await response.json().catch(() => ({})))
  if (!response.ok) throw new ApiError(response.status, body)
  return body
}

type Screen = () => Promise<Child[]>

let generation = 0

/** Renders a screen; a slower earlier screen never overwrites a later one. */
async function render(build: Screen): Promise<void> {
  const mine = ++generation
  let nodes: Child[]
  try {
    nodes = await build()
  } catch (error) {
    nodes = [failure(error)]
  }
  if (mine === generation) root.replaceChildren(...(nodes.filter(Boolean) as Node[]))
}

/** A plain reason for the answers the server gives on purpose; the general phrase only for an unknown failure. */
const REASONS: Record<string, string> = {
  no_context: 'Не понял, какой чат открыть. Откройте Mini App кнопкой из чата.',
  bad_context: 'Ссылка на Mini App повреждена. Откройте её заново кнопкой из чата.',
  not_member: 'Вы не участник этого чата.',
  forbidden: 'Этот экран только для админов чата.',
  unknown_chat: 'Этот чат не подключён к Жевчику.',
  page_hidden: 'Участник скрыл свою страницу.',
  not_found: 'Такой страницы нет.',
}

const BY_STATUS: Record<number, string> = {
  400: 'Сервер не понял запрос. Закройте и откройте Mini App заново.',
  401: 'Откройте Mini App из чата: подпись Telegram не подошла.',
  403: 'Нет доступа к этому экрану.',
  404: 'Такой страницы нет.',
  503: 'Сервис временно недоступен, попробуйте позже.',
}

function failure(error: unknown): HTMLElement {
  const status = error instanceof ApiError ? error.status : 0
  const code = error instanceof ApiError ? s(error.body.error) : ''
  const known = [400, 403, 404].includes(status) ? REASONS[code] : undefined
  return h('p', { class: 'error', role: 'alert' }, known ?? BY_STATUS[status] ?? 'Не удалось загрузить данные.')
}

// ---------------------------------------------------------------- leaderboard

const PERIODS: Array<[string, string]> = [['week', 'Неделя'], ['month', 'Месяц'], ['all', 'Всё время']]

async function leaderboardScreen(period = 'week'): Promise<Child[]> {
  const data = await api(`/api/leaderboard?period=${period}`)
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, ...PERIODS.map(([key, label]) => {
    const button = h('button', { 'data-period': key, 'aria-current': String(key === period) }, label)
    button.addEventListener('click', () => void render(() => leaderboardScreen(key)))
    return button
  }))
  const rows = list(data.rows).map((row) => {
    const tr = h('tr', { class: `row${row.is_me ? ' me' : ''}`, 'data-public-id': s(row.public_id) }, h('td', { class: 'num' }, s(row.place)), h('td', {}, s(row.name)), h('td', { class: 'num' }, fmt(row.karma)))
    tr.addEventListener('click', () => void render(() => pageScreen(s(row.public_id))))
    return tr
  })
  const table = rows.length
    ? h('table', { 'data-testid': 'leaderboard' }, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Имя'), h('th', { class: 'num' }, 'Карма'))), h('tbody', {}, ...rows))
    : h('p', { class: 'hint' }, 'За этот период пока никого нет.')
  return [h('h1', {}, 'Лидерборд'), tabs, table]
}

// ---------------------------------------------------------------- personal page

function chartSvg(points: Dict[]): HTMLElement | null {
  if (points.length < 2) return null
  const values = points.map((p) => n(p.karma))
  const min = Math.min(...values)
  const span = Math.max(...values) - min || 1
  const step = 300 / (points.length - 1)
  const path = values.map((v, i) => `${(i * step).toFixed(1)},${(76 - ((v - min) / span) * 72).toFixed(1)}`).join(' ')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'chart')
  svg.setAttribute('viewBox', '0 0 300 80')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'График кармы')
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
  line.setAttribute('points', path)
  line.setAttribute('fill', 'none')
  line.setAttribute('stroke', 'currentColor')
  line.setAttribute('stroke-width', '2')
  svg.append(line)
  return svg as unknown as HTMLElement
}

function stat(field: string, label: string, value: string): HTMLElement {
  return h('div', { class: 'stat', 'data-field': field }, h('b', {}, value), h('span', {}, label))
}

function messageBlock(title: string, field: string, items: Dict[]): HTMLElement {
  const lines = items.map((m) => {
    const text = h('span', {}, s(m.excerpt))
    const link = s(m.link)
    return h('li', {}, text, link ? h('a', { href: link, rel: 'noopener' }, ' ↗') : null)
  })
  return h('section', { class: 'card', 'data-field': field }, h('h2', {}, title), lines.length ? h('ul', {}, ...lines) : h('p', { class: 'hint' }, 'Пока пусто.'))
}

function statsGrid(page: Dict): HTMLElement {
  return h('div', { class: 'grid' },
    stat('karma', 'Карма', fmt(page.karma)),
    stat('place', 'Место', s(page.place) || '-'),
    stat('week_delta', 'За неделю', fmt(page.week_delta)),
    stat('thanks_count', 'Благодарности', s(page.thanks_count)),
    stat('answers_count', 'Ответы на вопросы', s(page.answers_count)),
    stat('caught_spammers_count', 'Пойманные спамеры', s(page.caught_spammers_count)),
    stat('streak_weeks', 'Серия недель', s(page.streak_weeks)),
  )
}

function decayNote(warning: Dict): HTMLElement | null {
  if (!warning.starts_at) return null
  return h('p', { class: 'error', 'data-field': 'decay_warning' }, `Карма начнёт убывать ${new Date(s(warning.starts_at)).toLocaleDateString('ru-RU')}: напишите в чат.`)
}

function hideButton(page: Dict): HTMLElement {
  const button = h('button', { class: 'primary', 'data-action': 'hide' }, page.hidden ? 'Показать мою страницу' : 'Скрыть мою страницу')
  button.addEventListener('click', () => void api('/api/me/hide', { method: 'POST', body: JSON.stringify({ hidden: !page.hidden }) }).then(() => render(meScreen)).catch((e: unknown) => render(async () => [failure(e)])))
  return button
}

function pageView(page: Dict, self: boolean): Child[] {
  const messages = dict(page.messages)
  return [
    h('h1', {}, s(page.name) || 'Моя страница'),
    page.empty ? h('p', { class: 'hint' }, 'Здесь появятся ваши цифры, когда вы напишете в чате и получите первые оценки.') : null,
    decayNote(dict(page.decay_warning)),
    statsGrid(page),
    chartSvg(list(page.chart)),
    messageBlock('Последние сообщения', 'messages_latest', list(messages.latest)),
    messageBlock('Самые заплюсованные', 'messages_top_upvoted', list(messages.top_upvoted)),
    messageBlock('Больше всего ответов', 'messages_most_replied', list(messages.most_replied)),
    self && !page.empty ? hideButton(page) : null,
  ]
}

async function meScreen(): Promise<Child[]> {
  return pageView(await api('/api/me'), true)
}

async function pageScreen(publicId: string): Promise<Child[]> {
  try {
    return pageView(await api(`/api/members/${publicId}`), false)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [h('p', { class: 'hint' }, 'Участник скрыл свою страницу.')]
    throw error
  }
}

// ---------------------------------------------------------------- bans and appeal

async function bansScreen(): Promise<Child[]> {
  const data = await api('/api/bans')
  const cards = list(data.bans).map((b) =>
    h('article', { class: 'card', 'data-ban-id': s(b.id) }, h('img', { class: 'ban', src: s(b.image), alt: '' }), h('h2', {}, s(b.name)), h('p', { 'data-field': 'category' }, s(b.category_title)), h('p', { class: 'hint', 'data-field': 'explanation' }, s(b.explanation)), h('p', { class: 'hint' }, new Date(s(b.date)).toLocaleDateString('ru-RU'))),
  )
  return [h('h1', {}, 'Баня'), ...(cards.length ? cards : [h('p', { class: 'hint' }, 'В бане пусто.')])]
}

const APPEAL_TEXT: Record<string, string> = {
  rejected: 'Объяснение не убедило. Попытка была одна.',
  review: 'Объяснение передано админам, ждите решения.',
  not_allowed: 'Повторное попадание в баню: разбан через приложение недоступен.',
  no_ban: 'Вас нет в бане.',
  pending: 'Объяснение уже проверяется.',
  try_later: 'Не получилось, попробуйте позже.',
}

async function appealScreen(): Promise<Child[]> {
  const state = await api('/api/appeal')
  const result = h('p', { 'data-field': 'appeal_result', role: 'status' })
  const area = h('textarea', { maxlength: '500', rows: '5', 'aria-label': 'Объяснение', hidden: '' })
  const send = h('button', { class: 'primary', hidden: '' }, 'Отправить')
  const start = h('button', { class: 'primary', 'data-action': 'human' }, 'Я человек')
  start.addEventListener('click', () => {
    area.removeAttribute('hidden')
    send.removeAttribute('hidden')
    start.setAttribute('hidden', '')
  })
  send.addEventListener('click', () => {
    const text = (area as HTMLTextAreaElement).value
    void api('/api/appeal', { method: 'POST', body: JSON.stringify({ text }) })
      .then((r) => {
        const status = s(r.status)
        result.textContent = status === 'accepted' ? (r.lifted ? 'Готово, ограничение снято. Первые сообщения проверяются строже.' : 'Принято. Снятие ограничения не прошло, нажмите ещё раз позже.') : (APPEAL_TEXT[status] ?? 'Готово.')
      })
      .catch((error: unknown) => {
        result.textContent = error instanceof ApiError && error.status === 422 ? 'Напишите от 1 до 500 знаков.' : 'Не получилось, попробуйте позже.'
      })
  })
  const blocked = state.status !== 'none' || state.allowed === false
  return [h('h1', {}, 'Разбан'), h('p', { class: 'hint' }, 'Одна попытка. Своими словами: почему вы в этом чате и что произошло.'), blocked ? h('p', { class: 'hint', 'data-field': 'appeal_state' }, APPEAL_TEXT[s(state.status)] ?? 'Разбан недоступен.') : start, area, send, result]
}

// ---------------------------------------------------------------- admin

const PARSERS: Record<string, (text: string) => unknown> = {
  number: Number,
  integer: Number,
  boolean: (text) => text === 'true',
  timestamp: (text) => (text === '' ? null : text),
  string_array: (text) => JSON.parse(text),
  number_array: (text) => JSON.parse(text),
  questions: (text) => JSON.parse(text),
}

function parseSetting(type: string, text: string): unknown {
  return (PARSERS[type] ?? ((raw: string) => raw))(text)
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) return `Ошибка: ${s(error.body.message) || s(error.body.error)}`
  return error instanceof SyntaxError ? 'Ошибка: это не JSON' : 'Ошибка'
}

async function saveSetting(name: string, body: { value: unknown; base_version: number }): Promise<unknown> {
  return (await api(`/api/admin/settings/${name}`, { method: 'PUT', body: JSON.stringify(body) })).version
}

const COMPLEX = new Set(['string_array', 'number_array', 'questions'])
const INPUT_TYPES: Record<string, string> = { number: 'number', integer: 'number' }

function settingInput(spec: Dict, value: unknown): HTMLInputElement {
  const type = s(spec.type)
  const complex = COMPLEX.has(type)
  const attrs = { id: `set-${s(spec.name)}`, type: INPUT_TYPES[type] ?? 'text', step: 'any', 'data-key': s(spec.name) }
  const input = h(complex ? 'textarea' : 'input', attrs) as HTMLInputElement
  input.value = complex ? JSON.stringify(value) : s(value)
  return input
}

function settingRow(spec: Dict, values: Dict, versions: Dict): HTMLElement[] {
  const name = s(spec.name)
  const input = settingInput(spec, values[name])
  const status = h('span', { class: 'hint', role: 'status' })
  const save = h('button', { 'data-save': name }, 'Сохранить')
  const done = (version: unknown): void => {
    versions[name] = version
    status.textContent = 'Сохранено'
  }
  const failed = (error: unknown): void => {
    status.textContent = describeError(error)
  }
  save.addEventListener('click', () => {
    let body: { value: unknown; base_version: number }
    try {
      body = { value: parseSetting(s(spec.type), input.value), base_version: n(versions[name]) }
    } catch (error) {
      failed(error)
      return
    }
    saveSetting(name, body).then(done, failed)
  })
  return [h('label', { for: `set-${name}` }, name), input, save, status]
}

async function settingsForm(): Promise<HTMLElement> {
  const data = await api('/api/admin/settings')
  const values = dict(data.values)
  const versions = dict(data.versions)
  const box = h('section', { 'data-field': 'settings' }, h('h2', {}, 'Настройки'))
  for (const spec of list(dict(data.schema).keys)) box.append(...settingRow(spec, values, versions))
  return box
}

/** The card as admins got it in Telegram: the text is plain text, the link opens the message. */
function cardView(c: Dict): HTMLElement {
  const link = s(c.link)
  return h(
    'article',
    { 'data-card': s(c.card_id) },
    h('p', { class: 'hint' }, `${s(c.kind)}: ${s(c.status)} ${s(c.delivery)}`),
    h('p', { class: 'quote', 'data-field': 'card_text' }, s(c.text)),
    link.startsWith('https://t.me/') && h('a', { href: link, target: '_blank', rel: 'noopener', 'data-field': 'card_link' }, 'Открыть сообщение'),
  )
}

async function adminScreen(): Promise<Child[]> {
  await api('/api/admin/whoami')
  const [audit, ops, cards, imp, obs, held] = await Promise.all([api('/api/admin/audit'), api('/api/admin/operations'), api('/api/admin/cards'), api('/api/admin/import'), api('/api/admin/observation'), api('/api/admin/held')])
  const file = h('input', { type: 'file', accept: 'application/json', 'aria-label': 'Файл экспорта Telegram Desktop' })
  const importStatus = h('p', { role: 'status', 'data-field': 'import_status' }, dict(imp.job).status ? `Импорт: ${s(dict(imp.job).status)} ${s(dict(imp.job).processed)}/${s(dict(imp.job).total)}` : '')
  const upload = h('button', { class: 'primary', 'data-action': 'import' }, 'Загрузить файл')
  upload.addEventListener('click', () => {
    const chosen = (file as HTMLInputElement).files?.[0]
    if (!chosen) return
    void api('/api/admin/import', { method: 'POST', body: chosen }).then(() => (importStatus.textContent = 'Файл принят, идёт подсчёт.')).catch((e: unknown) => (importStatus.textContent = `Не принят: ${e instanceof ApiError ? s(e.body.error) : 'ошибка'}`))
  })
  const until = h('input', { type: 'text', placeholder: '2026-10-15T12:00:00Z', 'aria-label': 'Продлить наблюдение до' })
  const extend = h('button', { 'data-action': 'observation' }, 'Продлить наблюдение')
  const obsStatus = h('p', { role: 'status', 'data-field': 'observation' }, `Наблюдение до ${s(obs.ends_at)}`)
  extend.addEventListener('click', () => void api('/api/admin/observation', { method: 'POST', body: JSON.stringify({ until: (until as HTMLInputElement).value }) }).then(() => (obsStatus.textContent = 'Продлено')).catch(() => (obsStatus.textContent = 'Не удалось продлить')))
  return [
    h('h1', {}, 'Экран админа'),
    obsStatus, until, extend,
    h('section', { class: 'card' }, h('h2', {}, 'Импорт истории'), h('p', { class: 'hint' }, 'Файл берётся на доверии: совпадение номера чата защищает от ошибки, но не доказывает, что файл настоящий. Берётся окно из настройки import_days (по умолчанию 90 суток), только плюсы.'), file, upload, importStatus),
    h('section', { class: 'card', 'data-field': 'operations' }, h('h2', {}, 'Операции с проблемами'), ...list(ops.operations).map((o) => h('p', {}, `${s(o.operation_kind)}: ${s(o.status)} ${s(o.last_error_code)}`))),
    h('section', { class: 'card', 'data-field': 'held' }, h('h2', {}, 'Убранные сообщения (до 30 суток)'), ...list(held.held).map((m) => h('p', {}, `${s(m.author_name)} (${s(m.reason)}): ${s(m.text)}`))),
    h('section', { class: 'card', 'data-field': 'cards' }, h('h2', {}, 'Карточки'), ...list(cards.cards).map(cardView)),
    await settingsForm(),
    h('section', { class: 'card', 'data-field': 'audit' }, h('h2', {}, 'Журнал изменений'), ...list(audit.audit).map((a) => h('p', { class: 'hint' }, `${s(a.key)}: ${JSON.stringify(a.old_value)} → ${JSON.stringify(a.new_value)}`))),
  ]
}

// ---------------------------------------------------------------- shell

const SCREENS: Record<string, Screen> = {
  lb: () => leaderboardScreen(),
  me: meScreen,
  bans: bansScreen,
  appeal: appealScreen,
  admin: adminScreen,
}
const LABELS: Array<[string, string]> = [['lb', 'Лидерборд'], ['me', 'Я'], ['bans', 'Баня'], ['appeal', 'Разбан'], ['admin', 'Админ']]

let navigated = false

function open(screen: string): void {
  for (const button of Array.from(nav.children)) button.setAttribute('aria-current', String(button.getAttribute('data-screen') === screen))
  void render(SCREENS[screen])
}

/** The appeal tab is for a member with a ban record, the admin tab for an admin of the chat; the rest is for everybody. */
function tabsFor(viewer: Dict): string[] {
  return LABELS.map(([key]) => key).filter((key) => (key !== 'appeal' || viewer.has_ban === true) && (key !== 'admin' || viewer.is_admin === true))
}

function showTabs(viewer: Dict): string[] {
  const tabs = tabsFor(viewer)
  nav.replaceChildren(...LABELS.filter(([key]) => tabs.includes(key)).map(([key, label]) => {
    const button = h('button', { 'data-screen': key }, label)
    button.addEventListener('click', () => {
      navigated = true
      open(key)
    })
    return button
  }))
  return tabs
}

function enter(context: Dict): void {
  const tabs = showTabs(dict(context.viewer))
  if (!navigated) open(tabs.includes(s(context.screen)) ? s(context.screen) : 'lb')
}

function boot(): void {
  webApp?.ready?.()
  webApp?.expand?.()
  void api('/api/context').then(enter).catch((error: unknown) => {
      if (error instanceof ApiError && s(error.body.error) === 'no_context') return void chooseChat()
      void render(async () => [failure(error)])
    })
}

/** Section 3.8: opened without start_param: the member's chats, or the only one at once. */
async function chooseChat(): Promise<void> {
  const chats = await api('/api/chats').then((data) => list(data.chats)).catch((error: unknown) => error)
  if (!Array.isArray(chats)) return void render(async () => [failure(chats)])
  if (chats.length === 1) return enterChat(n(chats[0].chat_id))
  if (chats.length === 0) return void render(async () => [h('p', { class: 'hint', 'data-field': 'no_chats' }, 'Вы пока не участвуете ни в одном чате с Жевчиком.')])
  void render(async () => [
    h('section', { 'data-field': 'chats' }, h('h1', {}, 'Выберите чат'), ...chats.map((chat) => {
      const button = h('button', { 'data-chat-id': s(chat.chat_id) }, s(chat.title))
      button.addEventListener('click', () => enterChat(n(chat.chat_id)))
      return button
    })),
  ])
}

function enterChat(chatId: number): void {
  chosenChat = chatId
  void api('/api/context').then(enter).catch((error: unknown) => void render(async () => [failure(error)]))
}

boot()

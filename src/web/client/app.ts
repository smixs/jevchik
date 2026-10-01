import { juice } from './juice.js'

type Dict = Record<string, unknown>

interface TelegramWebApp {
  initData: string
  ready?: () => void
  expand?: () => void
  setHeaderColor?: (color: string) => void
  setBackgroundColor?: (color: string) => void
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
/** The header with the viewer and the chat; created when the page has none. */
const topBar = document.getElementById('top') ?? document.body.insertBefore(document.createElement('header'), document.body.firstChild)
topBar.id = 'top'

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)
const list = (v: unknown): Dict[] => (Array.isArray(v) ? (v as Dict[]) : [])
const dict = (v: unknown): Dict => (typeof v === 'object' && v !== null ? (v as Dict) : {})
const fmt = (v: unknown): string => n(v).toFixed(2)

const signed = (v: unknown): string => (n(v) > 0 ? `+${fmt(v)}` : fmt(v))

type Child = Node | string | null | undefined | false

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  for (const child of children) if (child) el.append(child)
  return el
}

/** Pixel icons on a 16x16 grid: one string per row, '#' is a filled cell. Static, no data goes into them. */
const ICONS: Record<string, string> = {
  lb: '................|......####......|......####......|......####......|......####......|......####......|.####.####......|.####.####......|.####.####.####.|.####.####.####.|.####.####.####.|.####.####.####.|.####.####.####.|.####.####.####.|................|................',
  me: '................|......####......|.....######.....|.....######.....|.....######.....|.....######.....|......####......|................|....########....|...##########...|..############..|..############..|..############..|..############..|................|................',
  bans: '................|..##...##...##..|...##...##...##.|...##...##...##.|..##...##...##..|.##...##...##...|.##...##...##...|..##...##...##..|...##...##...##.|...##...##...##.|..##...##...##..|.##...##...##...|.##...##...##...|..##...##...##..|................|................',
  appeal: '................|....######......|...########.....|..###....###....|..##......##....|..##......##....|..###....###....|...########.....|....######......|......##........|......##........|......#####.....|......##........|......####......|......##........|................',
  admin: '................|...##...........|..####..........|################|..####..........|...##.......##..|...........####.|################|...........####.|.....##.....##..|....####........|################|....####........|.....##.........|................|................',
  open: '................|.........######.|.........######.|...........####.|..........#####.|.........###.##.|........###..##.|.......###......|.####.###.......|.##....#........|.##.............|.##.......##....|.##.......##....|.##########.....|.#########......|................',
  up: '................|.......##.......|......####......|.....######.....|....########....|...##########...|..############..|......####......|......####......|......####......|......####......|......####......|......####......|......####......|................|................',
  flat: '................|................|................|................|................|................|..############..|..############..|..############..|..############..|................|................|................|................|................|................',
  down: '................|................|......####......|......####......|......####......|......####......|......####......|......####......|......####......|..############..|...##########...|....########....|.....######.....|......####......|.......##.......|................',
  reply: '................|................|.############...|##############..|##..........##..|##..##..##..##..|##..##..##..##..|##..........##..|##############..|.############...|...###..........|...##...........|...#............|................|................|................',
  next: '................|.....##.........|.....###........|......###.......|.......###......|........###.....|.........###....|.........###....|........###.....|.......###......|......###.......|.....###........|.....##.........|................|................|................',
}

/** The cells of a pixel icon as one path: each run of filled cells in a row is one rectangle. */
function pixels(rows: string): string {
  let d = ''
  rows.split('|').forEach((row, y) => {
    for (const run of row.matchAll(/#+/g)) d += `M${run.index} ${y}h${run[0].length}v1h-${run[0].length}z`
  })
  return d
}

function icon(name: string): Node {
  const t = document.createElement('template')
  t.innerHTML = `<svg class="px" viewBox="0 0 16 16" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><path d="${pixels(ICONS[name])}"/></svg>`
  return t.content.firstChild as Node
}

/** A picture of the interface: always with its size and lazy. */
function picture(src: string, cls: string, size: number, alt = ''): HTMLElement {
  return h('img', { class: cls, src, alt, width: String(size), height: String(size), loading: 'lazy', decoding: 'async' })
}

/** The colour of an avatar comes from the member's identifier, so it is the same everywhere. */
function avatar(id: string, name: string, cls = 'ava'): HTMLElement {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  const initial = Array.from(name.trim())[0] ?? '?'
  return h('span', { class: `${cls} c${hash % 8}`, 'data-initial': initial, 'aria-hidden': 'true' })
}

/** An empty state: the mascot and the plain explanation. */
function empty(text: string, attrs: Record<string, string> = {}): HTMLElement {
  const mascot = picture('/img/mascot.webp', 'mascot', 132)
  juice.emptyShown(mascot)
  return h('div', { class: 'empty' }, mascot, h('p', { class: 'hint', ...attrs }, text))
}

/** The mark of a member who writes as a channel; the field may be missing, then it is not a channel. */
function channelMark(item: Dict): Child {
  return item.is_channel === true && h('span', { class: 'chan', 'data-field': 'channel' }, picture('/img/megaphone.webp', 'mega', 18), 'канал')
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
async function render(build: Screen, shown?: () => void): Promise<void> {
  const mine = ++generation
  root.setAttribute('aria-busy', 'true')
  const slow = setTimeout(() => mine === generation && root.replaceChildren(skeleton()), 150)
  let nodes: Child[]
  try {
    nodes = await build()
  } catch (error) {
    nodes = [failure(error)]
  }
  clearTimeout(slow)
  if (mine !== generation) return
  root.replaceChildren(...(nodes.filter(Boolean) as Node[]))
  root.removeAttribute('aria-busy')
  shown?.()
}

function skeleton(): HTMLElement {
  return h('div', { class: 'skel', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'))
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
  const el = h('p', { class: 'error', role: 'alert' }, known ?? BY_STATUS[status] ?? 'Не удалось загрузить данные.')
  juice.failed(el)
  return el
}

// ---------------------------------------------------------------- leaderboard

const PERIODS: Array<[string, string]> = [['week', 'Неделя'], ['month', 'Месяц'], ['all', 'Всё время']]

async function leaderboardScreen(period = 'week'): Promise<Child[]> {
  const data = await api(`/api/leaderboard?period=${period}`)
  return [h('h1', { class: 'titled' }, picture('/img/crown.webp', 'crown', 40), 'Лидерборд'), periodTabs(period), h('div', { class: 'slot' }, board(data))]
}

/** The period switch: the highlight moves at once, only the list below is loaded again. */
function periodTabs(period: string): HTMLElement {
  // the highlight carries its own dark copy of the labels, so the text under it is always readable, even mid-way
  const pill = h('span', { class: 'pill', 'aria-hidden': 'true', style: `--at:${PERIODS.findIndex(([key]) => key === period)}` }, h('span', {}, ...PERIODS.map(([, label]) => h('span', {}, label))))
  const buttons: HTMLElement[] = PERIODS.map(([key, label], index) => {
    const button = h('button', { 'data-period': key, 'aria-current': String(key === period) }, label)
    button.addEventListener('click', () => {
      for (const other of buttons) other.setAttribute('aria-current', String(other === button))
      juice.periodChanged(pill, index)
      void showPeriod(key)
    })
    return button
  })
  return h('div', { class: 'tabs', role: 'tablist' }, pill, ...buttons)
}

async function showPeriod(period: string): Promise<void> {
  const slot = root.querySelector('.slot')
  if (!slot) return render(() => leaderboardScreen(period))
  const mine = ++generation
  slot.setAttribute('aria-busy', 'true')
  let node: HTMLElement
  try {
    node = board(await api(`/api/leaderboard?period=${period}`))
  } catch (error) {
    node = failure(error)
  }
  if (mine !== generation) return
  slot.replaceChildren(node)
  slot.removeAttribute('aria-busy')
}

function board(data: Dict): HTMLElement {
  const rows = list(data.rows).map((row) => {
    const who = h('span', { class: 'who' }, h('span', { class: 'name' }, s(row.name)), channelMark(row))
    const button = h('button', { class: `row${row.is_me ? ' me' : ''}`, 'data-public-id': s(row.public_id) }, place(n(row.place)), avatar(s(row.public_id), s(row.name)), who, h('span', { class: 'num' }, fmt(row.karma)))
    button.addEventListener('click', () => {
      juice.pageOpened()
      void render(() => pageScreen(s(row.public_id)), () => juice.pageShown(root))
    })
    return h('li', {}, button)
  })
  if (!rows.length) return empty('За этот период пока никого нет.')
  const ol = h('ol', { class: 'board', 'data-testid': 'leaderboard' }, ...rows)
  juice.listShown(ol)
  return ol
}

/** The first three places get a medal; the number stays for screen readers. */
function place(at: number): HTMLElement {
  if (at < 1 || at > 3) return h('span', { class: 'place' }, String(at))
  return h('span', { class: 'place' }, picture(`/img/medal-${at}.webp`, 'medal', 48), h('span', { class: 'sr-only' }, String(at)))
}

// ---------------------------------------------------------------- personal page

function chartSvg(points: Dict[]): HTMLElement | null {
  if (points.length < 2) return null
  const values = points.map((p) => n(p.karma))
  const min = Math.min(...values)
  const span = Math.max(...values) - min || 1
  const step = 300 / (points.length - 1)
  const path = values.map((v, i) => `${(i * step).toFixed(1)},${(112 - ((v - min) / span) * 104).toFixed(1)}`).join(' ')
  const t = document.createElement('template')
  t.innerHTML =
    '<svg class="chart" viewBox="0 0 300 120" preserveAspectRatio="none" role="img" aria-label="График кармы">' +
    '<defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".38"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>' +
    `<polygon fill="url(#chart-fill)" points="0,120 ${path} 300,120"/>` +
    `<polyline fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="${path}"/></svg>`
  return h('div', { class: 'card chartbox' }, t.content.firstChild)
}

function stat(field: string, label: string, value: string, mark: Child): HTMLElement {
  return h('div', { class: 'stat', 'data-field': field }, mark, h('b', {}, value), h('span', {}, label))
}

/** A voxel picture in the corner of a tile. */
const badge = (name: string): HTMLElement => picture(`/img/${name}.webp`, 'ico', 36)

/** The weekly change gets a pixel arrow: up for a gain, down for a loss, a bar for none. */
function trend(delta: number): HTMLElement {
  const [cls, name] = delta > 0 ? ['rise', 'up'] : delta < 0 ? ['fall', 'down'] : ['flat', 'flat']
  return h('i', { class: `ico ${cls}` }, icon(name))
}

function messageCard(m: Dict): HTMLElement {
  const link = s(m.link)
  const meta = h('p', { class: 'meta' }, h('span', { 'aria-label': 'Карма' }, icon('up'), signed(m.karma)), h('span', { 'aria-label': 'Ответы' }, icon('reply'), s(n(m.replies))))
  return h('li', { class: 'card msg' }, h('p', { class: 'excerpt' }, s(m.excerpt)), meta, link ? h('a', { class: 'btn', href: link, rel: 'noopener' }, icon('open'), 'Открыть в чате') : null)
}

function messageBlock(title: string, field: string, items: Dict[]): HTMLElement {
  const cards = items.map(messageCard)
  return h('section', { 'data-field': field }, h('h2', {}, title), cards.length ? h('ul', { class: 'msgs' }, ...cards) : h('p', { class: 'hint' }, 'Пока пусто.'))
}

function statsGrid(page: Dict): HTMLElement {
  const karma = stat('karma', 'Карма', fmt(page.karma), badge('star'))
  juice.numberShown(karma.querySelector('b') as HTMLElement, n(page.karma), fmt)
  return h('div', { class: 'grid' },
    karma,
    stat('place', 'Место', s(page.place) || '-', badge('trophy')),
    stat('week_delta', 'За неделю', fmt(page.week_delta), trend(n(page.week_delta))),
    stat('thanks_count', 'Благодарности', s(page.thanks_count), badge('heart')),
    stat('answers_count', 'Ответы на вопросы', s(page.answers_count), badge('bubble')),
    stat('caught_spammers_count', 'Пойманные спамеры', s(page.caught_spammers_count), badge('shield')),
    stat('streak_weeks', 'Серия недель', s(page.streak_weeks), badge('flame')),
  )
}

function decayNote(warning: Dict): HTMLElement | null {
  if (!warning.starts_at) return null
  return h('p', { class: 'error', 'data-field': 'decay_warning' }, `Карма начнёт убывать ${new Date(s(warning.starts_at)).toLocaleDateString('ru-RU')}: напишите в чат.`)
}

function hideButton(page: Dict): HTMLElement {
  const button = h('button', { class: 'secondary', 'data-action': 'hide' }, page.hidden ? 'Показать мою страницу' : 'Скрыть мою страницу')
  button.addEventListener('click', () => void api('/api/me/hide', { method: 'POST', body: JSON.stringify({ hidden: !page.hidden }) }).then(() => render(meScreen)).catch((e: unknown) => render(async () => [failure(e)])))
  return button
}

function pageView(page: Dict, self: boolean): Child[] {
  const messages = dict(page.messages)
  return [
    h('div', { class: 'title' }, h('h1', {}, s(page.name) || 'Моя страница'), channelMark(page)),
    page.empty ? empty('Здесь появятся ваши цифры, когда вы напишете в чате и получите первые оценки.') : null,
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
    h(
      'article',
      { class: 'card ban-card', 'data-ban-id': s(b.id) },
      picture(s(b.image), 'ban', 80),
      h('div', { class: 'body' }, h('h2', {}, s(b.name)), h('p', { 'data-field': 'category' }, s(b.category_title)), h('p', { class: 'hint', 'data-field': 'explanation' }, s(b.explanation)), h('p', { class: 'hint' }, new Date(s(b.date)).toLocaleDateString('ru-RU'))),
    ),
  )
  return [h('h1', {}, 'Баня'), ...(cards.length ? cards : [empty('В бане пусто.')])]
}

const APPEAL_TEXT: Record<string, string> = {
  rejected: 'Объяснение не убедило. Попытка была одна.',
  review: 'Объяснение передано админам, ждите решения.',
  not_allowed: 'Повторное попадание в баню: разбан через приложение недоступен.',
  no_ban: 'Вас нет в бане.',
  pending: 'Объяснение уже проверяется.',
  try_later: 'Не получилось, попробуйте позже.',
}

/** Each answer to the appeal feels different; only a lifted ban is celebrated. */
function appealFeel(status: string, lifted: boolean, button: HTMLElement, result: HTMLElement): void {
  if (status === 'accepted') return lifted ? juice.appealLifted(button, result) : juice.appealAccepted(result)
  if (status === 'rejected' || status === 'not_allowed') return juice.appealRefused(result)
  if (status === 'try_later') return juice.failed(result)
  juice.appealWaiting(result)
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
        appealFeel(status, r.lifted === true, send, result)
      })
      .catch((error: unknown) => {
        result.textContent = error instanceof ApiError && error.status === 422 ? 'Напишите от 1 до 500 знаков.' : 'Не получилось, попробуйте позже.'
        juice.failed(result)
      })
  })
  const blocked = state.status !== 'none' || state.allowed === false
  return [h('h1', {}, 'Разбан'), h('section', { class: 'card' }, h('p', { class: 'hint' }, 'Одна попытка. Своими словами: почему вы в этом чате и что произошло.'), blocked ? h('p', { 'data-field': 'appeal_state' }, APPEAL_TEXT[s(state.status)] ?? 'Разбан недоступен.') : start, area, send, result)]
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
    juice.saved(status)
  }
  const failed = (error: unknown): void => {
    status.textContent = describeError(error)
    juice.failed(status)
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
  return [h('div', { class: 'setting' }, h('label', { for: `set-${name}` }, name), input, save, status)]
}

async function settingsForm(): Promise<HTMLElement> {
  const data = await api('/api/admin/settings')
  const values = dict(data.values)
  const versions = dict(data.versions)
  const box = h('section', { class: 'card', 'data-field': 'settings' }, h('h2', {}, 'Настройки'))
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
    link.startsWith('https://t.me/') && h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener', 'data-field': 'card_link' }, icon('open'), 'Открыть сообщение'),
  )
}

async function adminScreen(): Promise<Child[]> {
  await api('/api/admin/whoami')
  const [audit, ops, cards, imp, obs, held] = await Promise.all([api('/api/admin/audit'), api('/api/admin/operations'), api('/api/admin/cards'), api('/api/admin/import'), api('/api/admin/observation'), api('/api/admin/held')])
  const file = h('input', { type: 'file', accept: 'application/json', 'aria-label': 'Файл экспорта Telegram Desktop', class: 'sr-only' }) as HTMLInputElement
  const chosenName = h('span', { class: 'hint' }, 'Файл не выбран')
  file.addEventListener('change', () => (chosenName.textContent = file.files?.[0]?.name ?? 'Файл не выбран'))
  const picker = h('label', { class: 'file' }, file, h('span', { class: 'btn' }, 'Выбрать файл'), chosenName)
  const importStatus = h('p', { role: 'status', 'data-field': 'import_status' }, dict(imp.job).status ? `Импорт: ${s(dict(imp.job).status)} ${s(dict(imp.job).processed)}/${s(dict(imp.job).total)}` : '')
  const upload = h('button', { class: 'primary', 'data-action': 'import' }, 'Загрузить файл')
  upload.addEventListener('click', () => {
    const chosen = file.files?.[0]
    if (!chosen) return
    void api('/api/admin/import', { method: 'POST', body: chosen })
      .then(() => {
        importStatus.textContent = 'Файл принят, идёт подсчёт.'
        juice.saved(importStatus)
      })
      .catch((e: unknown) => {
        importStatus.textContent = `Не принят: ${e instanceof ApiError ? s(e.body.error) : 'ошибка'}`
        juice.failed(importStatus)
      })
  })
  const until = h('input', { type: 'text', placeholder: '2026-10-15T12:00:00Z', 'aria-label': 'Продлить наблюдение до' })
  const extend = h('button', { 'data-action': 'observation' }, 'Продлить наблюдение')
  const obsStatus = h('p', { role: 'status', 'data-field': 'observation' }, `Наблюдение до ${s(obs.ends_at)}`)
  extend.addEventListener('click', () =>
    void api('/api/admin/observation', { method: 'POST', body: JSON.stringify({ until: (until as HTMLInputElement).value }) })
      .then(() => {
        obsStatus.textContent = 'Продлено'
        juice.saved(obsStatus)
      })
      .catch(() => {
        obsStatus.textContent = 'Не удалось продлить'
        juice.failed(obsStatus)
      }),
  )
  return [
    h('h1', {}, 'Экран админа'),
    h('section', { class: 'card' }, obsStatus, h('div', { class: 'row2' }, until, extend)),
    h('section', { class: 'card' }, h('h2', {}, 'Импорт истории'), h('p', { class: 'hint' }, 'Файл берётся на доверии: совпадение номера чата защищает от ошибки, но не доказывает, что файл настоящий. Берётся окно из настройки import_days (по умолчанию 90 суток), только плюсы.'), picker, upload, importStatus),
    h('section', { class: 'card list', 'data-field': 'operations' }, h('h2', {}, 'Операции с проблемами'), ...list(ops.operations).map((o) => h('p', {}, `${s(o.operation_kind)}: ${s(o.status)} ${s(o.last_error_code)}`))),
    h('section', { class: 'card list', 'data-field': 'held' }, h('h2', {}, 'Убранные сообщения (до 30 суток)'), ...list(held.held).map((m) => h('p', {}, `${s(m.author_name)} (${s(m.reason)}): ${s(m.text)}`))),
    h('section', { class: 'card', 'data-field': 'cards' }, h('h2', {}, 'Карточки'), ...list(cards.cards).map(cardView)),
    await settingsForm(),
    h('section', { class: 'card list', 'data-field': 'audit' }, h('h2', {}, 'Журнал изменений'), ...list(audit.audit).map((a) => h('p', { class: 'hint' }, `${s(a.key)}: ${JSON.stringify(a.old_value)} → ${JSON.stringify(a.new_value)}`))),
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
    const button = h('button', { 'data-screen': key }, icon(key), h('span', {}, label))
    button.addEventListener('click', () => {
      navigated = true
      juice.tabChanged()
      open(key)
    })
    return button
  }))
  return tabs
}

/** The header: the viewer's initial, name and karma, and the chat. */
function showHeader(context: Dict): void {
  const viewer = dict(context.viewer)
  const name = s(viewer.name)
  const karma = h('span', { class: 'karma', 'aria-label': `Карма ${signed(viewer.karma)}` }, signed(viewer.karma))
  juice.numberShown(karma, n(viewer.karma), signed)
  topBar.replaceChildren(avatar(s(viewer.public_id) || name, name, 'ava big'), h('div', { class: 'who' }, h('b', {}, name), h('span', {}, s(dict(context.chat).title))), karma)
  topBar.removeAttribute('hidden')
}

function enter(context: Dict): void {
  showHeader(context)
  const tabs = showTabs(dict(context.viewer))
  if (!navigated) open(tabs.includes(s(context.screen)) ? s(context.screen) : 'lb')
}

/** Telegram's own header and background take the colour of the page, when this Telegram can do it. */
function paintTelegram(): void {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  if (!bg) return
  try {
    webApp?.setHeaderColor?.(bg)
    webApp?.setBackgroundColor?.(bg)
  } catch {
    // an old Telegram without these methods keeps its own colours
  }
}

function boot(): void {
  juice.install()
  webApp?.ready?.()
  webApp?.expand?.()
  paintTelegram()
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
  if (chats.length === 0) return void render(async () => [empty('Вы пока не участвуете ни в одном чате с Жевчиком.', { 'data-field': 'no_chats' })])
  void render(async () => [
    h('section', { 'data-field': 'chats' }, picture('/img/mascot.webp', 'mascot', 132), h('h1', {}, 'Выберите чат'), ...chats.map((chat) => {
      const button = h('button', { 'data-chat-id': s(chat.chat_id) }, h('span', {}, s(chat.title)), icon('next'))
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

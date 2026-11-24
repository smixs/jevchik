import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_PERMISSIONS } from '../src/ops.js'
import { hasSpamPhrase } from '../src/stop-phrases.js'
import { ADMIN, CAROL, CHAT, createHarness, message, pastObservation, type Harness } from './support/harness.js'

/** Spam the admins removed by hand in October while Jev scored it from 0.10 to 0.57 (texts from production). */
const SPAM = [
  'Есть минутное дело,деньги сразу по окончании, кто свободен?',
  'Есть минутное дело, кто свободен?',
  'Деньги сразу по окончании, кто свободен?',
  'Новый варик поднять кеша Залетай всему обучаем 4 места',
  'Новый варик поднять кеша',
  'Всему обучаем',
  'Залетай, 4 места',
  'Есть обучение, залетай',
  'Залетай за деньгами',
  '💼🔆🔆🔆🔆🔆🔆💼 🇹🇭🔆🔆🔆🔆🔆🔆🔆🇹🇭 ✅🔆🔆 1️⃣0️⃣0️⃣0️⃣😄 🔆 🔆🔆🔆🔆🔆🔆 ✅3️⃣➖5️⃣ 🔆🔆🔆🔆🔆 ✅🔆🔆🔆🔆🔆 🔆🔆🔆🔆🔆🔆🔆 🔆🔆🔆🔆👇🏻 https://t.me/m/TkRE2PiyZTll',
  'Покупаю юсдт сегодня',
  'Куплю USDT срочно',
  'Может у кого есть юсдт',
  'Куплю u.s.d.t, при личной встрече. Курс обговариваем.',
  'Дам 0.5 на пробу любого товара',
  'Раздача новой партии 0.5 первым 10 людям',
  'Дам бабок и стафф на выбор  , поспеши мест всего 6',
  'Можно в zarub_robot карту купить для зарубежных оплат. Сам пользуюсь, удобный сервис.',
  'Добрый день, если честно , то нужен муж на час, помочь сделать небольшую перестановку в кв. Отозвавшемуся от меня 6000руб и ужин ))',
  'Доброго времени суток ! Нужен доброволец помочь сделать небольшую перестановочку ) От себя даю 5000 и обед / ужин )',
  'Есть небольшое дельце на сегодня, нужен человек,отплачу достойно',
  'Кто сейчас на связи? Появилoсь одно несложное дело,деньги отдам по завершению',
  'Кто сможет пoмочь по однoму-делу? Расчет на месте,отпишите в-лс',
  'Нарисовалось несложное дело,плaчу сразу по факту. Кто не занят?',
  'Добрый вечер. Есть работа на час - полтора за 4000, пишите',
  'Перенести шифер с пола на крышу, по оплате не обижу, срочно пару парней',
  'Требуются помощники на оформления зала Украсить, позже убраться За смену 8000',
  'Ищу USDT TRC20, объём до 36k',
  'Кто может продать немного юсдт',
  'Сортировка товаров по категориям. 6000 на руки. С 09:00–15:00.',
  'Заработок',
  'Помочь перенести стройматериалы, 5500. Пиши в лс',
]

/** Exact texts of the monitor for 31.10–01.11; the emoji message was already caught on Ora. */
const NOVEMBER_SPAM = [
  '‼️ Чат переносится в новую группу. Нажмите на этот текст, чтобы перейти в неё. 💬 Затем нажмите кнопку Начать, чтобы присоединиться к группе.',
  'Помощник на съёмочной площадке 2300 за выход. Подавать реквизит, переносить лёгкие вещи между зонами и после съёмки всё собрать. Занятость около 3 часов. Перед началом распределят задачи. Пиши + в лс.',
  ' Hужно вынести строительный мусор из квартиры в контейнер во дворе, 2 часа, 3000р',
  'Ищу водителей и людей на передвижение внутри и между городами. Направление связано с передачей документации по разным адресам. География - вся страна',
  'Нужно подготовить погреб к зиме, выкинуть всё не нужное и занести свежие овощи, по оплате договоримся по факту',
  '💼◻️◻️◻️◻️◻️◻️💼 🇹🇭◻️◻️◻️◻️◻️◻️◻️🇹🇭 ✅◻️◻️ ◻️◻️◻️◻️😄 ◻️ ◻️◻️◻️◻️◻️◻️ ✅◻️✨◻️ ◻️◻️◻️◻️◻️ ✅◻️◻️◻️◻️◻️ ◻️◻️◻️◻️◻️◻️◻️ ◻️◻️◻️◻️👇🏻 https://t.me/m/XIfWeDExZDE1',
]

const NOVEMBER_PHRASES = [
  'Чат переносится в новую группу',
  'Нажмите кнопку Начать',
  '2300 за выход',
  'За выход 2300 рублей',
  'Пиши + в лс',
  'Помощник на съёмочной площадке',
  'Вынос мусора, 3000 руб.',
  '3000 р за то, чтобы вынести мусор',
  'Ищу водителей для передачи документации',
  'По оплате договоримся по факту',
  'Нужно подготовить погреб к зиме',
]

const NOVEMBER_PLAIN = [
  'пиши в лс',
  'Напиши в лс после созвона',
  'сколько за выход на конференцию?',
  'вынести обсуждение в отдельный чат',
  'водителей такси жалко',
  'договоримся по созвону',
  'Вынести мусор после ремонта',
  'Купил билет за 3000 руб.',
  'Ищу водителей такси для интервью',
  'Передача документации заказчику',
  'За выход на конференцию дали 2 балла',
  'За 3000 руб. пиши в лс про конференцию',
]

/** Decision of 02.11: work bait and a private-message invitation in the same message. */
const NOVEMBER_2_SPAM = [
  'ИПАНЫЕ ДОЛГИ И НЕХВАТКИ. Есть тема в сфере с гибким графиком, оффлайн, 0 вложений, звонков и встреч! Обращайся в личные прямо сейчас, расскажу подробнее!',
  'Гибкий график. Пиши в лс',
  'Напиши в личные, у нас гибким графиком удобно работать',
  '0 вложений! Обращайся',
  'Без вложений. Напиши в личку',
  'Есть тема в сфере услуг. Пиши в ЛС',
  'Есть тема. Обращайся в личные',
  'ГИБКИЙ ГРАФИК. ОБРАЩАЙСЯ В ЛИЧНЫЕ',
  'Гибkий грaфик. Нaпиши в личныe',
  'Пиши в-лс! Без вложений',
  'Гибкий график\nПиши в личку',
  'Заработай 500 долларов в день без вложений, пиши в личку!',
]

const NOVEMBER_2_PLAIN = [
  'пиши в лс',
  'есть тема для обсуждения, обращайся в личку, скину ссылку на доклад',
  'у нас гибкий график на работе',
  'без вложений в проект не обойтись',
  'Есть тема для обсуждения, пиши в лс',
  'Есть тема доклада, пиши в личные',
  'Обращайся, скину ссылку на доклад',
  'Есть тема в сфере услуг',
  '0 вложений',
  'Гибкий график, напиши в общий чат',
  'Гибкий график. Напиши тесты',
  'Есть тема для обсуждения',
  'Отчёт: 10 вложений. Пиши в лс',
  'Это небезвложений, напиши в лс',
]

/** Decision of 16.11: the exact text of the monitor (Anita, 15.11 10:50, Jev 0.91, banned by hand) and its close variants. */
const ANITA = 'НЕТУ ДЕНЕГ?? ПИШИ МНЕ !'
const NOVEMBER_16_SPAM = [
  ANITA,
  'Нету денег? Пиши мне',
  'нет денег?? пиши мне!!',
  'НЕТ ДЕНЕГ??\nПИШИ МНЕ',
  'Нет денег? 💸 Напиши мне',
  'Нет денег? Тогда пиши мне в личку',
  'Не хватает денег? Пиши в лс',
  'Нужны деньги? Пишите мне',
  'Денег нет? Обращайся в личку',
  'НЕТУ ДEНEГ?? ПИШИ MНЕ !',
  'HETY ДЕНЕГ?? ПИШИ MHE !',
  'Нету-денег? Пиши-мне',
  'Пиши мне, если нет денег',
  'Напиши в лс, если нужны деньги!',
]

const NOVEMBER_16_PLAIN = [
  'пиши мне',
  'Пиши мне, если что',
  'Напиши мне в личку, скину конфиг',
  'Нет денег на подписку, пиши мне если найдёшь промокод',
  'Пиши мне, если нужны деньги на сервер, скинемся',
  'Денег нет, но вы держитесь',
  'Нет денег — нет проблем',
  'нет денег? пиши код сам',
  'на Claude нет денег, пишу код руками',
  'Нужны деньги на сервер, скинемся?',
  'Монет денег не заменят, напиши мне',
  'No money? Write me',
]

/** REVISE F1 of 17.11: everyday speech with the money words and «пиши мне» plus other words, and quotes of the bait. */
const NOVEMBER_16_CRITIC_PLAIN = [
  'У меня сейчас нет денег, пиши мне завтра, обсудим покупку билета.',
  'У меня нет денег. Пиши мне по работе сюда, телефон потерял.',
  'Он мне написал: «Нету денег?? Пиши мне!». Похоже, мошенник.',
  'Не верьте сообщениям «Нету денег? Пиши мне», это развод.',
  'На аренду нужны деньги, напиши мне сумму в личку, скинемся.',
  'Денег нет, пиши мне, когда появится бесплатная версия.',
  'Пиши мне, если нужны деньги. Помогу оплатить лечение кота.',
  'У меня нет денег, пиши мнение о бесплатных курсах здесь.',
  'Нет денег, пиши мне завтра',
]

/** REVISE F2 of 17.11: money emoji and long punctuation between the bait and the invitation do not hide it. */
const MONEY_EMOJI = ['💸', '💰', '🤑', '💵', '💶', '💷', '💴', '🪙', '💲', '💳']
const NOVEMBER_16_GAPS = [
  'НЕТУ ДЕНЕГ??? 💸💸💸💸 ПИШИ МНЕ!',
  'НЕТУ ДЕНЕГ???????????? ПИШИ МНЕ!',
  ...MONEY_EMOJI.map((emoji) => `НЕТУ ДЕНЕГ??? ${emoji.repeat(4)} ПИШИ МНЕ!`),
  ...MONEY_EMOJI.map((emoji) => `${emoji} Нет денег? ${emoji} Пиши мне в личку ${emoji}`),
  // Boundary of the old limit of 12 UTF-16 units: 12 and 13 units, then far beyond.
  `Нет денег${'?'.repeat(12)}пиши мне`,
  `Нет денег${'?'.repeat(13)}пиши мне`,
  `Нет денег ${'💸'.repeat(40)}\n\n${'!'.repeat(100)} пиши мне`,
]

/** Retold messages of members with karma and of what the admins marked «не спам». */
const PLAIN = [
  'https://t.me/m/TkRE2PiyZTll',
  't.me/m/x',
  'так я вижу пользователей Orca',
  'залетай на созвон завтра?',
  'Залетай, обсудим модель',
  'минутная делегация',
  'поднять кеширование запросов',
  'Начинается обучение работе с моделью',
  'Вот ссылка на сообщение 💼🔆🔆 https://t.me/m/TkRE2PiyZTll',
  `${'🔆'.repeat(150)} https://example.com/m/test`,
  `${'🔆'.repeat(150)} https://not-t.me/m/test`,
  `${'🔆'.repeat(150)} https://t.me/channel/test`,
  `${'1'.repeat(150)} https://t.me/m/test`,
  'Нашёл на маркетплейсе подписку на год за 340 рублей, кто-нибудь брал?',
  'У меня 114 в день рекорд',
  'В стиме это по 200 рублей продают',
  'Столько бабок на генерацию картинок ушло, жалею',
  'в этом чате и за 0 рублей много полезного',
  'бот, перестановку в бане сделать не хочешь?',
  'ещё одну модель на пробу брал, не зашла',
  'Привет! Сделал бота с мини-игрой внутри, хочу фидбек по физике',
  'Можно устроить баттл: человек против модели, победитель забирает банк',
  'Аттракцион неслыханной щедрости?',
  'сделала себе сайт-визитку',
  'заработать на агентах пока не вышло',
  // Review before the release: ordinary first questions of a newcomer.
  'Задам вопрос: кто пробовал Cursor?',
  'Задаю вопрос, кто пробовал claude code',
  'Дам совет: попробуй Claude',
  'Даю ссылку, попробуйте',
  'Работаю на аутстаффе, ищу аутстафф',
  'лимит 1000 в день',
  '1 500 в день токенов',
  'плата за смену тарифа',
  'Это несложно делается через API',
  'Как принимать оплату в USDT?',
  'небольшие дела делаю агентом',
]

describe('section 3.6.7: the phrases of hand-removed spam', () => {
  it.each(SPAM)('caught: %s', (text) => {
    expect(hasSpamPhrase(text)).toBe(true)
  })

  it.each([...NOVEMBER_SPAM, ...NOVEMBER_PHRASES])('01.11: caught: %s', (text) => {
    expect(hasSpamPhrase(text)).toBe(true)
  })

  it.each(NOVEMBER_PLAIN)('01.11: ordinary speech stays: %s', (text) => {
    expect(hasSpamPhrase(text)).toBe(false)
  })

  it.each(NOVEMBER_2_SPAM)('02.11: caught: %s', (text) => {
    expect(hasSpamPhrase(text)).toBe(true)
  })

  it.each(NOVEMBER_2_PLAIN)('02.11: ordinary speech stays: %s', (text) => {
    expect(hasSpamPhrase(text)).toBe(false)
  })

  it.each(NOVEMBER_16_SPAM)('16.11: caught: %s', (text) => {
    expect(hasSpamPhrase(text)).toBe(true)
  })

  it.each(NOVEMBER_16_PLAIN)('16.11: ordinary speech stays: %s', (text) => {
    expect(hasSpamPhrase(text)).toBe(false)
  })

  it.each(NOVEMBER_16_CRITIC_PLAIN)('16.11 F1: everyday speech and quotes of the bait stay: %s', (text) => {
    expect(hasSpamPhrase(text)).toBe(false)
  })

  it.each(NOVEMBER_16_GAPS)('16.11 F2: caught whatever the gap of emoji and punctuation: %s', (text) => {
    expect(hasSpamPhrase(text)).toBe(true)
  })

  it('16.11 F2: a word in the gap keeps the message ordinary, an emoji does not', () => {
    expect(hasSpamPhrase('НЕТУ ДЕНЕГ??? 💸💸💸💸 ПИШИ МНЕ!')).toBe(true)
    expect(hasSpamPhrase('НЕТУ ДЕНЕГ??? 💸 завтра 💸 ПИШИ МНЕ!')).toBe(false)
  })

  it('counts the inclusive 70% boundary in visible symbols, including keycaps; the URL is checked separately', () => {
    // Seven emoji and three letters = 70%; six emoji and three letters = below 70%.
    for (const emoji of ['🔆', '◻️', '3️⃣', '🇹🇭', '👇🏻', '👨‍👩‍👧‍👦']) {
      expect(hasSpamPhrase(`${emoji.repeat(7)} abc t.me/m/x`)).toBe(true)
      expect(hasSpamPhrase(`${emoji.repeat(6)} abc t.me/m/x`)).toBe(false)
    }
  })

  it.each(PLAIN)('not caught: %s', (text) => {
    expect(hasSpamPhrase(text)).toBe(false)
  })
})

describe('section 3.6.7: a phrase in an early message sends the author to the steam room whatever Jev says', () => {
  let h: Harness
  const TEXT = 'Куплю USDT срочно'
  const chatCalls = (): unknown[][] =>
    h.tg.calls.filter((c) => ['deleteMessage', 'restrictChatMember'].includes(c.method) && c.args[0] === CHAT).map((c) => [c.method, ...c.args])

  beforeEach(async () => {
    h = await createHarness()
    h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
    await pastObservation(h)
    h.jev.script(TEXT, { spam_other_offer: 0.1 })
  })
  afterEach(async () => {
    await h.close()
  })

  it('a newcomer: the message is deleted, the author restricted, the joke is the usual one with the button', async () => {
    await h.send(message({ id: 700, from: CAROL, text: TEXT }))
    await h.app.settle()
    expect(chatCalls()).toEqual([
      ['deleteMessage', CHAT, 700],
      ['restrictChatMember', CHAT, CAROL.id, NO_PERMISSIONS, undefined],
    ])
    const joke = h.tg.of('sendMessage').find((c) => c.args[0] === CHAT)!
    expect(joke.args[1]).not.toBe('тут был Стас пидорас')
    expect(joke.args[2]).toEqual([[{ text: 'Я не спамер', url: `https://t.me/jevchik_bot?startapp=appeal_${CHAT}` }]])
    expect(await h.db.query('SELECT state FROM bans')).toEqual([{ state: 'steam' }])
  })

  it.each([SPAM[0], SPAM[3], SPAM[9]])('31.10: a low-score report example is sanctioned through the pipeline: %s', async (text) => {
    h.jev.script(text, { spam_other_offer: 0.1 })
    await h.send(message({ id: 700, from: CAROL, text }))
    await h.app.settle()
    expect(chatCalls()).toEqual([
      ['deleteMessage', CHAT, 700],
      ['restrictChatMember', CHAT, CAROL.id, NO_PERMISSIONS, undefined],
    ])
    expect(await h.db.query('SELECT state FROM bans')).toEqual([{ state: 'steam' }])
  })

  it.each([...NOVEMBER_SPAM, ...NOVEMBER_2_SPAM, ANITA, NOVEMBER_16_GAPS[0]])('01–16.11: a low-score report example is deleted and restricted: %s', async (text) => {
    h.jev.script(text, { spam_other_offer: 0.1 })
    await h.send(message({ id: 700, from: CAROL, text }))
    await h.app.settle()
    expect(chatCalls()).toEqual([
      ['deleteMessage', CHAT, 700],
      ['restrictChatMember', CHAT, CAROL.id, NO_PERMISSIONS, undefined],
    ])
    expect(await h.db.query('SELECT state FROM bans')).toEqual([{ state: 'steam' }])
  })

  it.each([...NOVEMBER_PLAIN.slice(0, 6), ...NOVEMBER_2_PLAIN, ...NOVEMBER_16_PLAIN.slice(0, 4), ...NOVEMBER_16_CRITIC_PLAIN])('01–16.11: ordinary speech with a low score gets no sanction: %s', async (text) => {
    h.jev.script(text, { spam_other_offer: 0.1 })
    await h.send(message({ id: 700, from: CAROL, text }))
    await h.app.settle()
    expect(chatCalls()).toEqual([])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
  })

  it('a member past the first messages is not touched', async () => {
    for (let i = 0; i < 5; i++) await h.send(message({ id: 600 + i, from: CAROL, text: `обычное сообщение ${i}` }))
    await h.app.settle()
    h.tg.calls.length = 0
    await h.send(message({ id: 700, from: CAROL, text: TEXT }))
    await h.app.settle()
    expect(chatCalls()).toEqual([])
  })

  it('karma at protect_threshold shields the member, unlike the stop word', async () => {
    await h.send(message({ id: 600, from: CAROL, text: 'привет' }))
    await h.app.settle()
    await h.db.query('UPDATE members SET karma = 100 WHERE user_id = $1', [CAROL.id])
    h.tg.calls.length = 0
    await h.send(message({ id: 700, from: CAROL, text: TEXT }))
    await h.app.settle()
    expect(chatCalls()).toEqual([])
  })
})

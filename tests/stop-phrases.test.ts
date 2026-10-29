import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_PERMISSIONS } from '../src/ops.js'
import { hasSpamPhrase } from '../src/stop-phrases.js'
import { ADMIN, CAROL, CHAT, createHarness, message, pastObservation, type Harness } from './support/harness.js'

/** Spam the admins removed by hand in October while Jev scored it from 0.10 to 0.57 (texts from production). */
const SPAM = [
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

/** Retold messages of members with karma and of what the admins marked «не спам». */
const PLAIN = [
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
  // ordinary first questions of a newcomer.
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

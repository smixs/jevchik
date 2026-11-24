/**
 * The words that send the author of an early message to the steam room whatever Jev says: the stop word of section 3.6.6 and,
 * since the decision of the owner 29.10, the phrases of spam the admins removed by hand while Jev scored it below the threshold
 * (section 3.6.7).
 */

import { hasEmoji } from './text.js'

/** Section 3.6.6: the stop word in the text, the caption, or the address of a hidden link. */
const STOP_WORD = /polzastas/i

export function namesStopWord(text: string, linkUrls: string[]): boolean {
  return STOP_WORD.test(text) || linkUrls.some((url) => STOP_WORD.test(url))
}
/** A word starts here: JavaScript `\b` does not know Cyrillic letters. */
const W = '(?<![а-яёa-z0-9])'

const PHRASES: RegExp[] = [
  // Buying and selling crypto: «Куплю USDT срочно», «Может у кого есть юсдт», «Ищу USDT TRC20»; «оплата в USDT» is not an offer.
  new RegExp(`${W}(?:куп|покуп|прода|возьм|обменя|есть|ищу)[^.!?\\n]{0,30}(?:usdt|юсдт|u\\.s\\.d\\.t)`),
  // Drugs: «Дам 0.5 на пробу», «Раздача новой партии 0.5», «Дам бабок и стафф на выбор».
  new RegExp(`${W}(?:дам|даю)\\s[^!?\\n]{0,25}${W}проб|${W}проб[уы]\\s*0[.,]5|партии\\s*0[.,]5|${W}стафф|${W}дам\\s+бабок`),
  // The card for foreign payments advertised by one network of accounts.
  /zarub/,
  // A paid errand: «нужен муж на час», «работа на час», «одно несложное дело», «небольшая халтурка», «от себя даю 5000».
  new RegExp(`муж\\s+на\\s+час|${W}работа\\s+на\\s+час|(?:несложн|небольш)\\S*\\s+(?:дело|делу|дельце)(?![а-яё])|по\\s+одному\\s+делу|халтурк|от\\s+себя\\s+даю`),
  // The pay is named before the job: «6000 на руки», «за смену 8000», «плачу сразу», «отплачу достойно».
  new RegExp(`\\d[\\s.]?\\d{3}\\s*(?:р\\S*\\s+)?на\\s+руки|за\\s+смену\\s*\\d|${W}плачу\\s+сразу|${W}отплачу|деньги\\s+отдам|по\\s+оплате\\s+не\\s+обижу|расч[её]т\\s+на\\s+месте`),
  // Decisions of 31.10: short paid errands and cash/training bait.
  new RegExp(`${W}минутн\\S*\\s+дел(?:о|а|у|ом|е|ьце|ьца|ьцу)(?![а-яё])|${W}деньги\\s+сразу\\s+по\\s+окончани[а-яё]*`),
  new RegExp(`${W}подн\\S*\\s+к[еэ]ш(?:а|у|ем)?(?![а-яё])|${W}всему\\s+обучаем(?![а-яё])`),
  // Decision of 01.11: migration bait and paid errands from the monitor.
  new RegExp(`${W}чат\\s+переносится\\s+в\\s+нов\\S*\\s+групп|${W}нажмите\\s+кнопку\\s+начать(?![а-яё])`),
  new RegExp(`${W}\\d{3,6}\\s*(?:р(?:уб[а-яё]*)?\\.?|₽)?\\s*за\\s+выход(?![а-яё])|${W}за\\s+выход\\s*[:—-]?\\s*\\d{3,6}(?!\\d)`),
  new RegExp(`${W}съ[её]мочн\\S*\\s+площадк|${W}по\\s+оплате\\s+договоримся(?![а-яё])|${W}подготовить\\s+погреб(?![а-яё])`),
  // An invitation to private messages alone is ordinary speech (decision of 01.11).
  new RegExp(`^\\s*заработок|${W}(?:пиши|напиши|пишите|напишите|отпиши|отпишите)\\s+\\+\\s+в\\s+лс(?![а-яё])`),
]

/** Latin letters that look like Cyrillic ones: spam swaps them to slip past filters («пoмочь», «плaчу»). */
const LOOKALIKE: Record<string, string> = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в' }

const CYRILLIC = /[а-яё]/

/**
 * A word with a Cyrillic letter gets its Latin lookalikes back; a hyphen between words counts as a space («в-лс»).
 * With `everyWord` a word of Latin lookalikes only is turned too («HETY»): only the phrase of 16.11 is checked on that text.
 */
function normalise(text: string, everyWord = false): string {
  return text
    .toLowerCase()
    .replace(/(\S)-(\S)/g, '$1 $2')
    .split(/(\s+)/)
    .map((word) => (everyWord || CYRILLIC.test(word) ? word.replace(/[acepxykmthb]/g, (ch) => LOOKALIKE[ch]) : word))
    .join('')
}

// Decision of 16.11: «НЕТУ ДЕНЕГ?? ПИШИ МНЕ !». The whole message is the bait: the lack of money and an invitation to write in
// private, with nothing but punctuation, spaces and emoji around and between them, or the invitation with «если нет денег» at
// the end. Any other word in the message keeps it ordinary speech: «У меня нет денег, пиши мне завтра», a quoted warning
// «Не верьте «Нету денег? Пиши мне»», «Пиши мне, если нужны деньги. Помогу…» (REVISE F1 of 17.11). The gap without letters
// and digits has no length limit (REVISE F2): it carries no words, so «НЕТУ ДЕНЕГ??? 💸💸💸💸 ПИШИ МНЕ!» is the same bait.
const NO_MONEY = '(?:(?:нету|нет|не\\s+хватает|нужно)\\s+(?:денег|бабла|бабок)|нужны\\s+(?:деньги|бабки)|(?:денег|бабла|бабок)\\s+(?:нет|нету))(?![а-яё])'
const PRIVATE = 'в\\s+(?:лс|личку|личные(?:\\s+сообщения)?|директ)'
const WRITE_ME = `(?:(?:на)?пиши(?:те)?|отпиши(?:те)?|обращайся|обращайтесь|стучи(?:сь|тесь)?)\\s+(?:мне(?:\\s+${PRIVATE})?|${PRIVATE})(?![а-яё])`
const NO_WORDS = '[^а-яёa-z0-9]'
const NO_MONEY_WRITE_ME = new RegExp(
  `^${NO_WORDS}*${NO_MONEY}${NO_WORDS}+(?:(?:тогда|срочно|скорее)\\s+)?${WRITE_ME}${NO_WORDS}*$`
  + `|^${NO_WORDS}*${WRITE_ME}${NO_WORDS}*если\\s+(?:у\\s+тебя\\s+|у\\s+вас\\s+)?${NO_MONEY}${NO_WORDS}*$`,
)

const INVITATION = new RegExp(`${W}залетай(?![а-яё])`)
const PAID_CONTEXT = new RegExp(`${W}(?:деньг[а-яё]*|денег|к[еэ]ш[а-яё]*|мест[ао]|обуч[а-яё]*)(?![а-яё])`)
const RUBLES = new RegExp(`${W}\\d{3,6}\\s*(?:р(?:уб[а-яё]*)?\\.?|₽)(?![а-яёa-z])`)
const CARRYING = new RegExp(`${W}(?:вынести|вынос[а-яё]*)(?![а-яё])`)
const DRIVERS = new RegExp(`${W}ищу\\s+водителей(?![а-яё])`)
const DOCUMENTS = new RegExp(`${W}передач\\S*\\s+документ`)
// Preserve the known paid construction-material errand while allowing everyday «пиши в лс».
const PAID_CARRY_CONTACT = new RegExp(`${W}перенести\\s+стройматериал\\S*[^!?\\n]{0,40}\\d{3,6}[^!?\\n]{0,30}${W}пиши\\s+в\\s+лс(?![а-яё])`)
// Decision of 02.11: both work bait and an invitation are required in one message.
const WORK_BAIT = new RegExp(`${W}гибк\\S*\\s+график|${W}(?:0|без)\\s+вложений(?![а-яё])`)
const TOPIC_BAIT = new RegExp(`${W}есть\\s+тема(?![а-яё])`)
// A topic for discussion or a talk is ordinary speech; keep the weak «есть тема» bait conservative.
const DISCUSSION_TOPIC = new RegExp(`${W}(?:обсужд|доклад)`)
const PRIVATE_CONTACT = new RegExp(`${W}обращайся(?![а-яё])|${W}(?:пиши|напиши)\\s+в\\s+(?:личные|личку|лс)(?![а-яё])`)
const BUSINESS_LINK = /(?<![a-z0-9_./-])(?:https?:\/\/)?t\.me\/m\/[a-z0-9_-]+/i
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Count visible non-space symbols of the body; the business URL is checked separately. */
function emojiBusinessLink(text: string): boolean {
  const link = BUSINESS_LINK.exec(text)
  if (!link) return false
  const body = text.replace(link[0], '')
  const symbols = Array.from(segmenter.segment(body), ({ segment }) => segment).filter((symbol) => /\S/u.test(symbol))
  return symbols.length > 0 && symbols.filter(hasEmoji).length * 10 >= symbols.length * 7
}

export function hasSpamPhrase(text: string): boolean {
  const lower = text.toLowerCase()
  const plain = normalise(text)
  return PHRASES.some((re) => re.test(lower) || re.test(plain))
    || (INVITATION.test(plain) && PAID_CONTEXT.test(plain))
    || (CARRYING.test(plain) && RUBLES.test(plain))
    || (DRIVERS.test(plain) && DOCUMENTS.test(plain))
    || ((WORK_BAIT.test(plain) || (TOPIC_BAIT.test(plain) && !DISCUSSION_TOPIC.test(plain))) && PRIVATE_CONTACT.test(plain))
    || PAID_CARRY_CONTACT.test(plain)
    || NO_MONEY_WRITE_ME.test(plain) || NO_MONEY_WRITE_ME.test(normalise(text, true))
    || emojiBusinessLink(text)
}

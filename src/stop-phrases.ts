/**
 * The words that send the author of an early message to the steam room whatever Jev says: the stop word of section 3.6.6 and,
 * the phrases of spam the admins removed by hand while Jev scored it below the threshold
 * (section 3.6.7).
 */

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
  // «Заработок», «пиши в лс», «отпишите в-лс».
  new RegExp(`^\\s*заработок|${W}(?:пиши|напиши|пишите|напишите|отпиши|отпишите)\\s+в\\s+лс`),
]

/** Latin letters that look like Cyrillic ones: spam swaps them to slip past filters («пoмочь», «плaчу»). */
const LOOKALIKE: Record<string, string> = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в' }

const CYRILLIC = /[а-яё]/

/** A word with a Cyrillic letter gets its Latin lookalikes back; a hyphen between words counts as a space («в-лс»). */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\S)-(\S)/g, '$1 $2')
    .split(/(\s+)/)
    .map((word) => (CYRILLIC.test(word) ? word.replace(/[acepxykmthb]/g, (ch) => LOOKALIKE[ch]) : word))
    .join('')
}

export function hasSpamPhrase(text: string): boolean {
  const lower = text.toLowerCase()
  const plain = normalise(text)
  return PHRASES.some((re) => re.test(lower) || re.test(plain))
}

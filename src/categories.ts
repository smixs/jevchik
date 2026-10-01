import type { Facts } from './jev/facts.js'

/** Every category the code can set, in words: bath records (section 3.9) and admin cards (section 3.6.1) use this one dictionary. */
const CATEGORY_TITLES: Record<string, string> = {
  spam_earnings_crypto: 'Лёгкие деньги и крипта',
  spam_topic_pivot: 'Поддакнул и достал рекламу',
  spam_channel_bait: 'Заманивание в канал',
  spam_other_offer: 'Навязчивая реклама',
  profile_promo: 'Рекламный профиль',
  admin: 'Решение админа',
  probation_link: 'Ссылка на испытательном сроке',
}

export function categoryTitle(category: string): string {
  return CATEGORY_TITLES[category] ?? category
}

/** Section 3.5: the spam question with the highest value, `profile_promo` when the profile outweighs it; null without any answer. */
export function categoryOf(facts: Pick<Facts, 'spam' | 'spamCategory' | 'profilePromo'>): string | null {
  if (facts.spam === null && facts.profilePromo === null) return null
  const promo = facts.profilePromo ?? -1
  return promo > (facts.spam ?? -1) || !facts.spamCategory ? 'profile_promo' : facts.spamCategory
}

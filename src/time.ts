import { DAY_MS, HOUR_MS } from './ctx.js'

interface Parts {
  y: number
  m: number
  d: number
  h: number
  min: number
  s: number
}

function zonedParts(date: Date, timeZone: string): Parts {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const get = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, Number(part.value)]))
  return { y: get.year, m: get.month, d: get.day, h: get.hour, min: get.minute, s: get.second }
}

function offsetAt(instant: number, timeZone: string): number {
  const p = zonedParts(new Date(instant), timeZone)
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(instant / 1000) * 1000
}

function localToInstant(local: { y: number; m: number; d: number; hour: number }, timeZone: string): Date {
  const { y, m, d, hour } = local
  const guess = Date.UTC(y, m - 1, d, hour)
  let instant = guess - offsetAt(guess, timeZone)
  instant = guess - offsetAt(instant, timeZone)
  return new Date(instant)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function isoWeekOf(y: number, m: number, d: number): { year: number; week: number } {
  const date = Date.UTC(y, m - 1, d)
  const dayNum = (new Date(date).getUTCDay() + 6) % 7
  const thursday = date + (3 - dayNum) * DAY_MS
  const year = new Date(thursday).getUTCFullYear()
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1
  return { year, week }
}

export function weekKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone)
  const { year, week } = isoWeekOf(p.y, p.m, p.d)
  return `${year}-W${pad(week)}`
}

export function weekStart(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone)
  const dayNum = (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7
  const monday = new Date(Date.UTC(p.y, p.m - 1, p.d) - dayNum * DAY_MS)
  return localToInstant({ y: monday.getUTCFullYear(), m: monday.getUTCMonth() + 1, d: monday.getUTCDate(), hour: 0 }, timeZone)
}

export function previousWeekStart(start: Date, timeZone: string): Date {
  return weekStart(new Date(start.getTime() - 12 * HOUR_MS), timeZone)
}

export function localHour(date: Date, timeZone: string): number {
  return zonedParts(date, timeZone).h
}

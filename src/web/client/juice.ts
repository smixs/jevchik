/**
 * How the Mini App feels. The screens say WHAT happened (a tab changed, a setting was saved, the ban was lifted);
 * this module decides HOW it feels: motion, vibration through Telegram. There is no sound.
 * Motion is only transform and opacity, and none of it runs under prefers-reduced-motion.
 * Effects never change the text of the page: a counting number is drawn over the real one.
 */

type Impact = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'
type Notice = 'success' | 'warning' | 'error'

interface Haptics {
  impactOccurred?: (style: Impact) => void
  notificationOccurred?: (type: Notice) => void
  selectionChanged?: () => void
}

function haptics(): Haptics | undefined {
  return (window as unknown as { Telegram?: { WebApp?: { HapticFeedback?: Haptics } } }).Telegram?.WebApp?.HapticFeedback
}

function buzz(use: (h: Haptics) => void): void {
  const h = haptics()
  if (!h) return
  try {
    use(h)
  } catch {
    // an old Telegram without haptics: the screen still says what happened
  }
}

/** Motion is allowed: the person did not ask to reduce it and the page can draw frames. */
function moving(): boolean {
  return typeof matchMedia === 'function' && typeof requestAnimationFrame === 'function' && matchMedia('(prefers-reduced-motion: no-preference)').matches
}

/** Restarts a one-shot animation on an element that stays on the page. */
function replay(el: Element, cls: string): void {
  if (!moving()) return
  el.classList.remove(cls)
  void (el as HTMLElement).offsetWidth
  el.classList.add(cls)
}

const PRESSABLE = 'button,a.btn'
/** Controls that report their own meaning (a tab, a period, a row): the generic tap stays silent for them. */
const OWN_FEEL = '[data-screen],[data-period],[data-public-id]'

/** Every press shrinks towards the finger and gives a light tap; installed once. */
function install(): void {
  document.addEventListener('pointerdown', (event) => {
    const target = (event.target as Element | null)?.closest?.(PRESSABLE) as HTMLElement | null
    if (!target) return
    const box = target.getBoundingClientRect()
    target.style.transformOrigin = `${Math.round(event.clientX - box.left)}px ${Math.round(event.clientY - box.top)}px`
  }, { passive: true })
  document.addEventListener('click', (event) => {
    const target = (event.target as Element | null)?.closest?.(PRESSABLE)
    if (target && !target.matches(OWN_FEEL) && !(target as HTMLButtonElement).disabled) buzz((h) => h.impactOccurred?.('light'))
  }, true)
}

/** A number counts up to its value; the real text stays in the element, the counting is drawn over it. */
function count(el: HTMLElement, to: number, format: (v: number) => string): void {
  if (!moving() || to === 0) return
  el.classList.add('jcount')
  el.setAttribute('data-count', format(0))
  let start = 0
  let waits = 0
  const tick = (now: number): void => {
    if (!el.isConnected) {
      if (++waits < 60) requestAnimationFrame(tick)
      return
    }
    start ||= now
    const p = Math.min(1, (now - start) / 600)
    el.setAttribute('data-count', format(to * (1 - (1 - p) ** 3)))
    if (p < 1) requestAnimationFrame(tick)
    else el.classList.remove('jcount')
  }
  requestAnimationFrame(tick)
}

const CONFETTI = ['#16abed', '#facc15', '#34d399', '#f472b6', '#ffffff', '#fb923c']

/** Square pixels burst up from the button and fall: only for a lifted ban. */
function confetti(from: HTMLElement): void {
  if (!moving()) return
  const box = from.getBoundingClientRect()
  const layer = document.createElement('div')
  layer.className = 'jconfetti'
  layer.setAttribute('aria-hidden', 'true')
  document.body.append(layer)
  const flights: Promise<unknown>[] = []
  for (let i = 0; i < 28; i++) {
    const bit = document.createElement('i')
    const size = 5 + (i % 3) * 2
    bit.style.cssText = `left:${box.left + box.width / 2}px;top:${box.top + box.height / 2}px;width:${size}px;height:${size}px;background:${CONFETTI[i % CONFETTI.length]}`
    layer.append(bit)
    if (typeof bit.animate !== 'function') continue
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.2
    const speed = 110 + Math.random() * 120
    const dx = Math.cos(angle) * speed
    const dy = Math.sin(angle) * speed
    // pixels stay square to the grid: they fly and fall, they do not spin
    const at = (x: number, y: number): string => `translate(-50%,-50%) translate(${Math.round(x)}px,${Math.round(y)}px)`
    flights.push(
      bit.animate(
        [
          { transform: at(0, 0), opacity: 1, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
          { transform: at(dx, dy), opacity: 1, offset: 0.45, easing: 'cubic-bezier(0.55, 0, 1, 0.45)' },
          { transform: at(dx * 1.15, dy + 90), opacity: 1, offset: 0.8 },
          { transform: at(dx * 1.2, dy + 140), opacity: 0 },
        ],
        { duration: 1000 + Math.random() * 300, fill: 'forwards' },
      ).finished,
    )
  }
  void Promise.allSettled(flights).then(() => layer.remove())
}

export const juice = {
  install,
  /** A bottom tab was chosen. */
  tabChanged(): void {
    buzz((h) => h.selectionChanged?.())
  },
  /** A period was chosen: the highlight slides there at once, before the list arrives. */
  periodChanged(pill: HTMLElement | null, index: number): void {
    buzz((h) => h.selectionChanged?.())
    pill?.style.setProperty('--at', String(index))
  },
  /** The leaderboard list appeared: rows come in one after another. */
  listShown(list: HTMLElement): void {
    if (moving()) list.classList.add('jcascade')
  },
  /** A karma number appeared. */
  numberShown: count,
  /** A member's page was opened from the leaderboard. */
  pageOpened(): void {
    buzz((h) => h.impactOccurred?.('soft'))
  },
  /** The page of a member is on screen. */
  pageShown(screen: HTMLElement): void {
    replay(screen, 'jpage')
  },
  /** Something was stored: a setting, the observation, an import. */
  saved(status: HTMLElement): void {
    buzz((h) => h.notificationOccurred?.('success'))
    replay(status, 'jok')
  },
  /** Something failed: the message shakes its head. */
  failed(el: HTMLElement): void {
    buzz((h) => h.notificationOccurred?.('error'))
    replay(el, 'jno')
  },
  /** The appeal lifted the ban: the one celebration in the app. */
  appealLifted(button: HTMLElement, result: HTMLElement): void {
    buzz((h) => h.notificationOccurred?.('success'))
    replay(result, 'jok')
    confetti(button)
  },
  /** The appeal was accepted but the restriction is still on. */
  appealAccepted(result: HTMLElement): void {
    buzz((h) => h.notificationOccurred?.('warning'))
    replay(result, 'jok')
  },
  /** The appeal went to the admins or is already being checked. */
  appealWaiting(result: HTMLElement): void {
    buzz((h) => h.impactOccurred?.('soft'))
    replay(result, 'jok')
  },
  /** The appeal was refused: the answer settles down heavily. */
  appealRefused(result: HTMLElement): void {
    buzz((h) => h.notificationOccurred?.('error'))
    replay(result, 'jsink')
  },
  /** An empty state: the mascot breathes. */
  emptyShown(mascot: HTMLElement): void {
    if (moving()) mascot.classList.add('jbreathe')
  },
}

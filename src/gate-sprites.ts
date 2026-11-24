/**
 * Section 3.6.8: the six pixel animals of the door, 16x16. One letter is one cell: '.' is empty, the rest are keys of the
 * palette. The client gets only the cells and the colours, never the name of an animal.
 */
export const KINDS = ['frog', 'cat', 'duck', 'pig', 'bunny', 'fish'] as const
export type Kind = (typeof KINDS)[number]

const FROG = [
  '................',
  '..oooo....oooo..',
  '.oeeeeo..oeeeeo.',
  '.oeppeooooeppeo.',
  '.oeeeebbbbeeeeo.',
  'obbbbbbbbbbbbbbo',
  'obrrbbbbbbbbrrbo',
  'obbbbbbbbbbbbbbo',
  'obbobbbbbbbbobbo',
  'obbboooooooobbbo',
  '.obbbbbbbbbbbbo.',
  '..obllllllllbo..',
  '.obbllllllllbbo.',
  'obbbo.oooo.obbbo',
  'oooo........oooo',
  '................',
]

const CAT = [
  '................',
  '.oo..........oo.',
  '.obo........obo.',
  '.obbo......obbo.',
  '.obbboooooobbbo.',
  '.obbbbbbbbbbbbo.',
  'obbeebbbbbbeebbo',
  'obbepbbbbbbepbbo',
  'obbbbbbrrbbbbbbo',
  'obbbbbobbobbbbbo',
  '.obbbbboobbbbbo.',
  '..obbbbbbbbbbo..',
  '..obllllllllbo..',
  '..obbo....obbo..',
  '..ooo......ooo..',
  '................',
]

const DUCK = [
  '................',
  '.....oooo.......',
  '....obbbbo......',
  '...obbbepbo.....',
  '...obbbbbborrr..',
  '...obbbbbbbrrr..',
  '....obbbbbooo...',
  '..oobbbbbbbo....',
  '.obbbbbbbbbbo...',
  'obbllllbbbbbbo..',
  'obbllllbbbbbbbo.',
  'obbbllbbbbbbbbo.',
  '.obbbbbbbbbbbo..',
  '..ooooooooooo...',
  '.....rr..rr.....',
  '................',
]

const PIG = [
  '................',
  '..oo........oo..',
  '.obbo......obbo.',
  '.obbboooooobbbo.',
  '.obbbbbbbbbbbbo.',
  'obbeebbbbbbeebbo',
  'obbepbbbbbbepbbo',
  'obbbbbbbbbbbbbbo',
  'obbbboooooobbbbo',
  'obbbbrdrrdrbbbbo',
  'obbbbrrrrrrbbbbo',
  '.obbbooooooobbo.',
  '..obbbbbbbbbbo..',
  '..obo.oooo.obo..',
  '..oo........oo..',
  '................',
]

const BUNNY = [
  '....oo....oo....',
  '...obo....obo...',
  '...obo....obo...',
  '...oro....oro...',
  '...obo....obo...',
  '..obbboooobbbo..',
  '.obbbbbbbbbbbbo.',
  '.obepbbbbbbepbo.',
  '.obbbbbrrbbbbbo.',
  '.obbbbobbobbbbo.',
  '..obbbbllbbbbo..',
  '..obbllllllbbo..',
  '..obbllllllbbo..',
  '..obbbbbbbbbbo..',
  '..ooo......ooo..',
  '................',
]

const FISH = [
  '................',
  '................',
  '................',
  '.....ooooo......',
  '...oobbbbboo...o',
  '..obbbbbbbbbo.oo',
  '.obepbbbbbbbbobo',
  '.obbbbbbbbbbbbbo',
  '.orbbbbbbbbbbobo',
  '..obllllllllo.oo',
  '...oolllllloo..o',
  '.....ooooooo....',
  '................',
  '................',
  '................',
  '................',
]

const SHAPES: Record<Kind, string[]> = { frog: FROG, cat: CAT, duck: DUCK, pig: PIG, bunny: BUNNY, fish: FISH }

/** Three shades of each animal: the same animal never looks byte-identical twice in a row. */
const PALETTES: Record<Kind, Array<Record<string, string>>> = {
  frog: [
    { o: '#1d3b1f', b: '#6cc24a', l: '#c6ef8a', e: '#ffffff', p: '#14171a', r: '#f08a8a' },
    { o: '#1a3520', b: '#58b84f', l: '#b8e88a', e: '#ffffff', p: '#14171a', r: '#ee7f86' },
    { o: '#22401f', b: '#7ccf5a', l: '#d2f59a', e: '#ffffff', p: '#14171a', r: '#f39a8e' },
  ],
  cat: [
    { o: '#3a2212', b: '#f0a04b', l: '#ffe1b8', e: '#ffffff', p: '#14171a', r: '#e8607a' },
    { o: '#36200f', b: '#e8933e', l: '#ffd9a8', e: '#ffffff', p: '#14171a', r: '#e35d77' },
    { o: '#3f2716', b: '#f5ad5c', l: '#ffe8c6', e: '#ffffff', p: '#14171a', r: '#ec6c84' },
  ],
  duck: [
    { o: '#4a3a10', b: '#ffd84a', l: '#fff2a8', e: '#ffffff', p: '#14171a', r: '#ff8a1f' },
    { o: '#45360e', b: '#f9cf3c', l: '#ffee9a', e: '#ffffff', p: '#14171a', r: '#fa8015' },
    { o: '#4f3f14', b: '#ffe05c', l: '#fff6b8', e: '#ffffff', p: '#14171a', r: '#ff9433' },
  ],
  pig: [
    { o: '#5a2a35', b: '#f7a8b8', l: '#ffd3dc', e: '#ffffff', p: '#14171a', r: '#e77f96', d: '#5a2a35' },
    { o: '#552733', b: '#f39cae', l: '#ffcad5', e: '#ffffff', p: '#14171a', r: '#e2738b', d: '#552733' },
    { o: '#5e2e39', b: '#fab4c2', l: '#ffdde4', e: '#ffffff', p: '#14171a', r: '#ec8aa0', d: '#5e2e39' },
  ],
  bunny: [
    { o: '#3b3b44', b: '#e9e9ef', l: '#ffffff', e: '#ffffff', p: '#14171a', r: '#f4a6b8' },
    { o: '#37373f', b: '#e1e1e8', l: '#fbfbff', e: '#ffffff', p: '#14171a', r: '#f19bb0' },
    { o: '#40404a', b: '#efeff4', l: '#ffffff', e: '#ffffff', p: '#14171a', r: '#f6b1c1' },
  ],
  fish: [
    { o: '#13304d', b: '#4aa8e8', l: '#bfe6ff', e: '#ffffff', p: '#14171a', r: '#ff7b5c' },
    { o: '#112c47', b: '#3f9ee0', l: '#b2dfff', e: '#ffffff', p: '#14171a', r: '#fb7052' },
    { o: '#163553', b: '#57b2ee', l: '#cbebff', e: '#ffffff', p: '#14171a', r: '#ff8668' },
  ],
}

export const SHADES = 3

export interface Sprite {
  rows: string[]
  palette: Record<string, string>
}

/** The cells of one animal, mirrored when asked, with one of its shades. */
export function sprite(kind: Kind, flip: boolean, shade: number): Sprite {
  const rows = SHAPES[kind].map((row) => (flip ? [...row].reverse().join('') : row))
  return { rows, palette: PALETTES[kind][shade % SHADES] }
}

/** For the tests: every animal is 16x16 and uses only letters of its palette. */
export function shapes(): Record<Kind, string[]> {
  return SHAPES
}

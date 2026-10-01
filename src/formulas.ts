export function messageFactor(k: number): number {
  return 1 / (1 + Math.log(Math.max(1, k)))
}

export function pairFactor(k: number): number {
  return 1 / (1 + Math.log(Math.max(1, k)))
}

export function voterWeight(karma: number, scale: number): number {
  return 1 + Math.log(1 + Math.max(0, karma) / scale)
}

export function seriesFactor(k: number): number {
  return 1 / (1 + Math.log(Math.max(1, k)))
}

export interface ReactionArgs {
  base: number
  kMessage: number
  kPair: number
  voterKarma: number
  scale: number
}

export function reactionDelta(args: ReactionArgs): number {
  return args.base * messageFactor(args.kMessage) * pairFactor(args.kPair) * voterWeight(args.voterKarma, args.scale)
}

export function streakBoost(weeks: number, perWeek: number, max: number): number {
  return 1 + Math.min(max, perWeek * Math.max(0, weeks))
}

export function decayStep(old: number, lowerBound: number, rate: number): number {
  return Math.max(lowerBound, old - rate * Math.abs(old))
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

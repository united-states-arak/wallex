import { DAY, START, SYMBOLS, load } from './sim'

const { bars } = await load()
const px = (s: string, d: number) => {
  const b = bars[s]!
  const t = START + d * DAY
  return b.find((x) => x.t >= t)!.c
}
for (const [a, c] of [[0, 40], [40, 80], [80, 120], [0, 80], [0, 120]] as const) {
  const r = SYMBOLS.map((s) => px(s, c) / px(s, a) - 1)
  console.log(`${a}:${c}`, 'avg', ((r.reduce((x, y) => x + y, 0) / r.length) * 100).toFixed(1) + '%', SYMBOLS.map((s, i) => s.replace('TMN', '') + ' ' + (r[i]! * 100).toFixed(0)).join(' '))
}

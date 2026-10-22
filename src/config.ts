import { getSettings } from './settings'

// Backwards-compatible flat view over the layered settings (src/settings, config/*.toml). New code should read getSettings().
export const cfg = {
  get apiKey() {
    return getSettings().wallex.apiKey
  },
  get baseUrl() {
    return getSettings().wallex.baseUrl
  },
  get makerFee() {
    return getSettings().fees.maker
  },
  get takerFee() {
    return getSettings().fees.taker
  },
  get spreadBps() {
    return getSettings().paper.spreadBps
  },
  get slippageBps() {
    return getSettings().paper.slippageBps
  },
  get startTmn() {
    return getSettings().paper.startTmn
  },
  get symbols() {
    return [...getSettings().market.symbols]
  },
  get dataDir() {
    return getSettings().data.dataDir
  },
  get logDir() {
    return getSettings().logging.dir
  },
  get blockedFile() {
    return getSettings().market.blockedFile
  },
}

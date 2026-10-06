/**
 * prompt-cache-control — Claude Mod
 *
 * A prompt-cache meter for Claude Code. Every main-loop request reports how
 * many prompt tokens the cache served (`cache_read_input_tokens`), wrote
 * (`cache_creation_input_tokens`) and sent uncached (`input_tokens`); this mod
 * keeps those per request and per turn, counts down to the moment the cache
 * lapses, and says what to do about it: keep going, /compact or /clear.
 *
 *   - `turn.step` reads each main-loop request's usage (subagents have their
 *     own prefixes and are left out)
 *   - `$.clock.every(1000)` redraws the countdown, and only while its text
 *     changes: an idle, expired session costs nothing
 *   - `/keepwarm` pings the cache after idle stretches (ported from cache-tax)
 *   - a row above the prompt (the AbovePrompt component), an optional status
 *     line entry, and `/cache`, a pane with one row per turn
 *
 * The lifetime is counted from the start of the request that last wrote or read
 * the cache, as Anthropic documents it. Which lifetime Claude Code asked for
 * follows its documented rules (see decideTtl in ./cache.ts): FORCE_PROMPT_CACHING_5M,
 * CLAUDE_CODE_PROMPT_CACHE_TTL, the promptCacheTtl setting, ENABLE_PROMPT_CACHING_1H,
 * then the account (1 hour on a Claude subscription, 5 minutes otherwise). The
 * API names the TTL of a write but the mod API passes on only the token counts,
 * so the mod also watches the gaps between requests (a hit after more than 5
 * minutes proves 1 hour; see observeTtl). `ttl: "5m" | "1h"` pins it.
 *
 * Needs Claude Code >= 2.1.287.
 *
 * Options (pluginConfigs["prompt-cache-control@skills-dir"].options):
 *   ttl: "auto" | "5m" | "1h"   cache lifetime (default auto)
 *   warnSeconds: number         countdown threshold for the warning (default 60)
 *   compactAtTokens: number     prompt size that makes an expired cache suggest /compact (default 100000)
 *   band: boolean               row above the prompt (default true)
 *   breakdown: boolean          read/wrote/new token counts in the band (default true)
 *   status: boolean             entry under the prompt (default false)
 *   toast: boolean              toasts near expiry: at warnSeconds, then 10, 3, 2 and 1 s (default true)
 */
import type { EngineInterface, Register, RenderChildren } from 'claude-code'
import {
  calibRate,
  windowSpend,
  type Spend,
  guardVerdict,
  isColdWrite,
  advise,
  ttlMs,
  COUNTDOWN_MARKS,
  bar,
  byTurn,
  fit,
  fmtClock,
  fmtTokens,
  hitRatio,
  isCachingDisabled,
  accountOf,
  decideTtl,
  observeTtl,
  lifeColor,
  lifeRatio,
  nextToastMark,
  positive,
  promptTokens,
  remainingMs,
  rowRatio,
  segments,
} from './cache.ts'
import type { Account, Advice, CacheEnv, GuardMode, Sample, Ttl } from './cache.ts'

const PANE = 'cache'
// the pane's label column
const LABEL_W = 13
const COMMAND = 'cache'
const KEEP = 200
// below this a lapsed cache costs too little to interrupt anyone about
const TOAST_MIN_TOKENS = 20_000

let samples: Sample[] = []
let ttl: Ttl = '5m'
let baseTtl: Ttl = '5m'
let pinned = false
let observed: Ttl | undefined
let setting: unknown
let account: Account = 'other'
let ttlSource = 'default'
let envSource = 'default'
let env: CacheEnv = {}
let timer: { cancel: () => void } | undefined
let lastKey = ''
let toastedFor = 0
let toastLevel = Infinity
let isPaneOpen = false

type Policy = { warnMs: number; compactAtTokens: number }

function current(policy: Policy, now: number) {
  const last = samples[samples.length - 1]
  const prev = samples[samples.length - 2]
  const disabled = last ? isCachingDisabled(last.model, env) : isCachingDisabled('', env)
  const advice: Advice = advise(last, prev, { ttl, ...policy }, now, disabled)
  const left = last ? remainingMs(last, ttl, now) : 0
  return { last, advice, left }
}

const COLOR: Record<Advice['kind'], string | undefined> = {
  warm: 'green',
  soon: 'yellow',
  expired: 'red',
  miss: 'red',
  off: undefined,
  cold: undefined,
  uncached: undefined,
}

/** a hit rate with one decimal, e.g. 99.5% */
const pct1 = (ratio: number) => `${(ratio * 100).toFixed(1)}%`

async function openPane($: EngineInterface) {
  isPaneOpen = true
  await $.ui.open({ id: PANE, title: 'cache', focus: true })
  $.ui.invalidate('ui.render')
}

function shortLine(policy: Policy, now: number): string {
  const { last, advice, left } = current(policy, now)
  if (!last || advice.kind === 'off') return `cache: ${advice.text}`
  const clock = left > 0 ? ` · ${fmtClock(left)}` : ''
  return `cache ${pct1(hitRatio(last))}${clock}`
}

// the promptCacheTtl setting, from the settings files that can carry it (local over project over user)
async function readSetting($: EngineInterface): Promise<unknown> {
  const home = await $.env.get('HOME').catch(() => undefined)
  const cwd = await $.session.cwd().catch(() => undefined)
  const files = [cwd && `${cwd}/.claude/settings.local.json`, cwd && `${cwd}/.claude/settings.json`, home && `${home}/.claude/settings.json`]
  for (const file of files) {
    if (!file) continue
    try {
      const value = JSON.parse(await $.fs.read(file)).promptCacheTtl
      if (value === '5m' || value === '1h') return value
    } catch {
      // missing or unreadable: the next file
    }
  }
  return undefined
}


// ---- /keepwarm, ported from cache-tax 2.2.1 (MIT): a tool-less $.model.fork after each idle stretch re-reads
// the cached prefix; each ping is recorded as a Sample, so the meter counts it
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const PING_PROMPT = 'Reply with the single word: warm'
const KEY_DEADLINE = 'keepwarm.deadline'
const KEY_EVERY = 'keepwarm.every'
const KEY_ALWAYS = 'keepwarm.always'

// $ per million tokens, [cache read, 1h cache write, output], list prices September 2026 (from cache-tax).
const PRICES: Array<[string, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['opus-5', 0.5, 10, 25],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku', 0.1, 2, 5],
]

type Ping = { read: number; usd: number | null }

function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function priceOf(model: string): [number, number, number] | null {
  const m = model.toLowerCase().replace(/[\s.]+/g, '-')
  for (const [family, read, write, output] of PRICES) if (m.includes(family)) return [read, write, output]
  return null
}

function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + usd.toFixed(2)
}

/** 50m on a 1h cache, about 4m on a 5m one */
const defaultEvery = (ttlMs: number) => Math.max(MIN_PING_MS, Math.round((ttlMs * 5) / 6))

let sid = ''
let deadline = 0
let windowStart = 0 // when the current window was armed, for the pane's bar
let every = 0 // 0: the default for the TTL in force
let always = false
let compacted = false
let stopped: string | null = null
let lastPing: Ping | null = null
let pending: { cancel: () => void } | null = null

const period = () => every || defaultEvery(ttlMs(ttl))
const lastAt = () => samples[samples.length - 1]?.startedAt ?? 0
const isCold = (now: number) => lastAt() > 0 && now - lastAt() >= ttlMs(ttl)

/** the band's segment, undefined when keepwarm is off */
function keepwarmStatus(now: number): { text: string; stopped: boolean } | undefined {
  if (stopped) return { text: `keepwarm stopped: ${stopped}`, stopped: true }
  if (!deadline || now >= deadline) return undefined
  const next = !lastAt() || compacted ? 'waiting for a turn'
    : isCold(now) ? 'cold'
    : `ping ${fmtDuration(lastAt() + period() - now)}`
  const last = lastPing ? ` · last ${fmtTokens(lastPing.read)} ${fmtUsd(lastPing.usd)}` : ''
  return { text: `♨ keepwarm ${fmtDuration(deadline - now)} · ${next}${last}`, stopped: false }
}

/** keepwarm for the pane, as values rather than one line */
function keepwarmInfo(now: number) {
  const on = !!deadline && now < deadline
  const next = !on ? undefined
    : !lastAt() || compacted ? 'after the next turn'
    : isCold(now) ? 'cold, after the next turn'
    : `in ${fmtDuration(lastAt() + period() - now)}`
  return {
    on,
    stopped,
    always,
    left: on ? deadline - now : 0,
    window: on ? Math.max(1, deadline - windowStart) : 1,
    next,
    every: period(),
    lastPing,
  }
}

/** from the module's session.start (one hook per event per module) */
async function keepwarmStart($: EngineInterface) {
  disarm()
  sid = await $.session.id()
  const now = Date.now()
  const saved = await $.store.get(keyOf(KEY_DEADLINE))
  const savedEvery = await $.store.get(keyOf(KEY_EVERY))
  deadline = typeof saved === 'number' && saved > now ? saved : 0
  // a restored window's start is not stored: assume the default length
  windowStart = deadline ? Math.min(now, deadline - DEFAULT_WINDOW_MS) : 0
  if (!deadline) {
    await $.store.delete(keyOf(KEY_DEADLINE))
    await $.store.delete(keyOf(KEY_EVERY))
  }
  every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS ? savedEvery : 0
  always = (await $.store.get(KEY_ALWAYS)) === true
  if (always) await startWindow($, DEFAULT_WINDOW_MS, 0)
  await $.command.register({
    name: 'keepwarm',
    description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, or status',
    argumentHint: '[6h | always | off | status]',
    immediate: true,
  })
  await arm($)
}

/** from the module's session.end */
async function keepwarmEnd($: EngineInterface, reason: string) {
  // /clear starts a new conversation: nothing to keep warm until it has a turn
  if (reason === 'clear') {
    await stop($, null)
    lastPing = null
    misses = []
    ackedAt = 0
    coldWritePending = false
  } else disarm()
}

const keyOf = (k: string) => `${k}:${sid}`

const disarm = () => {
  pending?.cancel()
  pending = null
}

async function stop($: EngineInterface, why: string | null, forgetAlways = false) {
  deadline = 0
  every = 0
  stopped = why
  disarm()
  await $.store.delete(keyOf(KEY_DEADLINE))
  await $.store.delete(keyOf(KEY_EVERY))
  if (forgetAlways) {
    always = false
    await $.store.delete(KEY_ALWAYS)
  }
  $.ui.invalidate('ui.render')
}

async function arm($: EngineInterface) {
  disarm()
  if (!deadline) return
  const now = Date.now()
  if (now >= deadline) return stop($, null)
  // a cold or compacted cache is not pinged: the next turn writes it anew, then pinging resumes
  if (lastAt() && !compacted && !isCold(now)) {
    const delay = Math.min(deadline - now, lastAt() + ttlMs(ttl) - now, Math.max(1000, lastAt() + period() - now))
    pending = $.clock.after(delay, () => void ping($))
  } else {
    pending = $.clock.after(deadline - now, () => void arm($))
  }
  $.ui.invalidate('ui.render')
}

async function ping($: EngineInterface) {
  pending = null
  if (!deadline) return
  const now = Date.now()
  if (now >= deadline || isCold(now)) return arm($)
  // a turn in the meantime re-armed the timer; this callback is stale
  if (now - lastAt() < period() - 1000) return
  const model = samples[samples.length - 1]?.model ?? ''
  let reply
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    return stop($, `the ping failed, ${err instanceof Error ? err.message : String(err)}`)
  }
  if (reply.isAnswered === false) {
    const reason = reply.reason === 'nothing-to-fork' ? 'no conversation to warm yet'
      : reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    return stop($, reason)
  }
  const u = reply.usage
  const price = priceOf(model)
  const usd = price
    ? (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + (u.input_tokens * price[1]) / 2 + u.output_tokens * price[2]) / 1e6
    : null
  lastPing = { read: u.cache_read_input_tokens, usd }
  if (usd != null) spentUsd += usd
  pushSample({
    turnId: `keepwarm-${now}`,
    index: 0,
    model,
    startedAt: now,
    read: u.cache_read_input_tokens,
    write: u.cache_creation_input_tokens,
    fresh: u.input_tokens,
    output: u.output_tokens,
  })
  $.ui.invalidate('ui.render')
  // a warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  if (!warm) return stop($, `the ping wrote ${fmtTokens(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  await arm($)
}

async function startWindow($: EngineInterface, windowMs: number, everyMs: number) {
  every = everyMs
  if (every) await $.store.set(keyOf(KEY_EVERY), every)
  else await $.store.delete(keyOf(KEY_EVERY))
  windowStart = Date.now()
  deadline = windowStart + windowMs
  stopped = null
  await $.store.set(keyOf(KEY_DEADLINE), deadline)
  await arm($)
}

function statusLine(now: number): string | undefined {
  if (stopped) return `keepwarm stopped: ${stopped}`
  if (!deadline || now >= deadline) return undefined
  const next = !lastAt() ? ' · waiting for the first turn'
    : compacted ? ' · waiting for the first turn after compaction'
    : isCold(now) ? ` · cold now, first ping ${fmtDuration(period())} after the next turn`
    : ` · ping in ${fmtDuration(lastAt() + period() - now)}`
  const last = lastPing ? ` · last ping read ${fmtTokens(lastPing.read)} ${fmtUsd(lastPing.usd)}` : ''
  return `keepwarm ${fmtDuration(deadline - now)} left${next}${last}`
}

function armedText(windowMs: number): string {
  if (isCold(Date.now())) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(period())} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(period())} after each idle stretch keeps the cache read, not re-written`
}

// ---- cold-cache price and guard, ported from cache-tax 2.2.1 (MIT)
/** the last request's cache has lapsed: the next message writes the whole prefix again */
function coldSince(now: number): number | undefined {
  const last = samples[samples.length - 1]
  if (!last || compacted || last.read + last.write === 0) return undefined
  const at = last.startedAt + ttlMs(ttl)
  return now >= at ? at : undefined
}

/** $ per million tokens written to the cache for `model` at the TTL in force: the 1h rate is 2x base, the 5m one 1.25x */
function writeRate(model: string): number | null {
  const price = priceOf(model)
  return price ? (ttl === '1h' ? price[1] : price[1] * 0.625) : null
}

const AUTO_WARM_MS = 3 * 60 * 60 * 1000
type Miss = { at: number; tokens: number; usd: number | null }
/** this session's cold writes */
let misses: Miss[] = []
/** the guard let a message to a cold cache through: its turn pays a cold write */
let coldWritePending = false

/** the request of `turnId` that re-wrote the prefix: after the guard let it through, or one that wrote half the previous prompt or more */
function coldWriteOf(turnId: string): Sample | undefined {
  const i = samples.findIndex(x => x.turnId === turnId)
  if (i < 0) return undefined
  const prevTokens = i > 0 ? promptTokens(samples[i - 1]) : 0
  const first = samples[i]
  return isColdWrite(prevTokens, first.write, coldWritePending) ? first : undefined
}


/** what re-writing the last prompt costs, and what a warm turn would have read it for */
function coldPrice(): { tokens: number; cold: number | null; warm: number | null } {
  const last = samples[samples.length - 1]
  const tokens = last ? promptTokens(last) : 0
  const price = priceOf(last?.model ?? '')
  const write = writeRate(last?.model ?? '')
  return { tokens, cold: write == null ? null : (tokens * write) / 1e6, warm: price ? (tokens * price[0]) / 1e6 : null }
}

/** the band's and pane's segment while the cache is cold */
function coldStatus(now: number): string | undefined {
  if (coldSince(now) === undefined) return undefined
  const { tokens, cold } = coldPrice()
  return `❄ re-warm ${fmtTokens(tokens)} ≈ ${fmtUsd(cold)}`
}

function guardText(now: number): string {
  const since = coldSince(now) ?? now
  const { tokens, cold, warm } = coldPrice()
  return `the prompt cache went cold ${fmtDuration(now - since)} ago. Sending this re-writes about ${fmtTokens(tokens)} tokens ≈ ${fmtUsd(cold)}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

let ackedAt = 0

// ---- experimental: list price as a share of the 5-hour plan window. The engine
// reports the window's percentUsed but not its size, so this session's spend at
// list price is set against how far the window moved. Each session writes its
// spend in the window under `spend:<sid>` in the shared store and the estimate
// sums them all; sessions without this mod (claude.ai, other machines) still
// make it read high.
const KEY_CALIB = 'calib.pctPerUsd'
const KEY_SPEND = 'spend'
/** this session's spend at list price, requests and keepwarm pings */
let spentUsd = 0
/** the window this session last wrote its spend for, and spentUsd when that window began for it */
let winResetsAt: string | undefined
let winBase = 0
/** where the window and every session's spend stood when this window was first seen */
let anchor: { resetsAt: string; pct: number; usd: number } | undefined
/** the last estimate: percent of the 5-hour window per list-price dollar */
let pctPerUsd: number | undefined
/** sessions that wrote their spend in the last 10 minutes, this one included */
let activeSessions = 0

/** a call's list price: cache read, cache write at the TTL in force, uncached input at base (half the 1h write rate), output */
function usdOf(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, model: string): number | null {
  const price = priceOf(model)
  const rate = writeRate(model)
  if (!price || rate == null) return null
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * rate + (u.input_tokens * price[1]) / 2 + u.output_tokens * price[2]) / 1e6
}

/** after a turn: move the anchor on a new window, otherwise update the estimate */
async function calibrate($: EngineInterface) {
  const w = (await $.session.usage().catch(() => undefined))?.rateLimits?.find(x => x.kind === 'five_hour')
  if (!w || !w.resetsAt) return
  const mine = keyOf(KEY_SPEND)
  if (winResetsAt !== w.resetsAt) {
    // a reload zeroes spentUsd: carry on from what this session wrote for the same window
    const saved = winResetsAt === undefined ? ((await $.store.get(mine)) as Partial<Spend> | undefined) : undefined
    winBase = saved?.resetsAt === w.resetsAt && typeof saved.usd === 'number' ? spentUsd - saved.usd : spentUsd
    winResetsAt = w.resetsAt
  }
  const now = Date.now()
  await $.store.set(mine, { resetsAt: w.resetsAt, usd: spentUsd - winBase, at: now } satisfies Spend)
  // ponytail: one JSON file for every session, two writing at once can drop one write; the next turn rewrites it
  const keys = (await $.store.keys()).filter(k => k.startsWith(`${KEY_SPEND}:`))
  const all = await Promise.all(keys.map(async k => [k, await $.store.get(k)] as [string, unknown]))
  const { usd, active, stale } = windowSpend(all, w.resetsAt, now)
  activeSessions = active
  for (const k of stale) await $.store.delete(k)
  if (!anchor || anchor.resetsAt !== w.resetsAt || w.percentUsed < anchor.pct) {
    anchor = { resetsAt: w.resetsAt, pct: w.percentUsed, usd }
    return
  }
  const r = calibRate(anchor.pct, anchor.usd, w.percentUsed, usd)
  if (r !== undefined) {
    pctPerUsd = r
    await $.store.set(KEY_CALIB, r)
  }
}

const sessionsText = () => `${activeSessions} active session${activeSessions === 1 ? '' : 's'}`

function pushSample(sample: Sample) {
  samples.push(sample)
  if (samples.length > KEEP) samples = samples.slice(-KEEP)
  lastKey = ''
}

export const register: Register = (on, options) => {
  const policy: Policy = {
    warnMs: positive(options.warnSeconds, 60) * 1000,
    compactAtTokens: positive(options.compactAtTokens, 100_000),
  }
  const showBand = options.band !== false
  const showBreakdown = options.breakdown !== false
  const showStatus = options.status === true
  const wantToast = options.toast !== false
  const guard: GuardMode = options.guard === 'warn' || options.guard === 'off' ? options.guard : 'refuse'

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    samples = []
    lastKey = ''
    toastedFor = 0
    const none = () => undefined
    env = {
      enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(none),
      force5m: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(none),
      ttlVar: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(none),
      disableAll: await $.env.get('DISABLE_PROMPT_CACHING').catch(none),
      disableHaiku: await $.env.get('DISABLE_PROMPT_CACHING_HAIKU').catch(none),
      disableSonnet: await $.env.get('DISABLE_PROMPT_CACHING_SONNET').catch(none),
      disableOpus: await $.env.get('DISABLE_PROMPT_CACHING_OPUS').catch(none),
    }
    pinned = options.ttl === '5m' || options.ttl === '1h'
    observed = undefined
    setting = await readSetting($)
    account = accountOf((await $.session.usage().catch(() => undefined))?.rateLimits ?? [])
    const choice = decideTtl(options.ttl, env, setting, account)
    baseTtl = choice.ttl
    ttl = baseTtl
    envSource = choice.source
    ttlSource = envSource

    await $.command
      .register({
        name: COMMAND,
        description: 'Prompt-cache usage per turn and the time left before it lapses (stop closes)',
        argumentHint: '[stop]',
        immediate: true,
      })
      .catch(err => $.ui.log(`prompt-cache-control: /${COMMAND} not registered: ${err}`))
    $.ui.log(`prompt-cache-control loaded: ${ttl} cache (${ttlSource}), /${COMMAND} opens the table`, { to: 'debug' })

    // a reload with status turned off leaves the previous load's entry behind
    if (!showStatus) $.ui.status(undefined)
    spentUsd = 0
    winResetsAt = undefined
    winBase = 0
    activeSessions = 0
    anchor = undefined
    const savedRate = await $.store.get(KEY_CALIB).catch(() => undefined)
    pctPerUsd = typeof savedRate === 'number' && savedRate > 0 ? savedRate : undefined
    // keepwarm failing to start must not take the meter down with it
    try {
      await keepwarmStart($)
    } catch (err) {
      $.ui.log(`prompt-cache-control: /keepwarm not started: ${err}`, { to: 'debug' })
    }
    timer?.cancel()
    timer = $.clock.every(1000, () => {
      const now = Date.now()
      const { last, advice, left } = current(policy, now)
      const key = `${advice.kind}|${advice.text}|${left > 0 ? fmtClock(left) : ''}|${keepwarmStatus(now)?.text ?? ''}|${coldStatus(now) ?? ''}`
      if (key !== lastKey) {
        lastKey = key
        if (showStatus) $.ui.status(shortLine(policy, now))
        $.ui.invalidate('ui.render')
      }
      if (wantToast && last && left > 0 && promptTokens(last) >= TOAST_MIN_TOKENS) {
        if (toastedFor !== last.startedAt) {
          toastedFor = last.startedAt
          toastLevel = Infinity
        }
        // the first toast comes at warnSeconds, then 10, 3, 2 and 1 seconds; a late tick skips to the newest one
        const secs = Math.ceil(left / 1000)
        const mark = nextToastMark(secs, policy.warnMs / 1000, toastLevel)
        if (mark !== undefined) {
          toastLevel = mark
          const tail = secs <= COUNTDOWN_MARKS[0] ? 'send a message now' : `send a message to keep ${fmtTokens(promptTokens(last))} tokens warm`
          $.ui.toast(`cache expires in ${secs >= 60 ? fmtClock(left) : `${secs}s`}: ${tail}`)
        }
      }
    })
    return r
  })

  on('session.end', async ($, e, next) => {
    await keepwarmEnd($, e.reason)
    // /clear starts a new conversation in the same process: its cache is a new one
    if (e.reason === 'clear') {
      samples = []
      lastKey = ''
      toastedFor = 0
      observed = undefined
      ttl = baseTtl
      ttlSource = envSource
      $.ui.invalidate('ui.render')
      return next(e)
    }
    timer?.cancel()
    timer = undefined
    return next(e)
  })

  // each main-loop request: what the cache did with it
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const startedAt = Date.now()
    const r = yield* next(e)
    if (r.usage) {
      samples.push({
        turnId: e.turnId,
        index: e.index,
        model: r.usage.model || e.model,
        startedAt,
        read: r.usage.cache_read_input_tokens,
        write: r.usage.cache_creation_input_tokens,
        fresh: r.usage.input_tokens,
        output: r.usage.output_tokens,
      })
      if (samples.length > KEEP) samples = samples.slice(-KEEP)
      if (!pinned) {
        // the account can change under a session: a subscription running out of plan usage moves to usage credits
        account = accountOf((await $.session.usage().catch(() => undefined))?.rateLimits ?? [])
        const choice = decideTtl(options.ttl, env, setting, account)
        baseTtl = choice.ttl
        envSource = choice.source
        if (observed === undefined) {
          ttl = baseTtl
          ttlSource = envSource
        }
        const seen = observeTtl(samples[samples.length - 2], samples[samples.length - 1], observed)
        if (seen !== observed) {
          observed = seen
          ttl = seen ?? baseTtl
          ttlSource = `observed from request timing; ${envSource} said ${baseTtl}`
          $.ui.log(`prompt-cache-control: cache lifetime is ${ttl} (${ttlSource})`, { to: 'debug' })
        }
      }
      lastKey = ''
      if (showStatus) $.ui.status(shortLine(policy, Date.now()))
      $.ui.invalidate('ui.render')
    }
    return r
  })

  /** the pane as plain lines, for where nothing draws it (Remote Control) */
  function textSummary(now: number): string {
    const { last, advice, left } = current(policy, now)
    const kwi = keepwarmInfo(now)
    const { tokens, cold, warm } = coldPrice()
    const isColdNow = coldSince(now) !== undefined
    const price = priceOf(last?.model ?? '')
    const rate = writeRate(last?.model ?? '')
    const breakEven = price && rate ? Math.floor(rate / price[0]) : undefined
    const paid = misses.reduce((a, m) => a + (m.usd ?? 0), 0)
    const counting = !!last && advice.kind !== 'uncached' && advice.kind !== 'off'
    const row = (label: string, value: string) => `${label.padEnd(LABEL_W)}${value}`
    const lines = [`cache: ${advice.text}`]
    lines.push(row('lifetime', `${ttl} (${ttlSource})`))
    if (counting) lines.push(row('expires in', left > 0 ? fmtClock(left) : '0:00'))
    if (last) {
      lines.push(row('model', last.model))
      lines.push(row('prompt', `${fmtTokens(promptTokens(last))} tokens`))
      lines.push(row('last request', `${pct1(hitRatio(last))} hit · read ${fmtTokens(last.read)} · wrote ${fmtTokens(last.write)} · new ${fmtTokens(last.fresh)}`))
    }
    lines.push(row('keepwarm', kwi.stopped ? `stopped: ${kwi.stopped}`
      : kwi.on ? `${fmtDuration(kwi.left)} left · next ping ${kwi.next ?? ''} · every ${fmtDuration(kwi.every)}`
      : kwi.always ? 'off until next session (always)' : 'off (/keepwarm arms 6h)'))
    if (kwi.lastPing) lines.push(row('last ping', `${fmtTokens(kwi.lastPing.read)} read · ${fmtUsd(kwi.lastPing.usd)}`))
    if (breakEven !== undefined) lines.push(row('break-even', `${breakEven} pings = one cold write, ~${fmtDuration(breakEven * kwi.every)} idle`))
    if (last && cold != null) {
      lines.push(row('cold write', `${fmtUsd(cold)} ${isColdNow ? `· cold now: the next message re-writes ${fmtTokens(tokens)}` : `to re-write ${fmtTokens(tokens)}`}` +
        (warm != null ? ` (warm turn ${fmtUsd(warm)})` : '')))
    }
    lines.push(row('guard', guard === 'refuse' ? 'refuse once' : guard === 'warn' ? 'warn only' : 'off'))
    if (pctPerUsd !== undefined && cold != null && warm != null) {
      lines.push(row('5h window', `≈ ${(cold * pctPerUsd).toFixed(1)}% cold · ${(warm * pctPerUsd).toFixed(1)}% warm (experimental, ${sessionsText()})`))
    }
    lines.push(row('this session', `${misses.length} cold write${misses.length === 1 ? '' : 's'} · ${fmtUsd(paid)}`))
    return lines.join('\n')
  }

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'stop') {
      await $.ui.close({ id: PANE }).catch(() => undefined)
      isPaneOpen = false
      return { text: 'cache table closed' }
    }
    // nothing draws the pane under Remote Control: answer in text
    const surfaces = await $.session.surfaces().catch(() => [])
    if (arg === 'text' || surfaces.length === 0) return { text: textSummary(Date.now()) }
    await openPane($)
    const { advice } = current(policy, Date.now())
    return { text: `${ttl} cache (${ttlSource}) · ${advice.text} · /${COMMAND} stop closes` }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    isPaneOpen = false
    return next(e)
  })

  on('ui.press', async ($, e, next) => {
    if (e.plugin !== $.plugin.name || e.requestId !== PANE) return next(e)
    if (e.element === 'close') await $.ui.close({ id: PANE }).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!showBand || e.props.hasSurvey || isPaneOpen) return next(e)
    const { last, advice, left } = current(policy, Date.now())
    if (!last && advice.kind !== 'off') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 100
    const color = COLOR[advice.kind]
    // other mods' rows above the prompt come back from next(e); ours goes under them
    const rest = await next(e)

    if (!last) return <Box flexDirection="column">{rest}<Text dimColor>{fit(`cache: ${advice.text}`, columns)}</Text></Box>

    const ratio = hitRatio(last)
    const wide = columns >= 90
    const kw = keepwarmStatus(Date.now())
    const cold = coldStatus(Date.now())
    return (
      <Box flexDirection="column">
      {rest}
      <Box flexDirection="row" columnGap={1}>
        <Text bold color={color}>{advice.kind === 'warm' ? '●' : advice.kind === 'soon' ? '▲' : advice.kind === 'off' || advice.kind === 'cold' || advice.kind === 'uncached' ? '○' : '✖'}</Text>
        <Text bold color="cyan">cache</Text>
        <Text color={color}>{bar(ratio, wide ? 10 : 6)}</Text>
        <Text bold>{pct1(ratio)}</Text>
        {!showBreakdown ? null : wide ? (
          <>
            <Text color="green">{`read ${fmtTokens(last.read)}`}</Text>
            <Text color="yellow">{`wrote ${fmtTokens(last.write)}`}</Text>
            <Text color="cyan">{`new ${fmtTokens(last.fresh)}`}</Text>
          </>
        ) : (
          <Text dimColor>{`${fmtTokens(promptTokens(last))} tok`}</Text>
        )}
        {advice.kind !== 'uncached' && advice.kind !== 'off' && (
          <Text bold color={left > 0 ? lifeColor(left, ttl, policy.warnMs) : 'red'}>{left > 0 ? `⏱ ${fmtClock(left)}` : '⏱ 0:00'}</Text>
        )}
        {kw && <Text color={kw.stopped ? 'red' : 'magenta'}>{kw.text}</Text>}
        {cold && <Text color="cyan">{cold}</Text>}
        <Button key="open" label="details" onPress={() => openPane($)} />
        <Text dimColor wrap="truncate-end">{`${ttl} · ${advice.text}`}</Text>
      </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(30, e.props.bodyColumns - 1)
    // HTML collapses runs of spaces and trims a text's ends; a no-break space keeps them
    const sp = (t: string) => (e.surface === 'terminal' ? t : t.replace(/ /g, ' '))
    const now = Date.now()
    const { last, advice, left } = current(policy, now)
    const kw = keepwarmStatus(now)
    const all = byTurn(samples)
    const counting = !!last && advice.kind !== 'uncached' && advice.kind !== 'off'
    // the countdown goes green, then yellow, then red as the cache runs out
    const clockColor = counting ? lifeColor(left, ttl, policy.warnMs) : undefined
    const stateColor = advice.kind === 'expired' || advice.kind === 'miss' ? 'red' : (clockColor ?? COLOR[advice.kind])
    const hitColor = (pct: number) => (pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : 'red')
    // solid bars are filled Boxes, not block characters, so HTML draws no seams between cells
    const solid = (key: string, parts: [number, string | undefined][]) => (
      <Box key={key} flexDirection="row" height={1} flexShrink={0}>
        {parts.map(([w, c], i) => (w > 0 ? <Box key={`${key}:${i}`} width={w} height={1} flexShrink={0} backgroundColor={c} /> : null))}
      </Box>
    )
    const cell = (key: string, w: number, text: string, c?: string, bold = false) => (
      <Box key={key} width={w} flexShrink={0} justifyContent="flex-end">
        <Text color={c} bold={bold} dimColor={!c}>{sp(text)}</Text>
      </Box>
    )

    const barW = Math.max(8, Math.min(width - LABEL_W - 10, 32))
    const life = lifeRatio(left, ttl)
    const lifeFilled = Math.round(life * barW)
    const [sr, sw, sn] = last ? segments(last.read, last.write, last.fresh, barW) : [0, 0, 0]
    const rows = all.slice(-Math.max(3, (e.viewport?.rows ?? 24) - 30))
    const icon = advice.kind === 'warm' ? '●' : advice.kind === 'soon' ? '▲' : advice.kind === 'expired' || advice.kind === 'miss' ? '✖' : '○'
    const kwi = keepwarmInfo(now)
    const { tokens, cold, warm } = coldPrice()
    const isColdNow = coldSince(now) !== undefined
    const price = priceOf(last?.model ?? '')
    const rate = writeRate(last?.model ?? '')
    const breakEven = price && rate ? Math.floor(rate / price[0]) : undefined
    const paid = misses.reduce((a, m) => a + (m.usd ?? 0), 0)

    // a section: a title, then label/value rows under it
    const section = (key: string, title: string, children: RenderChildren[]) => (
      <Box key={key} flexDirection="column" marginTop={1}>
        <Text bold color="cyan">{sp(title)}</Text>
        {children}
      </Box>
    )
    // one row: the label dim in a fixed column, the value after it
    const row = (key: string, label: string, ...value: RenderChildren[]) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        <Box width={LABEL_W} flexShrink={0}>
          <Text dimColor>{sp(label)}</Text>
        </Box>
        {value}
      </Box>
    )
    const bar = (key: string, ratio: number, c: string) => {
      const w = Math.max(0, Math.min(barW, Math.round(ratio * barW)))
      return solid(key, [[w, c], [barW - w, 'gray']])
    }

    return (
      <Box flexDirection="column">
        <Box key="title" flexDirection="row" columnGap={1}>
          <Text bold color="cyan">{sp('⚡ PROMPT CACHE')}</Text>
          <Text bold color={stateColor}>{sp(`${icon} ${advice.text}`)}</Text>
        </Box>

        {section('cache', 'CACHE', [
          row('c:ttl', 'lifetime', <Text key="v" bold>{sp(ttl)}</Text>, <Text key="s" dimColor>{sp(`(${ttlSource})`)}</Text>),
          row('c:left', 'expires in',
            counting ? solid('life', [[lifeFilled, clockColor], [barW - lifeFilled, 'gray']]) : null,
            <Text key="v" bold color={clockColor}>{sp(counting ? (left > 0 ? fmtClock(left) : '0:00') : '--:--')}</Text>),
          last ? row('c:model', 'model', <Text key="v" bold>{sp(last.model)}</Text>) : null,
          last ? row('c:prompt', 'prompt', <Text key="v" bold>{sp(`${fmtTokens(promptTokens(last))} tokens`)}</Text>) : null,
        ])}

        {last ? section('req', 'LAST REQUEST', [
          row('r:hit', 'hit rate', solid('stack', [[sr, 'green'], [sw, 'yellow'], [sn, 'cyan']]),
            <Text key="v" bold color={hitColor(Math.round(hitRatio(last) * 100))}>{sp(pct1(hitRatio(last)))}</Text>),
          row('r:read', 'read', <Text key="v" bold color="green">{sp(`■ ${fmtTokens(last.read)}`)}</Text>, <Text key="s" dimColor>{sp('served by the cache')}</Text>),
          row('r:wrote', 'wrote', <Text key="v" bold color="yellow">{sp(`■ ${fmtTokens(last.write)}`)}</Text>, <Text key="s" dimColor>{sp('new cache entry')}</Text>),
          row('r:new', 'new', <Text key="v" bold color="cyan">{sp(`■ ${fmtTokens(last.fresh)}`)}</Text>, <Text key="s" dimColor>{sp('sent uncached')}</Text>),
        ]) : null}

        {section('kw', 'KEEPWARM', [
          kwi.stopped
            ? row('k:state', 'status', <Text key="v" bold color="red">{sp(`stopped: ${kwi.stopped}`)}</Text>)
            : kwi.on
              ? row('k:state', 'window', bar('kwbar', kwi.left / kwi.window, 'magenta'),
                  <Text key="v" bold color="magenta">{sp(`${fmtDuration(kwi.left)} left`)}</Text>)
              : row('k:state', 'status', <Text key="v" bold>{sp(kwi.always ? 'off until next session (always)' : 'off')}</Text>, <Text key="s" dimColor>{sp('/keepwarm arms 6h')}</Text>),
          kwi.on ? row('k:next', 'next ping', <Text key="v" bold>{sp(kwi.next ?? '')}</Text>, <Text key="s" dimColor>{sp(`every ${fmtDuration(kwi.every)}`)}</Text>) : null,
          kwi.lastPing ? row('k:last', 'last ping', <Text key="v" bold>{sp(`${fmtTokens(kwi.lastPing.read)} read · ${fmtUsd(kwi.lastPing.usd)}`)}</Text>) : null,
          breakEven !== undefined ? row('k:be', 'break-even', <Text key="v" bold>{sp(`${breakEven} pings`)}</Text>,
            <Text key="s" dimColor>{sp(`= one cold write, ~${fmtDuration(breakEven * kwi.every)} idle`)}</Text>) : null,
        ])}

        {section('cost', 'COST', [
          last && cold != null ? row('$:cold', 'cold write', bar('coldbar', 1, isColdNow ? 'red' : 'yellow'),
            <Text key="v" bold color={isColdNow ? 'red' : 'yellow'}>{sp(fmtUsd(cold))}</Text>,
            <Text key="s" dimColor>{sp(isColdNow ? `cold now: the next message re-writes ${fmtTokens(tokens)}` : `to re-write ${fmtTokens(tokens)}`)}</Text>) : null,
          last && warm != null && cold ? row('$:warm', 'warm turn', bar('warmbar', Math.max(warm / cold, 1 / barW), 'green'),
            <Text key="v" bold color="green">{sp(fmtUsd(warm))}</Text>) : null,
          row('$:guard', 'guard', <Text key="v" bold>{sp(guard === 'refuse' ? 'refuse once' : guard === 'warn' ? 'warn only' : 'off')}</Text>,
            <Text key="s" dimColor>{sp('on a cold cache of 50k+ tokens')}</Text>),
          pctPerUsd !== undefined && cold != null && warm != null
            ? row('$:plan', '5h window', <Text key="v" bold color="magenta">{sp(`≈ ${(cold * pctPerUsd).toFixed(1)}% cold · ${(warm * pctPerUsd).toFixed(1)}% warm`)}</Text>,
                <Text key="s" dimColor>{sp(`🧪 experimental · ${pctPerUsd.toFixed(2)}% per $ · ${sessionsText()}`)}</Text>)
            : anchor
              ? row('$:plan', '5h window', <Text key="v" dimColor>{sp(`🧪 calibrating… · ${sessionsText()}`)}</Text>)
              : null,
          row('$:session', 'this session', <Text key="v" bold color={misses.length ? 'red' : undefined}>{sp(`${misses.length} cold write${misses.length === 1 ? '' : 's'} · ${fmtUsd(paid)}`)}</Text>),
        ])}

        {section('turns', 'TURNS', [
          <Box key="head" flexDirection="row" columnGap={1}>
            {cell('h:turn', 4, 'turn', 'cyan', true)}
            {cell('h:steps', 5, 'steps', 'cyan', true)}
            {cell('h:read', 6, 'read', 'green', true)}
            {cell('h:wrote', 6, 'wrote', 'yellow', true)}
            {cell('h:new', 5, 'new', 'cyan', true)}
            {cell('h:hit', 6, 'hit', 'magenta', true)}
          </Box>,
          rows.length === 0 ? <Text key="none" dimColor>{sp('no requests yet')}</Text> : null,
          ...rows.map((r, i) => {
            const n = all.length - rows.length + i + 1
            const pct = Math.round(rowRatio(r) * 100)
            return (
              <Box key={`t:${r.turnId}`} flexDirection="row" columnGap={1}>
                {cell(`c:turn:${r.turnId}`, 4, r.turnId.startsWith('keepwarm-') ? '♨' : String(n))}
                {cell(`c:steps:${r.turnId}`, 5, String(r.steps))}
                {cell(`c:read:${r.turnId}`, 6, fmtTokens(r.read), 'green')}
                {cell(`c:wrote:${r.turnId}`, 6, fmtTokens(r.write), 'yellow')}
                {cell(`c:new:${r.turnId}`, 5, fmtTokens(r.fresh), 'cyan')}
                {cell(`c:hit:${r.turnId}`, 6, pct1(rowRatio(r)), hitColor(pct), true)}
              </Box>
            )
          }),
        ])}

        <Box key="foot" marginTop={1}>
          <Button key="close" label="close" onPress={() => {}} />
        </Box>
      </Box>
    )
  })

  // a message to a cold cache: refused once with its price (guard: refuse), or sent with the price logged (warn)
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = Date.now()
    const last = samples[samples.length - 1]
    if (!last) return next(e)
    const verdict = guardVerdict({ mode: guard, coldAt: coldSince(now), tokens: promptTokens(last), startedAt: last.startedAt, ackedAt })
    if (verdict === 'pass') return next(e)
    if (verdict === 'warn') {
      $.ui.log(`prompt-cache-control: ${guardText(now)} Sending anyway; keepwarm will hold the cache for ${fmtDuration(AUTO_WARM_MS)} once it lands.`)
      coldWritePending = true
      return next(e)
    }
    if (verdict === 'resend') {
      ackedAt = 0
      coldWritePending = true
      return next(e)
    }
    ackedAt = last.startedAt
    return { drop: `prompt-cache-control: ${guardText(now)} Send it again to pay it, and keepwarm will then hold the cache for ${fmtDuration(AUTO_WARM_MS)}. Or /clear and start from a note.` }
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      compacted = true
      await arm($)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    compacted = false
    if (e.usage) {
      const usd = usdOf(e.usage, e.usage.model || (samples[samples.length - 1]?.model ?? ''))
      if (usd != null) spentUsd += usd
    }
    await calibrate($).catch(() => undefined)
    const paid = coldWriteOf(e.turnId)
    coldWritePending = false
    if (paid) {
      const rate = writeRate(paid.model)
      const usd = rate == null ? null : (paid.write * rate) / 1e6
      misses.push({ at: paid.startedAt, tokens: paid.write, usd })
      // a cold write was just paid: keep it from being paid again today
      if (deadline < Date.now() + AUTO_WARM_MS) {
        await startWindow($, AUTO_WARM_MS, every)
        $.ui.log(`prompt-cache-control: cold write of ${fmtTokens(paid.write)} tokens paid (${fmtUsd(usd)}). Keeping the cache warm for ${fmtDuration(AUTO_WARM_MS)} so it is not paid again today; /keepwarm off to stop.`)
      }
    }
    await arm($)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    if (words[0] === 'off') {
      const wasAlways = always
      await stop($, null, true)
      return { text: wasAlways ? 'keepwarm is off, and no longer arms itself at session start' : 'keepwarm is off' }
    }
    if (words[0] === 'always') {
      always = true
      await $.store.set(KEY_ALWAYS, true)
      await startWindow($, DEFAULT_WINDOW_MS, 0)
      return { text: `keepwarm always on: every session starts with a ${fmtDuration(DEFAULT_WINDOW_MS)} window; /keepwarm off turns it off for good` }
    }
    if (!words.length) {
      await startWindow($, DEFAULT_WINDOW_MS, 0)
      return { text: armedText(DEFAULT_WINDOW_MS) }
    }
    if (words[0] === 'status') return { text: statusLine(Date.now()) ?? 'keepwarm is off' }
    const windowMs = parseDuration(words[0])
    if (windowMs == null) return { text: 'keepwarm takes a window such as 6h or 90m, or always, off, or status' }
    let everyMs = 0
    if (words[1] === 'every') {
      const p = parseDuration(words[2] ?? '')
      if (p == null || p < MIN_PING_MS) return { text: 'every takes a period of at least 1m' }
      everyMs = p
    }
    await startWindow($, windowMs, everyMs)
    return { text: armedText(windowMs) }
  })
}

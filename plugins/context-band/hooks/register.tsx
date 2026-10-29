/**
 * context-band — a row above the prompt on the desktop app: working directory · git branch · skill.
 *
 *   - the branch is read from .git/HEAD (worktrees: the `gitdir:` file), no git process
 *   - the skill is the last Skill tool call since your last message; a skill run as a
 *     slash command does not go through that tool and is not shown
 *   - refreshed at session start, on each prompt, after each tool call and turn
 *   - /context-band (or the band's ⚙) opens a pane that turns each part on or off;
 *     the choice is kept across sessions
 */
import type { EngineInterface, Register } from 'claude-code'

const PANE = 'context-band'
const COMMAND = 'context-band'
const KEY_SHOW = 'show'

/** what the band shows; each is a toggle in the pane */
export type Show = { cwd: boolean; branch: boolean; skill: boolean; noSkill: boolean }
export const DEFAULT_SHOW: Show = { cwd: true, branch: true, skill: true, noSkill: true }
const LABELS: [keyof Show, string][] = [
  ['cwd', '📁 working directory'],
  ['branch', '⎇ git branch'],
  ['skill', '⚡ skill loaded'],
  ['noSkill', '⚡ "no skill" when none is loaded'],
]

/** a stored value read back over the defaults; anything not a boolean is dropped */
export function parseShow(v: unknown): Show {
  const out = { ...DEFAULT_SHOW }
  if (v && typeof v === 'object') {
    for (const [k] of LABELS) {
      const b = (v as Record<string, unknown>)[k]
      if (typeof b === 'boolean') out[k] = b
    }
  }
  return out
}

let cwd = ''
let branch: string | undefined
let skill: string | undefined
let show: Show = { ...DEFAULT_SHOW }

async function toggle($: EngineInterface, k: keyof Show) {
  show = { ...show, [k]: !show[k] }
  $.ui.invalidate('ui.render')
  await $.store.set(KEY_SHOW, show).catch(err => $.ui.log(`context-band: ${err}`, { to: 'debug' }))
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'context band', focus: true })

const norm = (p: string) => {
  let s = p.split('\\').join('/')
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}
const isAbs = (p: string) => p.startsWith('/') || p.charAt(1) === ':'

/** the branch of the repo holding `dir`, a short sha when detached, undefined outside a repo */
export type Fs = { exists: (p: string) => Promise<boolean>; read: (p: string) => Promise<string> }

export async function branchOf(fs: Fs, dir: string): Promise<string | undefined> {
  for (let d = norm(dir); d; ) {
    const dotgit = `${d}/.git`
    if (await fs.exists(dotgit)) {
      let head: string
      try {
        head = await fs.read(`${dotgit}/HEAD`)
      } catch {
        // a worktree or submodule: .git is a file naming the real git dir
        const m = /^gitdir:\s*(.+)$/m.exec(await fs.read(dotgit))
        if (!m) return undefined
        const gd = norm(m[1].trim())
        head = await fs.read(`${isAbs(gd) ? gd : `${d}/${gd}`}/HEAD`)
      }
      const line = head.trim()
      const prefix = 'ref: refs/heads/'
      return line.startsWith(prefix) ? line.slice(prefix.length) : line.slice(0, 7)
    }
    const cut = d.lastIndexOf('/')
    const up = cut > 0 ? d.slice(0, cut) : ''
    if (!up || up === d || up.endsWith(':')) return undefined
    d = up
  }
  return undefined
}

async function refresh($: EngineInterface) {
  try {
    const now = await $.session.cwd()
    const b = await branchOf({ exists: p => $.fs.exists(p), read: p => $.fs.read(p) }, now).catch(() => undefined)
    if (now !== cwd || b !== branch) {
      cwd = now
      branch = b
      $.ui.invalidate('ui.render')
    }
  } catch (err) {
    $.ui.log(`context-band: ${err}`, { to: 'debug' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    skill = undefined
    show = parseShow(await $.store.get(KEY_SHOW).catch(() => undefined))
    await $.command.register({
      name: COMMAND,
      description: 'Choose what the context band shows above the prompt',
      immediate: true,
    })
    await refresh($)
    return r
  })

  on('command.run', { command: COMMAND }, async $ => {
    await openPane($)
    return { text: 'context band settings opened' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'plugin') {
      skill = undefined
      $.ui.invalidate('ui.render')
      await refresh($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Skill' && typeof (e as { skill?: unknown }).skill === 'string') {
      skill = (e as { skill: string }).skill
      $.ui.invalidate('ui.render')
    }
    const r = await next(e)
    await refresh($)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await refresh($)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    // the terminal's status line already shows these
    if (e.surface !== 'desktop' || e.props.hasSurvey || !cwd) return rest
    const { Box, Text, Button } = $.ui.resolve(e)
    const skillPart = skill
      ? show.skill ? <Text key="skill" color="yellow">{`⚡ ${skill}`}</Text> : null
      : show.noSkill ? <Text key="skill" dimColor>⚡ no skill</Text> : null
    return (
      <Box flexDirection="column">
        {rest}
        {/* a gap under the rows above (the cache band), only when there are any */}
        <Box flexDirection="row" columnGap={2} marginTop={rest ? 1 : 0}>
          {show.cwd ? <Text key="cwd" color="blue" wrap="truncate-start">{`📁 ${cwd}`}</Text> : null}
          {show.branch && branch ? <Text key="branch" color="green">{`⎇ ${branch}`}</Text> : null}
          {skillPart}
          <Button key="settings" label="⚙" plain dimColor onPress={() => void openPane($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" rowGap={1}>
        <Text dimColor>What the band above the prompt shows (desktop app):</Text>
        {LABELS.map(([k, label]) => (
          <Box key={`row:${k}`} flexDirection="row" columnGap={1}>
            <Button key={k} label={show[k] ? 'on ' : 'off'} variant={show[k] ? 'primary' : 'secondary'} onPress={() => void toggle($, k)} />
            <Text dimColor={!show[k]}>{label}</Text>
          </Box>
        ))}
        <Box key="foot">
          <Button key="close" label="close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}

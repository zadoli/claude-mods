/**
 * context-band — a row above the prompt on the desktop app: working directory · git branch · skill.
 *
 *   - the branch is read from .git/HEAD (worktrees: the `gitdir:` file), no git process
 *   - the skill is the last Skill tool call since your last message; a skill run as a
 *     slash command does not go through that tool and is not shown
 *   - refreshed at session start, on each prompt, after each tool call and turn
 */
import type { EngineInterface, Register } from 'claude-code'

let cwd = ''
let branch: string | undefined
let skill: string | undefined

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
    await refresh($)
    return r
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
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {rest}
        {/* a gap under the rows above (the cache band), only when there are any */}
        <Box flexDirection="row" columnGap={2} marginTop={rest ? 1 : 0}>
          <Text color="blue" wrap="truncate-start">{`📁 ${cwd}`}</Text>
          {branch ? <Text color="green">{`⎇ ${branch}`}</Text> : null}
          {skill ? <Text color="yellow">{`⚡ ${skill}`}</Text> : null}
        </Box>
      </Box>
    )
  })
}

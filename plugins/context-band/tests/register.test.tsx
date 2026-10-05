// Run with: claude plugin test ~/.claude/skills/context-band
import { describe, expect, test } from 'claude-code/testing'
import { branchOf } from '../hooks/register.tsx'

const fakeFs = (files: Record<string, string>) => ({
  exists: async (p: string) => Object.keys(files).some(f => f === p || f.startsWith(`${p}/`)),
  read: async (p: string) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`)
    return files[p]
  },
})

describe('branchOf', () => {
  test('walks up to the repo root and reads the branch', async () => {
    const fs = fakeFs({ 'D:/repo/.git/HEAD': 'ref: refs/heads/feature/x\n' })
    expect(await branchOf(fs, 'D:\\repo\\src\\deep')).toBe('feature/x')
  })

  test('a detached HEAD gives a short sha; outside a repo, nothing', async () => {
    const fs = fakeFs({ 'D:/repo/.git/HEAD': '0123456789abcdef\n' })
    expect(await branchOf(fs, 'D:/repo')).toBe('0123456')
    expect(await branchOf(fs, 'E:/elsewhere')).toBeUndefined()
  })

  test('a worktree follows the gitdir file', async () => {
    const fs = fakeFs({
      'D:/wt/.git': 'gitdir: D:/repo/.git/worktrees/wt\n',
      'D:/repo/.git/worktrees/wt/HEAD': 'ref: refs/heads/wt-branch\n',
    })
    expect(await branchOf(fs, 'D:/wt')).toBe('wt-branch')
  })
})

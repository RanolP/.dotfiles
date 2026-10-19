import { test, expect } from 'claude-code/testing'
import { rollbackTo, type Worktree, type WorktreeIo } from './worktree'

const repoRoot = '/tmp/clm-test/repo'
const worktreesRoot = '/tmp/clm-test/worktrees'
const baseSha = 'a'.repeat(40)

function worktree(dir: string): Worktree {
  return { dir, baseSha, originBranch: 'main', repoRoot, worktreesRoot, headSha: baseSha }
}

function fakeIo(calls: string[][]): WorktreeIo {
  return {
    run: async argv => {
      const args = [...argv]
      calls.push(args)
      const cwd = args[args.indexOf('-C') + 1]
      if (args.includes('list')) return { exitCode: 0, stdout: `worktree ${repoRoot}\n\n`, stderr: '' }
      if (args.includes('--show-toplevel')) return { exitCode: 0, stdout: `${cwd}\n`, stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
}

// Regression caught: rollbackTo runs reset --hard on a dir outside the worktrees root or absent from worktree list -- porcelain.
test('rollbackTo does not reset --hard a dir outside its root or absent from worktree list -- porcelain', async () => {
  const outsideCalls: string[][] = []
  let outsideError = ''
  try { await rollbackTo(fakeIo(outsideCalls), worktree(repoRoot), baseSha) } catch (error) { outsideError = String(error) }
  expect(outsideError).toContain('refusing worktree operation outside the worktrees root')
  expect(outsideCalls.some(argv => argv.includes('reset') || argv.includes('clean'))).toBe(false)

  const missingCalls: string[][] = []
  let missingError = ''
  try { await rollbackTo(fakeIo(missingCalls), worktree(`${worktreesRoot}/session/goal`), baseSha) } catch (error) { missingError = String(error) }
  expect(missingError).toContain('refusing operation on a path absent from the registered worktree list')
  expect(missingCalls.some(argv => argv.includes('reset') || argv.includes('clean'))).toBe(false)
})

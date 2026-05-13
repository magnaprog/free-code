import { describe, expect, test } from 'bun:test'
import { checkDangerousRemovalText } from './bashPermissions.js'
import {
  checkDangerousRemovalArgv,
  isRemovalArgv,
} from './pathValidation.js'

const cwd = '/home/user/project'

describe('dangerous removal argv checks', () => {
  test('detects dangerous removals behind env assignments and safe wrappers', () => {
    const cases = [
      ['rm', '-rf', '/'],
      ['FOO=bar', 'rm', '-rf', '/'],
      ['FOO+=bar', 'rm', '-rf', '/'],
      ['env', 'rm', '-rf', '/'],
      ['env', '-i', 'FOO=bar', 'rm', '-rf', '/'],
      ['stdbuf', '-o', '0', 'rm', '-rf', '/'],
      ['timeout', '5', 'rm', '-rf', '/'],
      ['nice', 'rm', '-rf', '/'],
      ['time', 'rm', '-rf', '/'],
      ['nohup', 'rmdir', '/tmp'],
    ]

    for (const argv of cases) {
      expect(isRemovalArgv(argv)).toBe(true)
      expect(checkDangerousRemovalArgv(argv, cwd).behavior).toBe('ask')
    }
  })

  test('passes through non-dangerous removal targets', () => {
    expect(isRemovalArgv(['rm', 'safe-file'])).toBe(true)
    expect(checkDangerousRemovalArgv(['rm', 'safe-file'], cwd).behavior).toBe(
      'passthrough',
    )
  })
})

describe('checkDangerousRemovalText text-fallback path', () => {
  test('catches dangerous removals wrapped by privilege/exec wrappers', () => {
    const cases = [
      'sudo rm -rf /',
      'sudo -u root rm -rf /',
      'doas rm -rf /',
      'pkexec rm -rf /',
      'env -i sudo rm -rf /',
      'nice timeout 5 rm -rf /',
      'stdbuf -o0 nice rm -rf /',
      'watch -n 1 rm -rf /',
      'setsid rm -rf /',
      'ionice -c 3 rm -rf /',
    ]

    for (const command of cases) {
      const { result, sawRemoval } = checkDangerousRemovalText(command, cwd)
      expect(sawRemoval).toBe(true)
      expect(result.behavior).toBe('ask')
    }
  })

  test('shell parameter expansion still resolves through the text path', () => {
    const { result, sawRemoval } = checkDangerousRemovalText(
      '${RM:-rm} -rf /',
      cwd,
    )
    expect(sawRemoval).toBe(true)
    expect(result.behavior).toBe('ask')
  })

  test('word-splits unquoted shell parameter expansion', () => {
    const { result, sawRemoval } = checkDangerousRemovalText(
      '${CMD:-rm -rf /}',
      cwd,
    )
    expect(sawRemoval).toBe(true)
    expect(result.behavior).toBe('ask')
  })

  test('safe rm passes through', () => {
    const { result, sawRemoval } = checkDangerousRemovalText(
      'rm ./build/artifact.o',
      cwd,
    )
    expect(sawRemoval).toBe(true)
    expect(result.behavior).toBe('passthrough')
  })

  test('non-removal commands report sawRemoval=false', () => {
    const { result, sawRemoval } = checkDangerousRemovalText(
      'ls -la /tmp',
      cwd,
    )
    expect(sawRemoval).toBe(false)
    expect(result.behavior).toBe('passthrough')
  })
})

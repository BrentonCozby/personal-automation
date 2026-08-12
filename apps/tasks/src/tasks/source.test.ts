import { AppError } from '@personal-automation/common/errors'
import { expect, it } from 'vitest'
import { createTaskSource } from './source.js'

it('returns a working source for the obsidian provider when a vault path is given', () => {
  const source = createTaskSource({ provider: 'obsidian', lists: [], vaultPath: '/tmp/vault' })

  expect(typeof source.list).toBe('function')
})

it('throws a clear AppError for the obsidian provider without a vault path', () => {
  expect(() => createTaskSource({ provider: 'obsidian', lists: [] })).toThrow(AppError)
  expect(() => createTaskSource({ provider: 'obsidian', lists: [] })).toThrow(/OBSIDIAN_VAULT_PATH/)
})

it('throws a clear not-implemented AppError for the google provider', () => {
  expect(() => createTaskSource({ provider: 'google', lists: [] })).toThrow(AppError)
  expect(() => createTaskSource({ provider: 'google', lists: [] })).toThrow(/not implemented/)
})

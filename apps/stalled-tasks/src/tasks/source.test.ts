import { AppError } from '@personal-automation/common/errors'
import { expect, it } from 'vitest'
import { createTaskSource } from './source.js'

it('returns a working source for the apple provider', () => {
  const source = createTaskSource({ provider: 'apple', lists: [] })

  expect(typeof source.list).toBe('function')
})

it('throws a clear not-implemented AppError for the google provider', () => {
  expect(() => createTaskSource({ provider: 'google', lists: [] })).toThrow(AppError)
  expect(() => createTaskSource({ provider: 'google', lists: [] })).toThrow(/not implemented/)
})

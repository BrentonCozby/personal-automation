import { expect, it } from 'vitest'
import { hasErrorCode, isFileNotFound } from './errors.js'

function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

it('matches an error whose code is one of the codes given', () => {
  expect(hasErrorCode({ error: errnoError('ENOTDIR'), codes: ['ENOENT', 'ENOTDIR'] })).toBe(true)
})

it('does not match an error with another code, no code, or a thrown non-error', () => {
  expect(hasErrorCode({ error: errnoError('EACCES'), codes: ['ENOENT'] })).toBe(false)
  expect(hasErrorCode({ error: new Error('plain'), codes: ['ENOENT'] })).toBe(false)
  expect(hasErrorCode({ error: { code: 'ENOENT' }, codes: ['ENOENT'] })).toBe(false)
})

it('reads a missing file as not found', () => {
  expect(isFileNotFound(errnoError('ENOENT'))).toBe(true)
  expect(isFileNotFound(errnoError('EACCES'))).toBe(false)
})

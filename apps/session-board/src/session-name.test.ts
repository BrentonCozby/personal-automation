import { expect, it } from 'vitest'
import { isKebabCase, toKebabCase } from './session-name.js'

it('accepts the shape a progress-file slug takes', () => {
  expect(isKebabCase('soc2-dependabot-remediation')).toBe(true)
  expect(isKebabCase('impact')).toBe(true)
  expect(isKebabCase('mkpl-856')).toBe(true)
})

it('refuses what would never match a slug', () => {
  expect(isKebabCase('Impact Scoring')).toBe(false)
  expect(isKebabCase('impact scoring')).toBe(false)
  expect(isKebabCase('SOC2')).toBe(false)
  expect(isKebabCase('impact_scoring')).toBe(false)
})

it('refuses hyphens that lead, trail or double up', () => {
  expect(isKebabCase('-impact')).toBe(false)
  expect(isKebabCase('impact-')).toBe(false)
  expect(isKebabCase('impact--scoring')).toBe(false)
})

it('refuses an empty name, which is a cleared field rather than a name', () => {
  expect(isKebabCase('')).toBe(false)
})

it('turns what you would actually type into the name it should be', () => {
  expect(toKebabCase('Review Perf')).toBe('review-perf')
  expect(toKebabCase('non-prod envs')).toBe('non-prod-envs')
  expect(toKebabCase('SOC2')).toBe('soc2')
})

it('collapses a run of separators into one hyphen', () => {
  expect(toKebabCase('review   perf')).toBe('review-perf')
  expect(toKebabCase('review_-_perf')).toBe('review-perf')
})

it('trims the hyphens that punctuation leaves at either end', () => {
  expect(toKebabCase('  review perf!  ')).toBe('review-perf')
  expect(toKebabCase("don't ship")).toBe('don-t-ship')
})

it('answers empty when nothing usable was typed, which clears the name', () => {
  expect(toKebabCase('!!!')).toBe('')
  expect(toKebabCase('   ')).toBe('')
})

it('leaves a name that is already right exactly alone', () => {
  for (const name of ['impact', 'soc2-dependabot-remediation', 'mkpl-856']) {
    expect(toKebabCase(name)).toBe(name)
  }
})

it('always produces something the validator accepts, or nothing at all', () => {
  const typed = ['Review Perf', 'SOC2', "don't ship", '  a  ', '!!!', 'a--b', '-x-']

  for (const value of typed) {
    const result = toKebabCase(value)

    expect(result === '' || isKebabCase(result)).toBe(true)
  }
})

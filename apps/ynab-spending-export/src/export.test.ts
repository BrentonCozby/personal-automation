import type { MonthCategory } from '@personal-automation/ynab/types'
import { expect, it } from 'vitest'
import { exportSpending, fullMonthsBefore, toCsv } from './export.js'

function category(overrides: Partial<MonthCategory>): MonthCategory {
  return {
    id: 'c1',
    name: 'Groceries',
    hidden: false,
    deleted: false,
    category_group_id: 'g1',
    category_group_name: 'Monthly Flex',
    activity: 0,
    ...overrides,
  }
}

it('takes the last finished months the budget has, leaving out the current month', () => {
  const available = ['2026-03-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']

  expect(fullMonthsBefore({ available, today: '2026-10-15', count: 2 })).toEqual([
    '2026-08-01',
    '2026-09-01',
  ])
  expect(fullMonthsBefore({ available, today: '2026-10-15', count: 12 })).toEqual([
    '2026-03-01',
    '2026-07-01',
    '2026-08-01',
    '2026-09-01',
  ])
})

it('turns each month into spending per category, in dollars, with refunds negative', async () => {
  const byMonth: Record<string, MonthCategory[]> = {
    '2026-08-01': [
      category({ name: 'Groceries', activity: -123_450 }),
      category({ name: 'Gifts', category_group_name: 'Yearly', activity: 20_000 }),
    ],
    '2026-09-01': [category({ name: 'Groceries', activity: -1005 })],
  }

  const rows = await exportSpending({
    months: ['2026-08-01', '2026-09-01'],
    getMonthCategories: async month => byMonth[month] || [],
  })

  expect(rows).toEqual([
    { month: '2026-08', group: 'Monthly Flex', category: 'Groceries', spent: 123.45 },
    { month: '2026-08', group: 'Yearly', category: 'Gifts', spent: -20 },
    { month: '2026-09', group: 'Monthly Flex', category: 'Groceries', spent: 1.01 },
  ])
})

it('leaves out deleted categories, credit card payments and the internal group', async () => {
  const rows = await exportSpending({
    months: ['2026-09-01'],
    getMonthCategories: async () => [
      category({ name: 'Old', deleted: true, activity: -5000 }),
      category({ name: 'Sapphire', category_group_name: 'Credit Card Payments', activity: -9000 }),
      category({
        name: 'Inflow: Ready to Assign',
        category_group_name: 'Internal Master Category',
      }),
      category({ name: 'Groceries', activity: -1000 }),
    ],
  })

  expect(rows.map(r => r.category)).toEqual(['Groceries'])
})

it('writes a CSV that quotes every name', () => {
  const csv = toCsv([
    { month: '2026-09', group: 'Wish List', category: 'Shirts, "nice"', spent: 12.5 },
  ])

  expect(csv).toBe('month,group,category,spent\n2026-09,"Wish List","Shirts, ""nice""",12.50\n')
})

import type { MonthCategory } from '@personal-automation/ynab/types'

// Money moving between our own accounts or budget bookkeeping, not spending.
const NOT_SPENDING_GROUPS = new Set(['Credit Card Payments', 'Internal Master Category'])

export type SpendingRow = { month: string; group: string; category: string; spent: number }

/** The last `count` of the budget's months that ended before `today`, oldest first. Fewer when the budget is younger. */
export function fullMonthsBefore({
  available,
  today,
  count,
}: {
  available: string[]
  today: string
  count: number
}): string[] {
  const current = `${today.slice(0, 7)}-01`

  return available.filter(m => m < current).slice(-count)
}

export async function exportSpending({
  months,
  getMonthCategories,
}: {
  months: string[]
  getMonthCategories: (month: string) => Promise<MonthCategory[]>
}): Promise<SpendingRow[]> {
  const rows: SpendingRow[] = []
  for (const month of months) {
    const categories = await getMonthCategories(month)
    for (const c of categories) {
      if (c.deleted || NOT_SPENDING_GROUPS.has(c.category_group_name)) continue
      rows.push({
        month: month.slice(0, 7),
        group: c.category_group_name,
        category: c.name,
        // Rounded in whole cents before dividing, so 1.005 dollars becomes 1.01 rather than 1.00.
        spent: Math.round(-c.activity / 10) / 100 || 0,
      })
    }
  }

  return rows
}

function quote(text: string): string {
  return `"${text.replaceAll('"', '""')}"`
}

export function toCsv(rows: SpendingRow[]): string {
  const lines = rows.map(
    r => `${r.month},${quote(r.group)},${quote(r.category)},${r.spent.toFixed(2)}`,
  )

  return `month,group,category,spent\n${lines.join('\n')}\n`
}

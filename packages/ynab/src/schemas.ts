import { z } from 'zod'

export const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  hidden: z.boolean(),
  deleted: z.boolean(),
  category_group_id: z.string(),
  category_group_name: z.string(),
})

export const categoryGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  hidden: z.boolean(),
  deleted: z.boolean(),
  categories: z.array(categorySchema),
})

export const transactionSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  date: z.string(),
  payee_name: z.string().nullable(),
  memo: z.string().nullable(),
  amount: z.number(),
  transfer_account_id: z.string().nullable(),
  transfer_transaction_id: z.string().nullable(),
  flag_name: z.string().nullable(),
  flag_color: z.string().nullable(),
  category_id: z.string().nullable(),
})

export const categoryGroupsResponseSchema = z.object({
  data: z.object({
    category_groups: z.array(categoryGroupSchema),
  }),
})

export const transactionsResponseSchema = z.object({
  data: z.object({
    transactions: z.array(transactionSchema),
  }),
})

export const patchTransactionsResponseSchema = z.object({
  data: z.object({
    transaction_ids: z.array(z.string()),
  }),
})

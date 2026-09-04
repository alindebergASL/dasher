import { z } from "zod";

/**
 * The only structure a planner (model or fake) may emit. It says how to read
 * the table and how to compose the dashboard. It carries no figures: every
 * number on the finished dashboard is computed by `compileTablePlan` from the
 * table itself.
 */

export const TABLE_SECTION_KINDS = [
  "summary",
  "headline-totals",
  "by-category",
  "movers",
  "trend",
  "largest-rows",
  "budget-variance",
  "table",
] as const;
export type TableSectionKind = (typeof TABLE_SECTION_KINDS)[number];

export const TABLE_PLAN_MAX_PAGES = 3;
export const TABLE_PLAN_MAX_SECTIONS_PER_PAGE = 6;
export const TABLE_PLAN_MAX_FILTERS = 8;

const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "ids are lowercase kebab-case");
const ColumnName = z.string().min(1).max(256);

export const TablePlanSchema = z.strictObject({
  planVersion: z.literal("table-plan-v1"),
  title: z.string().min(1).max(120),
  audience: z.string().min(1).max(120),
  /** One sentence on how the dashboard is organised. Shown as the summary subtitle. */
  framing: z.string().min(1).max(400),
  /** Which column plays which part. Names must match table headers exactly. */
  roles: z.strictObject({
    amount: ColumnName,
    period: ColumnName.optional(),
    category: ColumnName.optional(),
    label: ColumnName.optional(),
    account: ColumnName.optional(),
    budget: ColumnName.optional(),
  }),
  grain: z.enum(["month", "quarter", "year"]),
  filters: z
    .array(
      z.strictObject({
        column: ColumnName,
        op: z.enum(["include", "exclude"]),
        values: z.array(z.string().min(1).max(256)).min(1).max(20),
      }),
    )
    .max(TABLE_PLAN_MAX_FILTERS),
  /** Keep only the most recent N periods. Omit for the whole file. */
  lastPeriods: z.number().int().min(2).max(60).optional(),
  pages: z
    .array(
      z.strictObject({
        id: IdSchema,
        title: z.string().min(1).max(120),
        description: z.string().min(1).max(400),
        sections: z
          .array(z.enum(TABLE_SECTION_KINDS))
          .min(1)
          .max(TABLE_PLAN_MAX_SECTIONS_PER_PAGE),
      }),
    )
    .min(1)
    .max(TABLE_PLAN_MAX_PAGES),
});

export type TablePlan = z.infer<typeof TablePlanSchema>;

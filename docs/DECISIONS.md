# Decisions

The few things that are settled. Everything else is up for change. Add a line
only for a decision that is expensive to reverse.

1. **A model proposes composition; trusted code computes every number.** The
   plan a model emits carries column roles, filters, grain, and layout, and
   never a figure. Compile validates the plan against the table and computes
   with exact decimals.
2. **Every displayed figure cites evidence.** At minimum the source file and
   the calculation. A component with no evidence does not render.
3. **The spreadsheet is the product.** Live sources come back later as tables
   through the same pipeline. There is no second pipeline.
4. **Private and organization-scoped.** Passwordless sign-in, row-level
   security in PostgreSQL, one organization per customer, members share
   dashboards within it. No public or anonymous access to saved dashboards.
5. **The provider is an explicit choice, never a fallback.** `DASHER_PLANNER`
   selects `fake` or `anthropic`; a missing or failing credential is an error,
   not a silent switch.
6. **Migrations are forward-only once a deployment holds real data.** Until
   then they may be edited and the database recreated.
7. **No generated-code execution.** Models emit declarative plans only.

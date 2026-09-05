# Dasher

Upload a spreadsheet, say what you want to see, get an evidence-backed
dashboard. Change it by asking. See [docs/VISION.md](docs/VISION.md) for the
product, [docs/STATUS.md](docs/STATUS.md) for what works today, and
[docs/DECISIONS.md](docs/DECISIONS.md) for what is settled.

## Run it

Requirements: Node.js 22+, pnpm 10.14.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`. Without a database you can build dashboards from
the sample and from your own uploads, but nothing is saved. With
`DASHER_DATABASE_URL` set (see `deploy/README.md`), sign-in, saving, listing
and archiving work.

### The planner

| Variable                          | Values                                               |
| --------------------------------- | ---------------------------------------------------- |
| `DASHER_PLANNER`                  | `fake` (default), `anthropic`, or `openrouter`       |
| `ANTHROPIC_API_KEY`               | required when `DASHER_PLANNER=anthropic`             |
| `OPENROUTER_API_KEY`              | required when `DASHER_PLANNER=openrouter`            |
| `DASHER_PLANNER_MODEL`            | provider model id; defaults are provider-specific    |
| `DASHER_PLANNER_REASONING_EFFORT` | OpenRouter `low`, `medium`, or `high`; default `low` |
| `DASHER_PLANNER_DAILY_LIMIT`      | max model calls per UTC day, default `500`           |

The fake planner is the permanent test substrate and what CI runs. A missing
provider-specific key is an error, never a fallback. OpenRouter requests require
structured-output support, deny data-collecting routes, require ZDR, and disable
silent provider fallback. Those request controls govern the inference endpoint;
they cannot turn off OpenRouter account-level opt-ins. Keep **Input & Output
Logging** disabled in Observability and **OpenRouter Use of Inputs/Outputs**
disabled in Privacy, or spreadsheet samples may be retained despite ZDR routing.
Use an exact model id such as `z-ai/glm-5.3`, not `openrouter/auto`: Dasher
refuses a response naming a different model so concurrent requests cannot race
the provenance recorded on an accepted dashboard.

## Check it

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm build && pnpm test:e2e
pnpm test:postgres        # control-plane integration tests, needs PostgreSQL
```

## Layout

| Path                        | What                                                          |
| --------------------------- | ------------------------------------------------------------- |
| `apps/web`                  | Next.js app: upload, request, dashboard, sign-in, list        |
| `packages/workbook`         | CSV to `Table`: parsing, typing, unpivot, exact decimals      |
| `packages/planner`          | `TablePlan`, fake/Anthropic/OpenRouter planners, compile loop |
| `packages/dashboard-schema` | The `DashboardSpec` contract, layout, claims                  |
| `packages/control-plane`    | PostgreSQL schema, migrator, sign-in, repository              |
| `deploy`                    | Single-instance Docker Compose, Caddy, backups                |

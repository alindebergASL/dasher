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

| Variable                     | Values                                         |
| ---------------------------- | ---------------------------------------------- |
| `DASHER_PLANNER`             | `fake` (default, deterministic) or `anthropic` |
| `ANTHROPIC_API_KEY`          | required when `DASHER_PLANNER=anthropic`       |
| `DASHER_PLANNER_MODEL`       | model id, default `claude-opus-5`              |
| `DASHER_PLANNER_DAILY_LIMIT` | max model calls per UTC day, default `500`     |

The fake planner is the permanent test substrate and what CI runs. A missing
key with `DASHER_PLANNER=anthropic` is an error at startup, never a fallback.

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
| `packages/planner`          | `TablePlan`, fake and Anthropic planners, compile, retry loop |
| `packages/dashboard-schema` | The `DashboardSpec` contract, layout, claims                  |
| `packages/control-plane`    | PostgreSQL schema, migrator, sign-in, repository              |
| `deploy`                    | Single-instance Docker Compose, Caddy, backups                |

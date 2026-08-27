# The image the application runs as, built from the workspace root.
#
# WHY NOT `output: "standalone"`. Next can trace a minimal server bundle, and
# for a monorepo with `transpilePackages` and pnpm's symlinked store that
# tracing occasionally misses a workspace file — which fails at runtime, on the
# server, rather than at build time here. Nobody working on this repository can
# reach the deployment host interactively, so a failure there is expensive in a
# way a larger image is not. This copies the built workspace and runs it the
# same way `pnpm start` runs it locally.
#
# WHY THE BUILD AND THE RUNTIME ARE SEPARATE STAGES ANYWAY. Not to slim the
# image: the runtime stage copies `/app` wholesale, so it DOES carry the source
# tree, the test files and the devDependencies — saying otherwise would be a
# claim this file does not earn. What the split buys is that the runtime image
# is built from a known-good `/app` rather than from whatever the build left
# behind, and that build-time tooling (apt caches, the pnpm store) does not
# ride along. Slimming it further means `output: "standalone"`, whose tracing
# risk is argued against above.
FROM node:22.22.2-bookworm-slim AS builder

ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH" CI=1
# `corepack enable` installs a SHIM; the package manager itself is downloaded on
# first use. Preparing it here pins the exact version into the image instead.
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

WORKDIR /app

# Manifests first, so a source-only change does not reinstall dependencies.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/air-domain/package.json packages/air-domain/
COPY packages/calculation-engine/package.json packages/calculation-engine/
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/dashboard-schema/package.json packages/dashboard-schema/
COPY packages/enrollment-domain/package.json packages/enrollment-domain/
COPY packages/extraction-spike/package.json packages/extraction-spike/
COPY packages/ledger-domain/package.json packages/ledger-domain/
COPY packages/planner/package.json packages/planner/
COPY packages/repo-graph/package.json packages/repo-graph/
COPY packages/river-domain/package.json packages/river-domain/
COPY packages/station-domain/package.json packages/station-domain/
COPY packages/workbook/package.json packages/workbook/

RUN pnpm install --frozen-lockfile

COPY . .

# Deliberately not `pnpm test`. A deployment builds an artifact; CI decides
# whether the commit is fit to deploy, and repeating the suite here would run it
# on a box sized for serving rather than for testing, and would make a deploy
# fail for a reason the pipeline already knows about.
RUN pnpm build

FROM node:22.22.2-bookworm-slim AS runtime

# COREPACK_HOME is set explicitly, and it is the whole reason this works.
#
# `corepack enable` installs a SHIM; the package manager itself is downloaded on
# first use, into corepack's cache under the invoking user's home. So the FIRST
# `pnpm` of the container's life reached out to registry.npmjs.org — turning
# every start, and every `migrate` run, into a network call that fails outright
# on a host with restricted egress.
#
# `corepack prepare --activate` alone did not fix it: it populated ROOT's cache
# during the build, and the `USER dasher` below then ran with a different home
# and could not see it, so it downloaded pnpm again. Both facts were found by
# running the image with `--network none`, which is the only way either of them
# is visible — the build succeeds and the container starts happily on a machine
# with open egress.
ENV NODE_ENV=production PNPM_HOME="/pnpm" PATH="/pnpm:$PATH" \
    COREPACK_HOME=/opt/corepack
RUN corepack enable \
  && corepack prepare pnpm@10.14.0 --activate \
  && chmod -R a+rX /opt/corepack

# Never root. The container writes nothing it does not have to, and the one
# thing it does write — Next's cache — belongs to this user.
RUN useradd --create-home --uid 10001 dasher
WORKDIR /app

COPY --from=builder --chown=dasher:dasher /app /app

USER dasher
EXPOSE 3000

# `--hostname 0.0.0.0` so the container is reachable from the compose network;
# the reverse proxy in front of it is what faces the internet.
CMD ["pnpm", "--filter", "@dasher/web", "start", "--hostname", "0.0.0.0", "--port", "3000"]

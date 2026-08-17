# One image definition, eight agents.
#
# Which agent an image runs is a build argument, not a separate Dockerfile.
# Eight near-identical Dockerfiles would drift, and the whole point of the
# shared runtime is that the eight are comparable to each other.
#
# Build context is the REPOSITORY ROOT, because a workspace package cannot be
# installed without the root manifest, the lockfile and the packages it depends
# on:
#
#   docker build -f agents/reference/Dockerfile \
#     --build-arg AGENT=health-factor-a -t mandate/health-factor-a .
#
# Node only. These containers read chain state over JSON-RPC and never fork,
# simulate or sign, so Foundry and Anvil have no place here.
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS deps
ARG AGENT
WORKDIR /repo

# Manifests first so a source-only change does not re-resolve the dependency
# graph. pnpm needs every workspace manifest present to build the lockfile view,
# so they are copied before any source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/domain/package.json          packages/domain/
COPY packages/agent-runtime/package.json   packages/agent-runtime/
COPY agents/reference/${AGENT}/package.json agents/reference/${AGENT}/

RUN pnpm install --frozen-lockfile \
      --filter "@mandate/domain..." \
      --filter "@mandate/agent-runtime..." \
      --filter "./agents/reference/${AGENT}..."

FROM base AS runtime
ARG AGENT
ENV AGENT=${AGENT}
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages/domain/node_modules ./packages/domain/node_modules
COPY --from=deps /repo/packages/agent-runtime/node_modules ./packages/agent-runtime/node_modules
COPY --from=deps /repo/agents/reference/${AGENT}/node_modules ./agents/reference/${AGENT}/node_modules

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/domain          ./packages/domain
COPY packages/agent-runtime   ./packages/agent-runtime
COPY agents/reference/${AGENT} ./agents/reference/${AGENT}

# Workspace packages are consumed as TypeScript source — `@mandate/domain`
# exports `./src/index.ts` — so the process runs under tsx rather than plain
# node. Node's own type stripping cannot resolve the `.js` specifiers those
# packages use to point at `.ts` files.
WORKDIR /repo/agents/reference/${AGENT}

# node:alpine ships this user at uid 1000. Nothing here needs root.
USER node

ENV HOST=0.0.0.0
ENV PORT=9000
EXPOSE 9000

# The platform healthcheck is an external HTTP probe against /healthz. This one
# exists so `docker run` locally fails loudly rather than sitting dead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/main.ts"]

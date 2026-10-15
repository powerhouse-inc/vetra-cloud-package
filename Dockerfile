# =============================================================================
# Multi-stage Dockerfile for Powerhouse Document Model Packages
# Produces two images: connect (frontend) and switchboard (backend)
#
# Build commands:
#   docker build --target connect -t <registry>/<project>/connect:<tag> .
#   docker build --target switchboard -t <registry>/<project>/switchboard:<tag> .
# =============================================================================

# -----------------------------------------------------------------------------
# Base stage: Common setup for building
# -----------------------------------------------------------------------------
FROM node:24-alpine AS base

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++ git bash \
    && ln -sf /usr/bin/python3 /usr/bin/python

# Setup pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@latest --activate

# Configure JSR registry
RUN pnpm config set @jsr:registry https://npm.jsr.io

# Build arguments
ARG TAG=latest
ARG PH_CONNECT_BASE_PATH="/"

# Install ph-cmd, prisma, and prettier globally
RUN pnpm add -g ph-cmd@$TAG prisma@5.17.0 prettier

# Initialize project based on tag (dev/staging/latest)
RUN case "$TAG" in \
        *dev*) ph init project --dev --package-manager pnpm ;; \
        *staging*) ph init project --staging --package-manager pnpm ;; \
        *) ph init project --package-manager pnpm ;; \
    esac

WORKDIR /app/project

# Copy package files for the current package
COPY package.json pnpm-lock.yaml ./

# Install the current package (this package)
ARG PACKAGE_NAME
RUN if [ -n "$PACKAGE_NAME" ]; then \
        echo "Installing package: $PACKAGE_NAME"; \
        ph install "$PACKAGE_NAME"; \
    else \
        echo "Warning: PACKAGE_NAME not provided, using local build"; \
        pnpm install; \
    fi

# -----------------------------------------------------------------------------
# Connect build stage
# -----------------------------------------------------------------------------
FROM base AS connect-builder

ARG PH_CONNECT_BASE_PATH="/"

# Build connect
RUN ph connect build --base ${PH_CONNECT_BASE_PATH}

# -----------------------------------------------------------------------------
# Connect final stage - nginx
# -----------------------------------------------------------------------------
FROM nginx:alpine AS connect

# Install envsubst for config templating
RUN apk add --no-cache gettext

# Copy nginx config template
COPY docker/nginx.conf /etc/nginx/nginx.conf.template

# Copy built static files from build stage
COPY --from=connect-builder /app/project/.ph/connect-build/dist /var/www/html/project

# Environment variables for nginx config
ENV PORT=3001
ENV PH_CONNECT_BASE_PATH="/"

# Copy and setup entrypoint
COPY docker/connect-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]

# -----------------------------------------------------------------------------
# Switchboard final stage - node runtime
# -----------------------------------------------------------------------------
FROM node:24-alpine AS switchboard

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache curl openssl

# Setup pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@latest --activate

# Configure JSR registry
RUN pnpm config set @jsr:registry https://npm.jsr.io

# Install ph-cmd and prisma globally (needed at runtime)
ARG TAG=latest
RUN pnpm add -g ph-cmd@$TAG prisma@5.17.0

# Copy built project from build stage
COPY --from=base /app/project /app/project

WORKDIR /app/project

# Copy entrypoint
COPY docker/switchboard-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_URL=""
ENV SKIP_DB_MIGRATIONS="false"

EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]

# =============================================================================
# Standalone service images: secrets-controller and housekeeping-service.
#
# Neither needs the package's full dependency tree (Connect, reactor, React,
# ...): the compiled controller imports four packages and the housekeeping
# activator only node: builtins. Installing the whole tree made both images
# ~2 GB and cost a fresh ~50 s install (plus a ~1.4 GB cache export) on every
# release, because the version bump in package.json invalidated the install
# layers. Instead:
#   - service-manifests derives trimmed, version-free package.json files
#     (docker/service-deps.mjs), so the install layers below stay cached until
#     a relevant dependency actually changes;
#   - the trimmed installs resolve against the repo pnpm-lock.yaml and are
#     verified to contain only packages it already locks (same integrity).
# =============================================================================
FROM node:24-alpine AS service-manifests

WORKDIR /src
COPY docker/service-deps.mjs package.json ./
RUN node service-deps.mjs manifests package.json /out

FROM node:24-alpine AS service-pnpm

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to the version the lockfile was generated with — newer pnpm
# is stricter about overrides hashing and rejects the lockfile.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
RUN pnpm config set @jsr:registry https://npm.jsr.io

COPY docker/service-deps.mjs pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./pnpm-lock.full.yaml

# -----------------------------------------------------------------------------
# Build-time deps for both services: the compiler, the type packages the root
# tsconfig.json references, and the controller's imports (for their types).
# --ignore-scripts: nothing here needs a lifecycle script to type-check.
# -----------------------------------------------------------------------------
FROM service-pnpm AS service-build-deps

COPY --from=service-manifests /out/build/package.json ./package.json
RUN cp pnpm-lock.full.yaml pnpm-lock.yaml \
    && pnpm install --no-frozen-lockfile --ignore-scripts \
    && node service-deps.mjs verify pnpm-lock.full.yaml pnpm-lock.yaml

COPY tsconfig.json ./

# -----------------------------------------------------------------------------
# Runtime deps of the secrets controller (prod only).
# -----------------------------------------------------------------------------
FROM service-pnpm AS secrets-controller-runtime-deps

COPY --from=service-manifests /out/runtime/package.json ./package.json
RUN cp pnpm-lock.full.yaml pnpm-lock.yaml \
    && pnpm install --prod --no-frozen-lockfile --ignore-scripts \
    && node service-deps.mjs verify pnpm-lock.full.yaml pnpm-lock.yaml

# -----------------------------------------------------------------------------
# Secrets controller build stage — compiles the controller sources and the
# shared modules it imports from the vetra-cloud-secrets subgraph.
#
# Why a separate target: the controller has a different runtime profile from
# switchboard (no Connect/UI assets, no ph-cli, no graphql server) and needs
# to be small and audit-able since it has cluster-wide RBAC on Secrets and
# ConfigMaps.
# -----------------------------------------------------------------------------
FROM service-build-deps AS secrets-controller-builder

COPY secrets-controller ./secrets-controller
COPY subgraphs/vetra-cloud-secrets ./subgraphs/vetra-cloud-secrets

# Minimal tsconfig that scopes compilation to the controller. tsc follows its
# imports into subgraphs/vetra-cloud-secrets, so only the modules it actually
# uses are compiled (the subgraph's resolvers import code not copied here).
RUN cat > tsconfig.controller.json <<'EOF'
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist-controller",
    "rootDir": ".",
    "declaration": true,
    "declarationMap": false,
    "declarationDir": "./dist-controller/types",
    "emitDeclarationOnly": false,
    "incremental": false,
    "noEmit": false
  },
  "include": [
    "secrets-controller/**/*"
  ],
  "exclude": [
    "**/__tests__/**",
    "**/*.test.ts"
  ]
}
EOF
RUN pnpm exec tsc -p tsconfig.controller.json

# -----------------------------------------------------------------------------
# Secrets controller final stage
# -----------------------------------------------------------------------------
FROM node:24-alpine AS secrets-controller

WORKDIR /app

RUN apk add --no-cache curl

# Only the packages the controller imports (pg, kysely,
# @kubernetes/client-node, @powerhousedao/shared) and their dependencies.
COPY --from=secrets-controller-runtime-deps /app/node_modules ./node_modules
# The real manifest (for "type": "module" and the release version) goes in
# after the deps so the version bump only touches these small layers.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=secrets-controller-builder /app/dist-controller ./dist-controller

ENV NODE_ENV=production
ENV HEALTH_PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:${HEALTH_PORT}/healthz || exit 1

ENTRYPOINT ["node", "dist-controller/secrets-controller/main.js"]

# =============================================================================
# Housekeeping service builder
#
# Standalone pod that sleeps idle studios (idle detector over Loki access logs)
# and wakes them on demand (HTTP activator behind the catch-all *.vetra.io
# ingress). Same minimal-runtime rationale as secrets-controller: no Connect/UI,
# no ph-cli. Compilation is scoped to the service + the two dependency-free
# shared modules it uses (housekeeping policy + env read-model types).
# =============================================================================
FROM service-build-deps AS housekeeping-service-builder

COPY housekeeping-service ./housekeeping-service
COPY subgraphs/vetra-housekeeping/policy.ts ./subgraphs/vetra-housekeeping/policy.ts

# The activator is tiny: it imports only the dependency-free policy module
# (isAutomationRequest) from the subgraph; everything else (detector, Loki, DB)
# now lives in-process in the switchboard, not here. Scope compilation tightly.
RUN cat > tsconfig.housekeeping.json <<'EOF'
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist-controller",
    "rootDir": ".",
    "declaration": true,
    "declarationMap": false,
    "declarationDir": "./dist-controller/types",
    "emitDeclarationOnly": false,
    "incremental": false,
    "noEmit": false
  },
  "include": [
    "housekeeping-service/**/*",
    "subgraphs/vetra-housekeeping/policy.ts"
  ],
  "exclude": [
    "**/__tests__/**",
    "**/*.test.ts"
  ]
}
EOF
RUN pnpm exec tsc -p tsconfig.housekeeping.json

# -----------------------------------------------------------------------------
# Housekeeping service final stage
#
# The compiled activator imports only node: builtins, so the image carries no
# node_modules at all.
# -----------------------------------------------------------------------------
FROM node:24-alpine AS housekeeping-service

WORKDIR /app

RUN apk add --no-cache curl

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=housekeeping-service-builder /app/dist-controller ./dist-controller

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:${PORT}/healthz || exit 1

ENTRYPOINT ["node", "dist-controller/housekeeping-service/main.js"]

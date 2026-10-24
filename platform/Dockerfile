FROM node:22-bookworm-slim AS frontend
WORKDIR /build/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
ARG RAILWAY_GIT_COMMIT_SHA=dev
ENV RAILWAY_GIT_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA
RUN npm run typecheck && npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* && npm install -g @railway/cli@5.71.0
WORKDIR /srv/platform
COPY platform/package.json platform/package-lock.json ./
RUN npm ci --omit=dev
COPY platform/*.mjs ./
COPY platform/template/ ./template/
COPY project-worker/ /srv/project-worker/
COPY --from=frontend /build/app/dist /srv/app/dist
ENV FRONTEND_DIR=/srv/app/dist WORKER_DIR=/srv/project-worker TEMPLATE_DIR=/srv/platform/template
CMD ["node", "server.mjs"]

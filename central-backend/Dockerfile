FROM node:22-bookworm-slim AS build

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY central-backend/package.json ./central-backend/package.json
COPY local-backend/package.json ./local-backend/package.json
COPY developer-dashboard/package.json ./developer-dashboard/package.json
COPY desktop-app/package.json ./desktop-app/package.json
RUN npm ci --ignore-scripts --workspace=central-backend --include-workspace-root=false

COPY central-backend/tsconfig.json ./central-backend/tsconfig.json
COPY central-backend/src ./central-backend/src
RUN npm run build --workspace=central-backend

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=10000
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY central-backend/package.json ./central-backend/package.json
COPY local-backend/package.json ./local-backend/package.json
COPY developer-dashboard/package.json ./developer-dashboard/package.json
COPY desktop-app/package.json ./desktop-app/package.json
RUN npm ci --ignore-scripts --omit=dev --workspace=central-backend --include-workspace-root=false \
  && npm cache clean --force

COPY --from=build /workspace/central-backend/dist ./central-backend/dist

EXPOSE 10000
CMD ["node", "central-backend/dist/server.js"]

# Portal: React build served by the Node API. The API is bundled into one file.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci && npm run build -w @complao/web && npm run build -w @complao/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 WEB_DIST=/app/web
COPY --from=build /app/apps/api/dist/server.mjs ./server.mjs
COPY --from=build /app/apps/web/dist ./web
USER node
EXPOSE 8787
CMD ["node", "server.mjs"]

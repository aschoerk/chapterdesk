# Production image for Cloud Run: Angular SPA + typed API and mock LLM server.
FROM node:22-trixie AS web
WORKDIR /angular
COPY package.json package-lock.json ./
RUN npm ci
COPY angular.json tsconfig.json tsconfig.app.json ./
COPY public ./public
COPY src ./src
RUN npx ng build --configuration=production --base-href=/ --output-path=/out

FROM node:22-trixie AS api
WORKDIR /api
COPY chapterdesk-api-server/package.json chapterdesk-api-server/package-lock.json ./
RUN npm ci
COPY chapterdesk-api-server/tsconfig.json ./
COPY chapterdesk-api-server/src ./src
RUN npm run build

FROM node:22-trixie
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY chapterdesk-api-server/package.json chapterdesk-api-server/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=api /api/dist ./dist
COPY --from=web /out/browser ./public
ENV NODE_ENV=production
ENV PORT=8080
ENV CHAPTERDESK_RUNTIME=docker-prod

EXPOSE 8080
CMD ["node", "dist/server.js"]
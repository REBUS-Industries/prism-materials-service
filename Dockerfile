FROM node:22-alpine AS builder
WORKDIR /build

COPY package.json package-lock.json* rebus-industries-prism-shared-1.0.0.tgz ./
RUN npm ci --no-audit --no-fund
RUN npm prune --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Copy migrations from the shared package
RUN cp -r node_modules/@rebus-industries/prism-shared/src/db/migrations ./dist-migrations

FROM node:22-alpine AS runtime
WORKDIR /prism-materials

COPY package.json ./
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/dist-migrations ./migrations

ENV NODE_ENV=production
ENV PORT=8766
ENV UPLOAD_DIR=/var/lib/prism/uploads
ENV DATA_DIR=/data/prism
ENV MIGRATIONS_DIR=/prism-materials/migrations

EXPOSE 8766
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "dist/main.js"]

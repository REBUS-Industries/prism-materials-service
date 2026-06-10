FROM node:22-alpine AS builder
WORKDIR /build

ARG GITHUB_TOKEN
RUN echo "@rebus-industries:registry=https://npm.pkg.github.com" >> /root/.npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> /root/.npmrc

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Copy migrations from the shared package so MIGRATIONS_DIR works at runtime
RUN cp -r node_modules/@rebus-industries/prism-shared/src/db/migrations ./dist-migrations

FROM node:22-alpine AS runtime
WORKDIR /prism-materials

ARG GITHUB_TOKEN
RUN echo "@rebus-industries:registry=https://npm.pkg.github.com" >> /root/.npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> /root/.npmrc

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force && rm /root/.npmrc

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

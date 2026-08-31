FROM node:20.16.0-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY codecs ./codecs
COPY lib ./lib
COPY src ./src
COPY client-tsconfig.json generic-tsconfig.json static-build-tsconfig.json tsconfig.json worker-tsconfig.json ./
COPY emscripten-types.d.ts missing-types.d.ts rollup.config.js ./
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/build /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

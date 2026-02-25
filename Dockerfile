FROM node:22-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN pnpm run build
RUN pnpm run build:ui

FROM node:22-slim AS runtime

WORKDIR /app

RUN corepack enable

ENV NODE_ENV=production
ENV CONTEXT_LENS_NO_UPDATE_CHECK=1

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=build /app/dist ./dist
COPY --from=build /app/ui/dist ./ui/dist
COPY --from=build /app/mitm_addon.py ./mitm_addon.py
COPY --from=build /app/schema ./schema

VOLUME ["/root/.context-lens"]

EXPOSE 4040 4041

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4041/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/cli.js"]

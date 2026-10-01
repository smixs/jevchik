# Both services (bot, web) run from this one image; compose picks the command.
FROM --platform=linux/arm64 node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM --platform=linux/arm64 node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY data-static ./data-static
COPY eval/questions.json ./eval/questions.json
RUN mkdir -p /data/imports && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/main.js", "bot"]

FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache git
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY bin ./bin
COPY web ./web
RUN npm ci && npm run build:web

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/bin ./bin
COPY --from=build /app/web/public ./web/public
COPY package.json ./
USER node
EXPOSE 8080
ENV IRIDIUM_SERVER__HOST=0.0.0.0
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "bin/iridium-proxy.js"]

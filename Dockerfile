FROM node:24-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/walker2023-glitch/FreshOut"

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/freshout.sqlite

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY public ./public
COPY src ./src
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "src/server.js"]

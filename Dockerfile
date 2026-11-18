FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

RUN mkdir -p data && chown -R node:node /app

USER node

CMD ["node", "src/index.js"]

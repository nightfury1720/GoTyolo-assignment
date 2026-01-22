FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_URL=postgresql://gotyolo:gotyolo123@postgres:5432/gotyolo

CMD ["node", "dist/src/index.js"]

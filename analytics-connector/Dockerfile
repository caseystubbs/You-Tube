FROM node:22-slim

WORKDIR /app

COPY analytics-connector/package.json ./
RUN npm install --omit=dev

COPY analytics-connector/server.js ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]

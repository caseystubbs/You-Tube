FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY verify-auth.js ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]

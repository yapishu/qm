FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

WORKDIR /app/plugins/tlon

COPY plugins/tlon/package.json plugins/tlon/package-lock.json ./
RUN npm ci --omit=dev
COPY plugins/tlon/src ./src
COPY plugins/chassis/src /app/plugins/chassis/src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.ts"]

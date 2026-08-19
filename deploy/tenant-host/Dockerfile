FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

RUN apk add --no-cache docker-cli

WORKDIR /tenants

COPY cli /app/cli

ENV NODE_ENV=production
ENV QM_HOST_ADMIN_LISTEN=127.0.0.1:9080

EXPOSE 9080

CMD ["node", "/app/cli/bin/qm.ts", "host", "serve"]

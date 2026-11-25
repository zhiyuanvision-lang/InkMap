FROM node:22-alpine

WORKDIR /app

RUN npm install -g inkmap-mcp@latest

ENTRYPOINT ["inkmap-mcp", "mcp"]

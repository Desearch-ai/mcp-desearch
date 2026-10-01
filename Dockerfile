FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --ignore-scripts

COPY . .

RUN npm run build

ENV PORT=3000

EXPOSE 3000

# Stdio is the default so a catalog host can speak MCP on stdin/stdout.
# Glama connects that way and only offers Deploy after a container start succeeds:
# https://glama.ai/blog/2025-01-04-automating-issue-detection
# https://glama.ai/blog/2026-03-15-how-to-make-a-release
# The image previously exited straight into HTTP (`--http`), which does not
# speak MCP on stdio, so that startup check cannot pass.
# Stdio needs DESEARCH_API_KEY. Streamable HTTP ignores it and reads the
# per-request x-api-key or Authorization header instead:
#   docker run --rm -p 3000:3000 desearch-mcp node build/index.js --http
CMD ["node", "build/index.js"]

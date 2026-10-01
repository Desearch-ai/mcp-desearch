FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --ignore-scripts

COPY . .

RUN npm run build

ENV PORT=3000

EXPOSE 3000

# Default is MCP over stdio (`node build/index.js`, no --http). Glama starts
# the container and speaks MCP on stdin/stdout; an HTTP-only CMD cannot deploy.
# Stdio reads DESEARCH_API_KEY from the environment.
#
# Streamable HTTP is an explicit override. Either form works (port 3000):
#   docker run --rm -p 3000:3000 <image> node build/index.js --http
#   docker run --rm -e MCP_TRANSPORT=http -p 3000:3000 <image>
# HTTP clients send their own Desearch API key on each request.
#
# Smithery does not use this CMD. smithery.yaml starts stdio itself:
#   node build/index.js
# and injects DESEARCH_API_KEY. Vercel uses api/ handlers, not this image.
CMD ["node", "build/index.js"]

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --ignore-scripts

COPY . .

RUN npm run build

ENV PORT=3000

EXPOSE 3000

# Streamable HTTP on port 3000. Clients send their own Desearch API key.
# Smithery overrides this command and starts the stdio server from smithery.yaml.
CMD ["node", "build/index.js", "--http"]

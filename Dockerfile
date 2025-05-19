FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --ignore-scripts

COPY . .

RUN npm run build

ENV DESEARCH_API_KEY=your-api-key

EXPOSE 3000

# Command will be provided by smithery.yaml
CMD ["node", "build/index.js"]
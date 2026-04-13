FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY src/package*.json ./src/
RUN cd src && npm ci --only=production && npm rebuild better-sqlite3

COPY src/public/dashboard-app/package*.json ./src/public/dashboard-app/
RUN cd src/public/dashboard-app && npm ci
COPY src/public/dashboard-app/ ./src/public/dashboard-app/
RUN cd src/public/dashboard-app && npm run build

COPY src/ ./src/
COPY connectors/ ./connectors/
COPY LICENSE ./

RUN mkdir -p src/data src/logs

EXPOSE 4500

WORKDIR /app/src
CMD ["node", "index.js"]

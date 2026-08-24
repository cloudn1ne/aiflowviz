# LiteLLM → Routing Sankey dashboard image.
# Node 20.6+ is required for the native process.loadEnvFile() used in server.js.
FROM node:20-alpine

# Application code lives in /app; the server serves the whole folder with
# express.static(__dirname), so node_modules must be present at runtime.
WORKDIR /app

# Copy manifest files first for efficient dependency-layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code (source only; .env / logo / logs stay out of git).
COPY . .

# The dashboard listens on 0.0.0.0:5173 by default (see server.js).
EXPOSE 5173

# Run as a non-root user.
USER node

ENV PORT=5173

CMD ["npm", "start"]

FROM node:22-alpine

# tzdata so cron schedules respect TZ env var
RUN apk add --no-cache tzdata

WORKDIR /app/cron

# Install deps first for layer caching
COPY package.json ./
RUN npm install --omit=dev

# Copy app code last so changes don't bust the deps layer
COPY . .

# Reasonable defaults; overridden by docker-compose
ENV NODE_ENV=production \
    TZ=America/New_York

CMD ["node", "scheduler.js"]

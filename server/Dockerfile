# The Rabbit Hole backend as a container, for any host that runs one.
#
#   docker build -t rabbit-hole-server .          (from this folder)
#   docker run -p 8787:8787 --env-file .env rabbit-hole-server
#
# The API keys are NOT in the image: the host supplies them as environment variables
# (see .env.example). Set APP_TOKEN too, since the server will be reachable from anywhere.

FROM node:22-alpine
WORKDIR /app

# Dependencies first, so editing the source does not reinstall them.
# tsx (which runs the TypeScript directly) is a dev dependency, so install everything.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
# Hosts that assign their own port set PORT, and the server listens on whatever it is.
ENV PORT=8787
EXPOSE 8787

USER node
CMD ["node", "--import", "tsx", "src/index.ts"]

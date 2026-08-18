# Build stage
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
WORKDIR /app
ENV NODE_ENV=production

# The base image's bundled npm lags behind and its vendored dependencies show
# up in image scans; the runtime itself never calls npm.
RUN npm install -g npm@11 --ignore-scripts && npm cache clean --force

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The server reports its version from package.json at runtime; the lockfile
# stays out of the image.
COPY package.json ./

# Ownership proof for the MCP Registry: must match server.json's name exactly.
LABEL io.modelcontextprotocol.server.name="io.github.ni-c/osm-mcp"

# Drop root: the node image ships an unprivileged `node` user (uid 1000).
USER node

# stdio transport only — no port, no healthcheck. The server needs no
# credentials at all; ORS_API_KEY merely switches the routing engine.
ENTRYPOINT ["node", "dist/index.js"]

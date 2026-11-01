# mockgen as a container: mount your spec (or sample folder) at /api.
#
#   docker run --rm -p 4010:4010 -v "$PWD:/api" ghcr.io/wylan24/mockgen
#   docker run --rm -p 4010:4010 -v "$PWD:/api" ghcr.io/wylan24/mockgen serve /api/spec.json --seed 2

# The build output is plain JavaScript, so compile once on the build machine's own
# platform (TypeScript 7 is a native binary) and copy it into each target image.
FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-alpine
LABEL org.opencontainers.image.title="mockgen" \
      org.opencontainers.image.description="Turn an OpenAPI spec or a folder of sample JSON into a running mock server with realistic, deterministic fake data." \
      org.opencontainers.image.source="https://github.com/wylan24/mockgen" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    # Listen on all interfaces, or the server is unreachable from outside the container.
    MOCKGEN_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
WORKDIR /api
EXPOSE 4010
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve", "/api/openapi.yaml"]

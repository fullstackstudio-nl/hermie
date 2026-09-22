# Hermie Web in a container.
#
# The image is built from an ALREADY BUILT package: `npm run web:build` produces
# `dist/server` and `dist/web`, and this only copies them. Building inside the
# image would pull the whole monorepo and an Expo toolchain in for the sake of
# one static export, and the artefact CI attaches to a release would no longer be
# the artefact the image runs.
#
# Nothing is installed with npm because the package has no runtime dependencies.
FROM node:22-alpine

# Hermie Web authenticates nobody — the gateway does — so it drops to the
# image's unprivileged user and keeps nothing writable but its own release
# directory.
WORKDIR /app

COPY package.json ./
COPY bin ./bin
COPY dist ./dist

# Read by `detectInstallShape`: inside a container the image IS the version, so
# the self-update endpoint refuses and points at `docker pull` instead of
# writing a release directory the next `docker run` would throw away.
ENV HERMIE_IN_DOCKER=1
ENV HERMIE_HOST=0.0.0.0
ENV HERMIE_PORT=9120
ENV NODE_ENV=production

# So the entry point can be the command's own name rather than a path: the same
# `hermie-web ...` line works in the container, in the systemd unit and after
# `npm i -g @hermie/web`.
RUN ln -s /app/bin/hermie-web.js /usr/local/bin/hermie-web

USER node
EXPOSE 9120

# `--gateway` is the one thing every deployment has to say. The default reaches
# 127.0.0.1 inside the CONTAINER, which is almost never where `hermes serve` is.
ENTRYPOINT ["hermie-web"]

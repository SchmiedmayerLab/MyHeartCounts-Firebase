#
# This source file is part of the My Heart Counts open-source project
# Based on the docker file found at https://github.com/vercel/next.js/blob/canary/examples/with-docker/Dockerfile.
#
# SPDX-FileCopyrightText: 2025 Stanford University and the project authors (see CONTRIBUTORS.md)
#
# SPDX-License-Identifier: MIT
#


FROM node:22-bullseye-slim

RUN apt update -y && apt install -y openjdk-11-jdk bash curl

RUN npm install -g firebase-tools

COPY . .

RUN npm run prepare

EXPOSE 5001 9099 8080 9199 4000

ENV IN_DOCKER_CONTAINER=true

ENTRYPOINT ["/bin/bash", "-c", "npm run serve:seeded && sleep infinity"]

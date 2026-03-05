FROM node:18-bullseye@sha256:0d9e9a8dcd5a83ea737ed92227a6591a31ad70c8bb722b0c51aff7ae23a88b6a

RUN useradd -m -s /bin/bash vscode
RUN mkdir -p /workspaces && chown -R vscode:vscode /workspaces
WORKDIR /workspaces

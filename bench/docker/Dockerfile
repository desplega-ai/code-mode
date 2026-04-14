FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates jq ripgrep curl \
 && rm -rf /var/lib/apt/lists/*

RUN npm i -g @anthropic-ai/claude-code@latest @desplega/code-mode@latest

# node:20-slim ships a "node" user at UID 1000. Reuse it.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER node
RUN mkdir -p /home/node/.claude

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

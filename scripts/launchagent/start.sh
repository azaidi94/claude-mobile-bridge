#!/bin/bash
set -e

cd /path/to/claude-mobile-bridge

# Source environment variables
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

# Run the bot
exec bun run src/index.ts

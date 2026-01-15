#!/usr/bin/env bun
/**
 * Start a new Claude session and capture its ID.
 * Usage: bun run scripts/start-session.ts <dir> [name]
 *
 * Sends an init message to Claude to get a session ID,
 * registers it in the session registry, and prints the ID.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { registerSession, generateName } from "../src/sessions/registry";
import type { SessionInfo } from "../src/sessions/types";

const args = process.argv.slice(2);
const dir = args[0] || process.cwd();
const explicitName = args[1];

async function main() {
  const name = await generateName(dir, explicitName);

  // Create placeholder session
  const session: SessionInfo = {
    id: "",
    name,
    dir,
    lastActivity: Date.now(),
    source: "claudet",
  };

  // Start a minimal query to get session ID
  const response = query({
    prompt: "Session initialized from claudet CLI. Ready.",
    options: {
      cwd: dir,
      model: "claude-haiku-4-5",
      maxTurns: 1,
    },
  });

  let sessionId: string | null = null;

  for await (const event of response) {
    if (event.session_id && !sessionId) {
      sessionId = event.session_id;
      break;
    }
  }

  if (!sessionId) {
    console.error("Failed to get session ID");
    process.exit(1);
  }

  // Update and register
  session.id = sessionId;
  await registerSession(session);

  // Output the session ID for claudet to use
  console.log(sessionId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

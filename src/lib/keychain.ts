// Isolated module so tests can mock it instead of intercepting Bun.spawn.

// Shape of the "Claude Code-credentials" keychain entry. Current format
// nests under claudeAiOauth; older layouts had accessToken at the top level.
interface KeychainCredentials {
  accessToken?: string;
  claudeAiOauth?: { accessToken?: string };
}

export async function readKeychainToken(): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      [
        "security",
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-w",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    if (proc.exitCode !== 0) return null;
    const raw = (await new Response(proc.stdout).text()).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as KeychainCredentials;
    return parsed.claudeAiOauth?.accessToken ?? parsed.accessToken ?? null;
  } catch {
    return null;
  }
}

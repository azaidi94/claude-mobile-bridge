/**
 * Side-effect import: satisfy src/config.ts validation for tests that load the
 * real app stack (e.g. sessions/watcher) without a .env file.
 */
if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
  process.env.TELEGRAM_BOT_TOKEN = "test-placeholder-token";
}
if (!process.env.TELEGRAM_ALLOWED_USERS?.trim()) {
  process.env.TELEGRAM_ALLOWED_USERS = "1";
}

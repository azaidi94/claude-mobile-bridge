import { describe, test, expect } from "bun:test";

async function loadSystem() {
  process.env.TELEGRAM_BOT_TOKEN ||= "test";
  process.env.TELEGRAM_ALLOWED_USERS ||= "1";
  return import("../web/routes/system");
}

describe("getSystemStats", () => {
  test("returns cpu, memory, disk, processes fields", async () => {
    const { getSystemStats } = await loadSystem();
    const stats = await getSystemStats();

    expect(typeof stats.cpu).toBe("number");
    expect(stats.cpu).toBeGreaterThanOrEqual(0);
    expect(stats.cpu).toBeLessThanOrEqual(100);

    expect(typeof stats.memory.used).toBe("number");
    expect(typeof stats.memory.total).toBe("number");
    expect(stats.memory.used).toBeLessThanOrEqual(stats.memory.total);

    expect(typeof stats.disk.used).toBe("number");
    expect(typeof stats.disk.total).toBe("number");

    expect(Array.isArray(stats.processes)).toBe(true);
  });
});

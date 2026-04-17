import { totalmem, freemem, loadavg } from "os";
import { Hono } from "hono";
import { exec } from "child_process";
import { promisify } from "util";
import { authMiddleware } from "../auth";

const execAsync = promisify(exec);

export interface SystemStats {
  cpu: number;
  memory: { used: number; total: number; usedPercent: number };
  disk: { used: number; total: number; usedPercent: number };
  processes: Array<{ name: string; pid: number; cpu: number }>;
}

export async function getSystemStats(): Promise<SystemStats> {
  const total = totalmem();
  const free = freemem();
  const used = total - free;
  const [load1 = 0] = loadavg();
  const cpu = Math.min(100, Math.round((load1 / 1) * 100));

  let disk = { used: 0, total: 0, usedPercent: 0 };
  try {
    const { stdout } = await execAsync("df -k /");
    const lines = stdout.trim().split("\n");
    const parts = lines[1]?.split(/\s+/) ?? [];
    const diskTotal = parseInt(parts[1] ?? "0", 10) * 1024;
    const diskUsed = parseInt(parts[2] ?? "0", 10) * 1024;
    disk = {
      used: diskUsed,
      total: diskTotal,
      usedPercent: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0,
    };
  } catch {}

  let processes: SystemStats["processes"] = [];
  try {
    const { stdout } = await execAsync(
      "ps -eo pid,pcpu,comm | grep -E '(claude|bun|channel-relay|node)' | grep -v grep | head -20",
    );
    processes = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          pid: parseInt(parts[0] ?? "0", 10),
          cpu: parseFloat(parts[1] ?? "0"),
          name: parts.slice(2).join(" ").split("/").pop() ?? "",
        };
      });
  } catch {}

  return {
    cpu,
    memory: { used, total, usedPercent: Math.round((used / total) * 100) },
    disk,
    processes,
  };
}

export function createSystemRouter(): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/", async (c) => c.json(await getSystemStats()));
  return app;
}

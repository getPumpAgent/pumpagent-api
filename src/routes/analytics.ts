import { FastifyInstance } from "fastify";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";

const LOG_DIR = "/var/log/nginx";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

function parseLogLine(line: string) {
  const m = line.match(
    /^(\S+) - - \[([^\]]+)] "(\S+) (\S+) [^"]*" (\d+) (\d+) "([^"]*)" "([^"]*)"/
  );
  if (!m) return null;
  return {
    ip: m[1],
    time: m[2],
    method: m[3],
    path: m[4],
    status: parseInt(m[5]),
    bytes: parseInt(m[6]),
    referrer: m[7],
    ua: m[8],
  };
}

function classifyUA(ua: string): "bot" | "browser" | "api" {
  if (/bot|crawl|spider|curl|wget|python|scrapy|Go-http|HeadlessChrome/i.test(ua)) return "bot";
  if (/axios|node-fetch|http\.client|okhttp|libred/i.test(ua)) return "api";
  return "browser";
}

function getHour(timeStr: string): string {
  const m = timeStr.match(/:(\d{2}):/);
  return m ? m[1] : "00";
}

function getDate(timeStr: string): string {
  const m = timeStr.match(/^(\d+\/\w+\/\d+)/);
  return m ? m[1] : "";
}

function isAsset(path: string): boolean {
  return /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|json|webp|avif)$/i.test(path);
}

function readLogLines(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export async function analyticsRoutes(app: FastifyInstance) {
  app.get("/v1/analytics", async (req, reply) => {
    const key = (req.headers["x-admin-key"] as string) || "";
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      reply.code(401);
      return { error: "Unauthorized" };
    }

    const query = req.query as { days?: string };
    const days = Math.min(parseInt(query.days || "1") || 1, 7);

    // Read current log + rotated logs based on days requested
    let allLines: string[] = readLogLines(`${LOG_DIR}/access.log`);
    if (days > 1) {
      for (let i = 1; i < days; i++) {
        const rotated = `${LOG_DIR}/access.log.${i}`;
        allLines = readLogLines(rotated).concat(allLines);
      }
    }

    const entries = allLines.map(parseLogLine).filter(Boolean) as NonNullable<
      ReturnType<typeof parseLogLine>
    >[];

    // Basic stats
    const uniqueIPs = new Set(entries.map((e) => e.ip));
    const totalRequests = entries.length;
    const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);

    // Status codes
    const statusCounts: Record<string, number> = {};
    entries.forEach((e) => {
      const group = `${Math.floor(e.status / 100)}xx`;
      statusCounts[group] = (statusCounts[group] || 0) + 1;
    });

    // By hour
    const byHour: Record<string, number> = {};
    for (let h = 0; h < 24; h++) {
      byHour[h.toString().padStart(2, "0")] = 0;
    }
    entries.forEach((e) => {
      const h = getHour(e.time);
      byHour[h] = (byHour[h] || 0) + 1;
    });

    // By date
    const byDate: Record<string, number> = {};
    entries.forEach((e) => {
      const d = getDate(e.time);
      byDate[d] = (byDate[d] || 0) + 1;
    });

    // Top pages (non-asset)
    const pageCounts: Record<string, number> = {};
    entries
      .filter((e) => !isAsset(e.path))
      .forEach((e) => {
        pageCounts[e.path] = (pageCounts[e.path] || 0) + 1;
      });
    const topPages = Object.entries(pageCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([path, count]) => ({ path, count }));

    // Top IPs
    const ipCounts: Record<string, number> = {};
    entries.forEach((e) => {
      ipCounts[e.ip] = (ipCounts[e.ip] || 0) + 1;
    });
    const topIPs = Object.entries(ipCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([ip, count]) => ({ ip, count }));

    // User agent breakdown
    const uaType: Record<string, number> = { bot: 0, browser: 0, api: 0 };
    entries.forEach((e) => {
      uaType[classifyUA(e.ua)]++;
    });

    // Top user agents
    const uaCounts: Record<string, number> = {};
    entries.forEach((e) => {
      uaCounts[e.ua] = (uaCounts[e.ua] || 0) + 1;
    });
    const topUAs = Object.entries(uaCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ua, count]) => ({ ua, count }));

    // Top referrers (non-empty, non-self)
    const refCounts: Record<string, number> = {};
    entries
      .filter((e) => e.referrer !== "-" && !e.referrer.includes("pumpapi.markets"))
      .forEach((e) => {
        refCounts[e.referrer] = (refCounts[e.referrer] || 0) + 1;
      });
    const topReferrers = Object.entries(refCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([referrer, count]) => ({ referrer, count }));

    // Internal navigation (referrers from own site)
    const navCounts: Record<string, number> = {};
    entries
      .filter((e) => e.referrer.includes("pumpapi.markets"))
      .forEach((e) => {
        const path = e.referrer.replace(/https?:\/\/[^/]+/, "").split("?")[0] || "/";
        navCounts[path] = (navCounts[path] || 0) + 1;
      });
    const topNav = Object.entries(navCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, count]) => ({ path, count }));

    // Browser-only unique visitors (real users)
    const browserIPs = new Set(
      entries.filter((e) => classifyUA(e.ua) === "browser").map((e) => e.ip)
    );

    return {
      period: { days, lines: totalRequests },
      overview: {
        totalRequests,
        uniqueIPs: uniqueIPs.size,
        realVisitors: browserIPs.size,
        totalMB: (totalBytes / 1048576).toFixed(1),
      },
      statusCodes: statusCounts,
      trafficType: uaType,
      byHour,
      byDate,
      topPages,
      topIPs,
      topUAs,
      topReferrers,
      topNav,
    };
  });
}

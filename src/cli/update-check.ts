import fs from "node:fs";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

interface UpdateCheckCache {
  checkedAt: number;
  latestVersion: string;
}

export function checkForUpdate(currentVersion: string): void {
  const cachePath = join(homedir(), ".context-lens", "update-check.json");
  const dayMs = 24 * 60 * 60 * 1000;
  let cached: UpdateCheckCache | null = null;
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.checkedAt === "number" &&
      typeof parsed.latestVersion === "string"
    ) {
      cached = parsed as UpdateCheckCache;
    }
  } catch {}

  if (cached && Date.now() - cached.checkedAt < dayMs) {
    if (isNewerVersion(cached.latestVersion, currentVersion)) {
      printUpdateNotice(currentVersion, cached.latestVersion);
    }
    return;
  }

  const req = https.get(
    "https://registry.npmjs.org/context-lens/latest",
    { timeout: 1500 },
    (res) => {
      if (res.statusCode !== 200) return;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { version?: string };
          if (!parsed.version) return;
          const latestVersion = parsed.version;
          try {
            fs.mkdirSync(join(homedir(), ".context-lens"), {
              recursive: true,
            });
            fs.writeFileSync(
              cachePath,
              `${JSON.stringify(
                { checkedAt: Date.now(), latestVersion },
                null,
                2,
              )}\n`,
            );
          } catch {}
          if (isNewerVersion(latestVersion, currentVersion)) {
            printUpdateNotice(currentVersion, latestVersion);
          }
        } catch {}
      });
    },
  );
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = splitSemver(candidate);
  const b = splitSemver(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

export function splitSemver(version: string): [number, number, number] {
  const [major, minor, patch] = version.split(".", 3).map((part) => {
    const parsed = Number.parseInt(part.replace(/[^0-9].*$/, ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

export function printUpdateNotice(
  currentVersion: string,
  latestVersion: string,
): void {
  console.error(
    `\nUpdate available: context-lens ${currentVersion} -> ${latestVersion}`,
  );
  console.error("Run: npm install -g context-lens");
  console.error(
    "Skip this check: --no-update-check or CONTEXT_LENS_NO_UPDATE_CHECK=1\n",
  );
}

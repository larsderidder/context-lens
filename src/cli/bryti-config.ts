import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface PrepareBrytiDataDirOptions {
  targetDirPrefix?: string;
  sourceDataDir?: string;
  proxyUrl: string;
  sessionTag: string;
  warn?: (message: string) => void;
}

const SYMLINK_ENTRIES = [
  "users",
  "history",
  "logs",
  "pending",
  "skills",
  "usage",
  "whatsapp-auth",
  "core-memory.md",
  "sessions",
  "extensions",
];

/**
 * Create a temporary Bryti data dir with config.yml patched to use the proxy.
 * Persistent state dirs are symlinked, while .pi is copied so Bryti writes stay temporary.
 */
export function prepareBrytiDataDir(
  options: PrepareBrytiDataDirOptions,
): string {
  const warn = options.warn ?? ((message: string) => console.error(message));
  const dirPrefix =
    options.targetDirPrefix && options.targetDirPrefix.length > 0
      ? options.targetDirPrefix
      : join(tmpdir(), "context-lens-bryti-");
  const targetDir = fs.mkdtempSync(dirPrefix);

  const realDataDir = resolve(
    options.sourceDataDir ??
      process.env.BRYTI_DATA_DIR ??
      join(process.cwd(), "data"),
  );
  const sourceConfigPath = join(realDataDir, "config.yml");

  try {
    if (!fs.existsSync(sourceConfigPath)) {
      warn(
        `Warning: no Bryti config.yml found at ${sourceConfigPath}. ` +
          "Bryti will start without a proxy-patched config.",
      );
      return targetDir;
    }

    const raw = fs.readFileSync(sourceConfigPath, "utf-8");
    const proxyBase = `${options.proxyUrl}/bryti/${options.sessionTag}`;
    const patched = raw
      .split("\n")
      .map((line) => {
        const match = line.match(/^(\s*base_url:\s*)(.*)$/);
        if (!match) return line;
        return `${match[1]}"${proxyBase}"`;
      })
      .join("\n");

    fs.writeFileSync(join(targetDir, "config.yml"), patched, "utf-8");

    for (const name of SYMLINK_ENTRIES) {
      const src = join(realDataDir, name);
      if (!fs.existsSync(src)) continue;
      const dst = join(targetDir, name);
      try {
        fs.symlinkSync(src, dst);
      } catch {}
    }

    const realPiDir = join(realDataDir, ".pi");
    const tempPiDir = join(targetDir, ".pi");
    if (fs.existsSync(realPiDir)) {
      fs.mkdirSync(tempPiDir, { recursive: true });
      for (const entry of fs.readdirSync(realPiDir, { withFileTypes: true })) {
        const src = join(realPiDir, entry.name);
        const dst = join(tempPiDir, entry.name);
        try {
          if (entry.isDirectory()) {
            fs.symlinkSync(src, dst);
          } else {
            fs.copyFileSync(src, dst);
          }
        } catch {}
      }
    }

    return targetDir;
  } catch (err: unknown) {
    warn(
      `Warning: failed to prepare Bryti proxy config: ${err instanceof Error ? err.message : String(err)}`,
    );
    return targetDir;
  }
}

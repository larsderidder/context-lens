import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  addProvidersBasedOnAuthJson,
  addProvidersBasedOnEnvVars,
} from "../cli-utils.js";

export interface PreparePiAgentDirOptions {
  targetDirPrefix?: string;
  homeDir?: string;
  proxyUrl: string;
  sessionTag?: string;
  env?: Record<string, string | undefined>;
  warn?: (message: string) => void;
}

/**
 * Resolve a Pi package path to absolute if it is a relative filesystem path.
 * URLs, package specifiers, tilde paths, and absolute paths are left unchanged.
 */
export function resolvePackagePath(pkg: string, baseDir: string): string {
  if (pkg.startsWith("~")) return pkg;
  if (/^(https?:|git[@+:]|npm:|github:)/.test(pkg)) return pkg;
  if (/^@?[a-z0-9][\w.-]*$/i.test(pkg) || /^@[\w.-]+\/[\w.-]+/.test(pkg)) {
    return pkg;
  }
  if (isAbsolute(pkg)) return pkg;
  return resolve(baseDir, pkg);
}

/** Copy settings.json while making relative package paths valid from the temp dir. */
export function rewriteSettingsWithAbsolutePaths(
  sourcePath: string,
  targetPath: string,
  sourceDir: string,
): void {
  try {
    const raw = fs.readFileSync(sourcePath, "utf8");
    const settings = JSON.parse(raw);
    if (
      settings &&
      typeof settings === "object" &&
      Array.isArray(settings.packages)
    ) {
      settings.packages = settings.packages.map((pkg: unknown) => {
        if (typeof pkg === "string") {
          return resolvePackagePath(pkg, sourceDir);
        }
        if (pkg && typeof pkg === "object" && "source" in pkg) {
          const obj = pkg as Record<string, unknown>;
          if (typeof obj.source === "string") {
            return {
              ...obj,
              source: resolvePackagePath(obj.source, sourceDir),
            };
          }
        }
        return pkg;
      });
    }
    fs.writeFileSync(targetPath, `${JSON.stringify(settings, null, 2)}\n`);
  } catch {
    try {
      fs.symlinkSync(sourcePath, targetPath);
    } catch {}
  }
}

export function preparePiAgentDir(options: PreparePiAgentDirOptions): string {
  const warn = options.warn ?? ((message: string) => console.error(message));
  const dirPrefix =
    options.targetDirPrefix && options.targetDirPrefix.length > 0
      ? options.targetDirPrefix
      : join(tmpdir(), "context-lens-pi-agent-");
  const targetDir = fs.mkdtempSync(dirPrefix);
  const homeDir = options.homeDir ?? process.env.HOME ?? homedir();
  const sourceDir = join(homeDir, ".pi", "agent");
  const sourceModelsPath = join(sourceDir, "models.json");
  const targetModelsPath = join(targetDir, "models.json");

  try {
    fs.chmodSync(targetDir, 0o700);

    if (fs.existsSync(sourceDir)) {
      for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (entry.name === "models.json") continue;
        if (entry.name === "settings.json") {
          rewriteSettingsWithAbsolutePaths(
            join(sourceDir, entry.name),
            join(targetDir, entry.name),
            sourceDir,
          );
          continue;
        }
        const src = join(sourceDir, entry.name);
        const dst = join(targetDir, entry.name);
        fs.symlinkSync(src, dst);
      }
    }

    let modelsConfig: Record<string, unknown> = {};
    if (fs.existsSync(sourceModelsPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(sourceModelsPath, "utf8"));
        if (parsed && typeof parsed === "object") {
          modelsConfig = parsed as Record<string, unknown>;
        }
      } catch {
        warn(
          "Warning: ~/.pi/agent/models.json is not valid JSON; using proxy-only overrides",
        );
      }
    }

    const providers =
      modelsConfig.providers &&
      typeof modelsConfig.providers === "object" &&
      !Array.isArray(modelsConfig.providers)
        ? { ...(modelsConfig.providers as Record<string, unknown>) }
        : {};

    const proxyBaseUrl = options.sessionTag
      ? `${options.proxyUrl}/pi/${options.sessionTag}`
      : `${options.proxyUrl}/pi`;

    const nativeUpstreams = new Set([
      "https://api.anthropic.com",
      "https://api.openai.com",
      "https://generativelanguage.googleapis.com",
      "https://cloudcode-pa.googleapis.com",
      "https://us-central1-aiplatform.googleapis.com",
    ]);

    const authJsonPath = join(sourceDir, "auth.json");
    if (fs.existsSync(authJsonPath)) {
      let authConfig: Record<string, unknown> = {};
      try {
        authConfig = JSON.parse(fs.readFileSync(authJsonPath, "utf8"));
      } catch {
        warn("Warning: ~/.pi/agent/auth.json is not valid JSON; ignoring");
      }
      addProvidersBasedOnAuthJson(authConfig, proxyBaseUrl, providers);
    }

    addProvidersBasedOnEnvVars(
      options.env ?? process.env,
      proxyBaseUrl,
      providers,
    );

    for (const [key, value] of Object.entries(providers)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const provider = value as Record<string, unknown>;
      const originalBaseUrl =
        typeof provider.baseUrl === "string" ? provider.baseUrl : null;

      if (!originalBaseUrl || !originalBaseUrl.startsWith("http")) continue;
      if (originalBaseUrl.startsWith("http://localhost")) continue;

      const needsTargetOverride = !nativeUpstreams.has(
        originalBaseUrl.replace(/\/$/, ""),
      );

      const existingHeaders =
        provider.headers &&
        typeof provider.headers === "object" &&
        !Array.isArray(provider.headers)
          ? (provider.headers as Record<string, string>)
          : {};

      providers[key] = {
        ...provider,
        baseUrl: proxyBaseUrl,
        ...(needsTargetOverride
          ? {
              headers: {
                ...existingHeaders,
                "x-target-url": originalBaseUrl,
              },
            }
          : {}),
      };
    }

    if (!providers.anthropic) {
      providers.anthropic = {
        baseUrl: proxyBaseUrl,
        api: "anthropic-messages",
      };
    } else {
      const anthropic = providers.anthropic as Record<string, unknown>;
      if (!String(anthropic.baseUrl ?? "").startsWith("http://localhost")) {
        providers.anthropic = { ...anthropic, baseUrl: proxyBaseUrl };
      }
    }

    fs.writeFileSync(
      targetModelsPath,
      `${JSON.stringify({ ...modelsConfig, providers }, null, 2)}\n`,
    );
    return targetDir;
  } catch (err: unknown) {
    warn(
      `Warning: failed to prepare Pi proxy config: ${err instanceof Error ? err.message : String(err)}`,
    );
    return targetDir;
  }
}

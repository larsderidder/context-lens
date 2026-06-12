import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ParsedAnalyzeArgs {
  filepath?: string;
  outputJson: boolean;
  mainOnly: boolean;
  showPath: boolean;
  compositionArg?: string;
  showHelp: boolean;
}

export type AnalyzePathResult =
  | { path: string }
  | { error: string; searched: string[] };

export function formatAnalyzeHelp(): string {
  return [
    "Usage: context-lens analyze <session.lhar> [options]",
    "",
    "Analyze an LHAR session file and print detailed statistics.",
    "",
    "Options:",
    "  --json                    Output as JSON",
    "  --no-path                 Omit agent path trace",
    "  --main-only               Only analyze main agent entries",
    "  --composition=last        Composition of last entry (default)",
    "  --composition=pre-compaction  Composition before each compaction",
    "  --composition=N           Composition at end of user turn N",
  ].join("\n");
}

export function parseAnalyzeArgs(
  args: string[],
): ParsedAnalyzeArgs | { error: string } {
  const parsed: ParsedAnalyzeArgs = {
    outputJson: false,
    mainOnly: false,
    showPath: true,
    showHelp: false,
  };

  for (const arg of args) {
    if (arg === "--json") {
      parsed.outputJson = true;
    } else if (arg === "--main-only") {
      parsed.mainOnly = true;
    } else if (arg === "--no-path") {
      parsed.showPath = false;
    } else if (arg.startsWith("--composition=")) {
      parsed.compositionArg = arg.split("=", 2)[1];
    } else if (arg === "--help" || arg === "-h") {
      parsed.showHelp = true;
    } else if (!arg.startsWith("-")) {
      parsed.filepath = arg;
    } else {
      return { error: `Unknown option: ${arg}` };
    }
  }

  return parsed;
}

/** Resolve an LHAR path in the same search order as the CLI help documents. */
export function resolveAnalyzePath(
  filepath: string,
  exists: (path: string) => boolean = fs.existsSync,
  home = homedir(),
): AnalyzePathResult {
  const homeData = join(home, ".context-lens", "data", filepath);
  const localData = join("data", filepath);
  const searched = [filepath, homeData, localData];

  for (const path of searched) {
    if (exists(path)) return { path };
  }

  return {
    error: `Error: file not found: ${filepath}`,
    searched,
  };
}

export async function runAnalyze(args: string[]): Promise<number> {
  const { readLharFile } = await import("../lhar.js");
  const { analyzeSession, formatSessionAnalysis } = await import("../core.js");

  const parsed = parseAnalyzeArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 1;
  }

  if (parsed.showHelp) {
    console.log(formatAnalyzeHelp());
    return 0;
  }

  if (!parsed.filepath) {
    console.error(
      "Error: no session file specified. Usage: context-lens analyze <session.lhar>",
    );
    return 1;
  }

  const resolved = resolveAnalyzePath(parsed.filepath);
  if ("error" in resolved) {
    console.error(resolved.error);
    console.error(`  Searched: ${resolved.searched.join(", ")}`);
    return 1;
  }

  try {
    const { session, entries } = readLharFile(resolved.path);
    const basename = resolved.path.split("/").pop() || resolved.path;
    const analysis = analyzeSession(session, entries, basename, {
      mainOnly: parsed.mainOnly,
    });

    if (parsed.outputJson) {
      console.log(JSON.stringify(analysis, null, 2));
    } else {
      const output = formatSessionAnalysis(analysis, {
        showPath: parsed.showPath,
        composition: parsed.compositionArg,
        entries,
      });
      console.log(output);
    }
    return 0;
  } catch (err: unknown) {
    console.error(
      `Error analyzing ${resolved.path}:`,
      err instanceof Error ? err.message : String(err),
    );
    return 1;
  }
}

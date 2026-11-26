import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Load before application imports so tests never read the operator's config.
const home = mkdtempSync(join(tmpdir(), "context-lens-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.once("exit", () => {
  rmSync(home, { recursive: true, force: true });
});

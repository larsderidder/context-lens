import { validateUpstreamProxy } from "../http/upstream-proxy.js";
import type { MitmConfig } from "../types.js";

/** Build capture arguments, chaining mitmproxy through the configured egress. */
export function buildMitmArgs(
  config: MitmConfig,
  upstreamProxy?: string,
): string[] {
  const args = [
    "-s",
    config.addonPath,
    "--quiet",
    "--listen-port",
    String(config.port),
    ...config.extraArgs,
  ];
  if (upstreamProxy === undefined) {
    return args;
  }

  // Multiple listener modes or a later mode setting could re-enable direct traffic.
  if (
    config.extraArgs.some((arg) =>
      /^(?:-m|--mode|(?:--set=)?(?:mode|upstream_auth)=)/.test(arg),
    )
  ) {
    throw new Error(
      "mitm.extra_args cannot override mode or upstream_auth when an upstream proxy is configured",
    );
  }
  const url = new URL(validateUpstreamProxy(upstreamProxy));
  args.push("--mode", `upstream:${url.origin}`);
  if (url.username || url.password) {
    args.push(
      "--upstream-auth",
      `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
    );
  }
  return args;
}

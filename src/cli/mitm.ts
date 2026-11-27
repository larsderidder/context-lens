import { validateUpstreamProxy } from "../http/upstream-proxy.js";
import type { MitmConfig } from "../types.js";
import { withoutEgressCredentials } from "./egress-env.js";

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
  // Validate before any spawn, including credentials destined for the child environment.
  buildMitmEnv({}, upstreamProxy);
  return args;
}

/** Supply upstream authentication only to the dedicated mitmproxy child. */
export function buildMitmEnv(
  env: NodeJS.ProcessEnv,
  upstreamProxy?: string,
): NodeJS.ProcessEnv {
  const childEnv = withoutEgressCredentials(env);
  if (upstreamProxy !== undefined) {
    const url = new URL(validateUpstreamProxy(upstreamProxy));
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (
      Array.from(username + password).some((char) => {
        const code = char.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      throw new Error("Invalid upstream proxy credentials");
    }
    if (username || password) {
      childEnv.CONTEXT_LENS_MITM_UPSTREAM_AUTH = `${username}:${password}`;
    }
  }
  return childEnv;
}

/** Remove forwarding-only configuration before launching analysis or a wrapped tool. */
export function withoutEgressCredentials(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const clean = withoutMitmAuth(env);
  for (const key of Object.keys(clean)) {
    if (key.toUpperCase() === "CONTEXT_LENS_UPSTREAM_PROXY") {
      delete clean[key];
    }
  }
  return clean;
}

/** Keep MITM-only auth out of proxy children, including Windows key aliases. */
export function withoutMitmAuth(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (key.toUpperCase() === "CONTEXT_LENS_MITM_UPSTREAM_AUTH") {
      delete clean[key];
    }
  }
  return clean;
}

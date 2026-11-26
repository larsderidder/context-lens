/** Validate an explicit egress proxy without including its credentials in errors. */
export function validateUpstreamProxy(value: unknown): string {
  const message =
    "Upstream proxy must be an http:// or https:// URL with a host and no path, query, or fragment";
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new Error(message);
  }
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error(message);
    }
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url.href;
  } catch {
    throw new Error(message);
  }
}

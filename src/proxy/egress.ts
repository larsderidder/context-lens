import http from "node:http";
import https from "node:https";

import { validateUpstreamProxy } from "../http/upstream-proxy.js";

/** Configure the dedicated proxy process, including non-POST upstream requests. */
export function configureUpstreamProxy(value: string): () => void {
  const proxyUrl = validateUpstreamProxy(value);
  // Do not inherit NO_PROXY or other environment settings that could bypass egress.
  const proxyEnv = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl };
  const previousHttpAgent = http.globalAgent;
  const previousHttpsAgent = https.globalAgent;
  const httpAgent = new http.Agent({ keepAlive: true, proxyEnv });
  const httpsAgent = new https.Agent({ keepAlive: true, proxyEnv });

  // @contextio/proxy uses Node's default agents. Only this process is changed;
  // capture ingestion and analysis prune lookups use explicit direct agents.
  http.globalAgent = httpAgent;
  https.globalAgent = httpsAgent;

  return () => {
    http.globalAgent = previousHttpAgent;
    https.globalAgent = previousHttpsAgent;
    httpAgent.destroy();
    httpsAgent.destroy();
  };
}

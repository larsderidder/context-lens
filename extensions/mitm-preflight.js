import { createServer } from "node:net";

/** Check that mitmproxy can bind its configured port before leaving Pi. */
export function checkMitmPort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Set a free [mitm] port in ~/.context-lens/config.toml, then retry /context-lens.`,
          ),
        );
      } else {
        reject(error);
      }
    });
    server.listen({ port, exclusive: true }, () => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });
}

/** Read the same configuration as the bundled CLI on every attempt. */
export async function preflightCapture() {
  const { loadConfig } = await import("../dist/config.js");
  await checkMitmPort(loadConfig().mitm.port);
}

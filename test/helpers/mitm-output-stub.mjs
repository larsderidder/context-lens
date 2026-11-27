#!/usr/bin/env node
import { rmSync, writeFileSync } from "node:fs";
import net from "node:net";

const pidPath = process.env.MITM_OUTPUT_PID;
writeFileSync(pidPath, String(process.pid));
process.once("SIGTERM", () => {
  rmSync(pidPath, { force: true });
  process.exit(0);
});

const output = Buffer.alloc(512 * 1024, "x");
if (process.env.MITM_OUTPUT_MODE === "fail") {
  process.stderr.write(output, () => {
    process.stderr.write("\nfixture binding failure\n", () => {
      rmSync(pidPath, { force: true });
      process.exit(1);
    });
  });
} else {
  // Listen only after flushing more stdout than an unread pipe can hold.
  process.stdout.write(output, () => {
    const port = Number(
      process.argv[process.argv.indexOf("--listen-port") + 1],
    );
    net
      .createServer((socket) => {
        socket.end();
      })
      .listen(port, "localhost");
  });
}

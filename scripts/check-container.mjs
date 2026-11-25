import assert from "node:assert/strict";

const base = "http://127.0.0.1:4041";
const health = await fetch(`${base}/health`);
assert.equal(health.status, 200);
const page = await fetch(base);
assert.equal(page.status, 200);
const html = await page.text();
const asset = html.match(/src="([^"]+\.js)"/);
assert.ok(asset, "UI entrypoint must be present");
const response = await fetch(new URL(asset[1], base));
assert.equal(response.status, 200);
assert.match(response.headers.get("content-type"), /javascript/);

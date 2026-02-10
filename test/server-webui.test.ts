import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store } from '../src/server/store.js';
import { createWebUIHandler } from '../src/server/webui.js';
import { dispatch } from './helpers/http-mock.js';

function makeStore(): { store: Store; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'context-lens-test-'));
  const store = new Store({
    dataDir: path.join(dir, 'data'),
    stateFile: path.join(dir, 'data', 'state.jsonl'),
    maxSessions: 10,
    maxCompactMessages: 60,
  });
  return { store, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

describe('webui handler', () => {
  let store: Store;
  let cleanup: () => void;

  beforeEach(() => {
    const made = makeStore();
    store = made.store;
    cleanup = made.cleanup;
  });

  it('POST /api/ingest stores an entry and GET /api/requests returns it', async () => {
    const handler = createWebUIHandler(store, '<html>ok</html>');

    const ingest = {
      provider: 'anthropic',
      apiFormat: 'anthropic-messages',
      source: 'claude',
      body: { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'from ingest' }] },
      response: { model: 'claude-sonnet-4-20250514', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } },
    };

    const res = await dispatch(handler, {
      method: 'POST',
      url: '/api/ingest',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ingest),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().ok, true);

    const reqs = await dispatch(handler, { method: 'GET', url: '/api/requests' });
    assert.equal(reqs.statusCode, 200);
    const data = reqs.bodyJson();
    assert.ok(Array.isArray(data.conversations));
    const totalEntries = (data.conversations || []).reduce((sum: number, c: any) => sum + (c.entries?.length || 0), 0) + (data.ungrouped?.length || 0);
    assert.equal(totalEntries, 1);

    cleanup();
  });

  it('GET /api/export/lhar returns JSONL and POST /api/reset clears state', async () => {
    const handler = createWebUIHandler(store, '<html>ok</html>');

    // Ingest one entry
    await dispatch(handler, {
      method: 'POST',
      url: '/api/ingest',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        apiFormat: 'anthropic-messages',
        source: 'claude',
        body: { model: 'claude-sonnet-4-20250514', metadata: { user_id: 'session_123' }, messages: [{ role: 'user', content: 'hi' }] },
        response: { model: 'claude-sonnet-4-20250514', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } },
      }),
    });

    const exp = await dispatch(handler, { method: 'GET', url: '/api/export/lhar' });
    assert.equal(exp.statusCode, 200);
    assert.ok(exp.bodyText().includes('"type":"entry"'));

    const reset = await dispatch(handler, { method: 'POST', url: '/api/reset' });
    assert.equal(reset.statusCode, 200);

    const reqs = await dispatch(handler, { method: 'GET', url: '/api/requests' });
    const data = reqs.bodyJson();
    assert.equal((data.conversations || []).length, 0);
    assert.equal((data.ungrouped || []).length, 0);

    cleanup();
  });

  it('DELETE /api/conversations/:id removes a conversation', async () => {
    const handler = createWebUIHandler(store, '<html>ok</html>');

    await dispatch(handler, {
      method: 'POST',
      url: '/api/ingest',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        apiFormat: 'anthropic-messages',
        source: 'claude',
        body: {
          model: 'claude-sonnet-4-20250514',
          metadata: { user_id: 'session_550e8400-e29b-41d4-a716-446655440000' },
          messages: [{ role: 'user', content: 'hi' }],
        },
        response: { model: 'claude-sonnet-4-20250514', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } },
      }),
    });

    const reqs = await dispatch(handler, { method: 'GET', url: '/api/requests' });
    const data = reqs.bodyJson();
    assert.equal(data.conversations.length, 1);
    const convoId = data.conversations[0].id;

    const del = await dispatch(handler, { method: 'DELETE', url: `/api/conversations/${encodeURIComponent(convoId)}` });
    assert.equal(del.statusCode, 200);
    assert.equal(del.bodyJson().ok, true);

    const reqs2 = await dispatch(handler, { method: 'GET', url: '/api/requests' });
    const data2 = reqs2.bodyJson();
    assert.equal(data2.conversations.length, 0);

    cleanup();
  });
});


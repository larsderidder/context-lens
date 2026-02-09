import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { safeFilenamePart, isLocalRemote, headersForResolution, selectHeaders } from '../src/server-utils.js';

describe('server-utils', () => {
  describe('safeFilenamePart', () => {
    it('returns unknown for empty-ish values', () => {
      assert.equal(safeFilenamePart(''), 'unknown');
      assert.equal(safeFilenamePart('   '), 'unknown');
      assert.equal(safeFilenamePart('.'), 'unknown');
      assert.equal(safeFilenamePart('..'), 'unknown');
    });

    it('replaces unsafe characters and collapses dot-runs', () => {
      assert.equal(safeFilenamePart('my tool'), 'my_tool');
      assert.equal(safeFilenamePart('../../etc/passwd'), 'etc_passwd');
      assert.equal(safeFilenamePart('a...b'), 'a_b');
    });

    it('caps length to 80 chars', () => {
      const input = 'a'.repeat(200);
      assert.equal(safeFilenamePart(input).length, 80);
    });
  });

  describe('isLocalRemote', () => {
    it('recognizes localhost variants', () => {
      assert.equal(isLocalRemote(undefined), false);
      assert.equal(isLocalRemote('127.0.0.1'), true);
      assert.equal(isLocalRemote('::1'), true);
      assert.equal(isLocalRemote('::ffff:127.0.0.1'), true);
      assert.equal(isLocalRemote('10.0.0.1'), false);
    });
  });

  describe('headersForResolution', () => {
    it('drops x-target-url unless override is enabled and request is from localhost', () => {
      const headers = { 'x-target-url': 'http://example.com', other: 'ok' } as any;

      const dropped = headersForResolution(headers, '10.0.0.1', false);
      assert.equal((dropped as any)['x-target-url'], undefined);
      assert.equal((dropped as any).other, 'ok');

      const kept = headersForResolution(headers, '127.0.0.1', true);
      assert.equal((kept as any)['x-target-url'], 'http://example.com');
    });
  });

  describe('selectHeaders', () => {
    it('removes sensitive headers and keeps only string values', () => {
      const selected = selectHeaders({
        authorization: 'Bearer secret',
        'X-API-KEY': 'secret',
        cookie: 'c=1',
        'set-cookie': 's=1',
        'x-target-url': 'http://evil',
        'content-type': 'application/json',
        'x-number': 123,
        'x-array': ['a'],
      });

      assert.deepEqual(selected, { 'content-type': 'application/json' });
    });
  });
});


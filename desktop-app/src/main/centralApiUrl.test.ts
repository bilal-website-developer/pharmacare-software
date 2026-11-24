import assert from 'node:assert/strict';
import test from 'node:test';
import { centralApiEndpoint } from './centralApiUrl.js';

test('central API routes work at the service root', () => {
  assert.equal(
    centralApiEndpoint('https://licenses.example', '/api/licensing/activate').toString(),
    'https://licenses.example/api/licensing/activate',
  );
});

test('central API routes preserve a Supabase Edge Function base path', () => {
  assert.equal(
    centralApiEndpoint(
      'https://project.example.supabase.co/functions/v1/central-licensing/',
      '/api/licensing/activate',
    ).toString(),
    'https://project.example.supabase.co/functions/v1/central-licensing/api/licensing/activate',
  );
});

test('central API base URLs reject embedded credentials and query strings', () => {
  assert.throws(
    () => centralApiEndpoint('https://user:pass@example.com?token=secret', '/api/health'),
    /must not contain credentials/,
  );
});

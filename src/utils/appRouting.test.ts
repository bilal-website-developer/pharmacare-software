import assert from 'node:assert/strict';
import test from 'node:test';
import { getAppRoutePath, getAppRouteUrl } from './appRouting';

test('desktop routes use the file URL hash and default to the dashboard', () => {
  const fileLocation = { pathname: '/C:/PharmaCare/renderer/index.html', search: '', hash: '' };
  assert.equal(getAppRoutePath(fileLocation, true), '/');
  assert.equal(getAppRoutePath({ ...fileLocation, hash: '#/products' }, true), '/products');
  assert.equal(
    getAppRouteUrl(fileLocation, '/products', true),
    '/C:/PharmaCare/renderer/index.html#/products',
  );
});

test('desktop hash routes ignore query strings and web routes keep pathname behavior', () => {
  const location = { pathname: '/index.html', search: '?shell=desktop', hash: '#/products?filter=active' };
  assert.equal(getAppRoutePath(location, true), '/products');
  assert.equal(getAppRouteUrl(location, '/products', true), '/index.html?shell=desktop#/products');
  assert.equal(getAppRoutePath(location, false), '/index.html');
  assert.equal(getAppRouteUrl(location, '/products', false), '/products');
});

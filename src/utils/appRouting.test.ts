import assert from 'node:assert/strict';
import test from 'node:test';
import { getAppRoutePath, getAppRouteUrl } from './appRouting';
import { SIDEBAR_PAGES, sidebarPageForRoute } from '../components/sidebarPages';

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

test('every sidebar route resolves from a packaged file URL', () => {
  const fileLocation = { pathname: '/C:/PharmaCare/renderer/index.html', search: '', hash: '' };
  for (const page of SIDEBAR_PAGES.filter((item) => item.sidebar !== false)) {
    const url = getAppRouteUrl(fileLocation, page.route, true);
    assert.equal(getAppRoutePath({ ...fileLocation, hash: url.slice(url.indexOf('#')) }, true), page.route, page.label);
    assert.equal(sidebarPageForRoute(page.route)?.key, page.key, page.label);
  }
});

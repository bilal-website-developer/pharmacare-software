export interface AppLocation {
  pathname: string;
  search: string;
  hash: string;
}

export function getAppRoutePath(location: Pick<AppLocation, 'pathname' | 'hash'>, desktopMode: boolean): string {
  if (!desktopMode) return location.pathname;
  const hashPath = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const routePath = hashPath.split('?', 1)[0];
  return routePath.startsWith('/') ? routePath : '/';
}

export function getAppRouteUrl(location: AppLocation, routePath: string, desktopMode: boolean): string {
  return desktopMode
    ? `${location.pathname}${location.search}#${routePath}`
    : routePath;
}

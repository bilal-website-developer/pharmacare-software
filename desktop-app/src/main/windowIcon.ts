import fs from 'node:fs';
import path from 'node:path';

export function getWindowIconPath(isPackaged: boolean, appPath: string, resourcesPath: string): string {
  const iconPath = isPackaged
    ? path.join(resourcesPath, 'build', 'pharma-care.ico')
    : path.join(appPath, 'build', 'pharma-care.ico');
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Pharma Care window icon is missing: ${iconPath}`);
  }
  return iconPath;
}

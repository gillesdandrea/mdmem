import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The directory holding this module's nearest `package.json`: mdmem's checkout when run from `src/`, its installed package when run from `dist/`. */
function packageRootOf(moduleUrl: string): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`no package.json above ${fileURLToPath(moduleUrl)}`);
    }
    dir = parent;
  }
  return dir;
}

/** mdmem's package root, where `templates/` lives beside `package.json`. */
export const PACKAGE_ROOT = packageRootOf(import.meta.url);

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The first executable named `command` in the directories of `path` (a PATH value), else null; a command with a directory in it is checked where it is. */
export function which(command: string, path: string): string | null {
  const candidates = command.includes("/")
    ? [command]
    : path
        .split(delimiter)
        .filter((dir) => dir !== "")
        .map((dir) => join(dir, command));
  return candidates.find(isExecutableFile) ?? null;
}

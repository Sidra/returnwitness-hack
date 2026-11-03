export class VersionConflict extends Error {
  constructor(id: string, expected: number, actual: number) {
    super(`case ${id} changed: expected version ${expected}, found ${actual}`);
  }
}

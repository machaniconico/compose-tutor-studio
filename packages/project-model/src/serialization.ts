// Compatibility wrappers around the canonical, result-based project codec.

import type { Project } from './types';
import {
  decodeProjectJson,
  encodeProjectJson,
  ProjectCodecError,
} from './project-codec';

/** Serialize a validated project using the same compact, importable payload as persistence. */
export function serializeProject(project: Project): string {
  const result = encodeProjectJson(project);
  if (!result.ok) {
    throw new ProjectCodecError(result.error.code, result.error.issues);
  }
  return result.json;
}

/** Deserialize, migrate, structurally decode, and domain-validate project JSON. */
export function deserializeProject(json: string): Project {
  const result = decodeProjectJson(json);
  if (!result.ok) {
    throw new ProjectCodecError(result.error.code, result.error.issues);
  }
  return result.project;
}

export { MIGRATIONS, migrateProject } from './migrations';
export type { Migration } from './migrations';

import type { Project } from '@cts/project-model';

/**
 * Turn an imported project file into a separate local project.
 *
 * Project-file imports are copies by default: preserving the source id could
 * overwrite an existing project or collide with a deletion tombstone. Entity
 * ids inside the composition remain stable because they are scoped to the new
 * top-level project.
 */
export function cloneProjectForImport(project: Project, newProjectId: string): Project {
  if (newProjectId.trim().length === 0 || newProjectId === project.id) {
    throw new Error('Imported projects require a fresh project id');
  }
  return { ...project, id: newProjectId };
}

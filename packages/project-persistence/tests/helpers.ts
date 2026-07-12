import type { Project } from '@cts/project-model';
import { createEmptyProject } from '@cts/project-model';
import type { StorageLike } from '../src/local-storage-repository';

export class TestStorage implements StorageLike {
  protected readonly values = new Map<string, string>();
  failSet: ((key: string, value: string) => unknown | null) | null = null;
  failGet: ((key: string) => unknown | null) | null = null;
  failRemove: ((key: string) => unknown | null) | null = null;
  failEnumerate: unknown | null = null;

  get length(): number {
    if (this.failEnumerate) throw this.failEnumerate;
    return this.values.size;
  }

  key(index: number): string | null {
    if (this.failEnumerate) throw this.failEnumerate;
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    const failure = this.failGet?.(key);
    if (failure) throw failure;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    const failure = this.failSet?.(key, value);
    if (failure) throw failure;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    const failure = this.failRemove?.(key);
    if (failure) throw failure;
    this.values.delete(key);
  }

  rawKeys(): string[] {
    return [...this.values.keys()];
  }
}

export function makeProject(
  title = 'Persistence Test',
  updatedAt = '2026-07-10T00:00:00.000Z',
): Project {
  return {
    ...createEmptyProject({
      title,
      clock: () => new Date('2026-07-10T00:00:00.000Z'),
    }),
    updatedAt,
  };
}

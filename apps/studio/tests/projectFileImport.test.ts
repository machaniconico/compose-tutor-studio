import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/state/defaultProject';
import { parseProjectFileImport } from '../src/features/export/projectFileImport';

describe('project file import parsing', () => {
  it('accepts a valid exported project', () => {
    const project = createDefaultProject('読み込みOK');
    const result = parseProjectFileImport(JSON.stringify(project));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.title).toBe('読み込みOK');
    }
  });

  it('accepts a valid project file with a UTF-8 BOM', () => {
    const project = createDefaultProject('BOM付き');
    const result = parseProjectFileImport(`\uFEFF${JSON.stringify(project)}`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.title).toBe('BOM付き');
    }
  });

  it('rejects invalid JSON with a beginner-facing message', () => {
    const result = parseProjectFileImport('{not json');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-json');
      expect(result.userMessage).toContain('.ctsproj.json');
      expect(result.diagnosticMessage).toContain('Project file import rejected');
    }
  });

  it('rejects unsupported future schema versions', () => {
    const project = { ...createDefaultProject('未来'), schemaVersion: 999 };
    const result = parseProjectFileImport(JSON.stringify(project));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-schema');
      expect(result.userMessage).toContain('アプリを更新');
    }
  });

  it('rejects invalid project contents without returning a project', () => {
    const project = { ...createDefaultProject('壊れた値'), bpm: 9999 };
    const result = parseProjectFileImport(JSON.stringify(project));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-project');
      expect(result.userMessage).toContain('現在の曲は変更していません');
      expect(result.diagnosticMessage).toContain('bpm');
    }
  });

  it('rejects oversized project files before parsing JSON', () => {
    const oversized = 'x'.repeat(5 * 1024 * 1024 + 1);
    const result = parseProjectFileImport(oversized);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('file-too-large');
      expect(result.userMessage).toContain('大きすぎます');
      expect(result.diagnosticMessage).toContain('limit=');
      expect(result.diagnosticMessage).not.toContain(oversized);
    }
  });
});

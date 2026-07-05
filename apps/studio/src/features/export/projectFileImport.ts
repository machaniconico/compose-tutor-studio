import {
  deserializeProject,
  validateProject,
  type Project,
} from '@cts/project-model';

export type ProjectFileImportFailureReason =
  | 'invalid-json'
  | 'unsupported-schema'
  | 'invalid-project'
  | 'file-too-large';

export type ProjectFileImportResult =
  | { ok: true; project: Project }
  | {
      ok: false;
      reason: ProjectFileImportFailureReason;
      userMessage: string;
      diagnosticMessage: string;
    };

const MAX_DIAGNOSTIC_DETAIL_LENGTH = 800;
const MAX_PROJECT_IMPORT_TEXT_LENGTH = 5 * 1024 * 1024;

export function parseProjectFileImport(text: string): ProjectFileImportResult {
  if (text.length > MAX_PROJECT_IMPORT_TEXT_LENGTH) {
    return importFailure(
      'file-too-large',
      `Imported project text is too large. chars=${text.length}; limit=${MAX_PROJECT_IMPORT_TEXT_LENGTH}`,
    );
  }

  let project: Project;
  try {
    project = deserializeProject(text);
  } catch (error) {
    const detail = errorDetail(error);
    const reason = isSchemaError(detail) ? 'unsupported-schema' : 'invalid-json';
    return importFailure(reason, detail);
  }

  if (!isProjectLike(project)) {
    return importFailure('invalid-project', 'Imported project is missing required fields.');
  }

  try {
    const validation = validateProject(project);
    if (!validation.ok) {
      return importFailure(
        'invalid-project',
        validation.errors
          .slice(0, 6)
          .map((error) => `${error.path}: ${error.message}`)
          .join('; '),
      );
    }
  } catch (error) {
    return importFailure('invalid-project', errorDetail(error));
  }

  return { ok: true, project };
}

function importFailure(
  reason: ProjectFileImportFailureReason,
  detail: string,
): ProjectFileImportResult {
  return {
    ok: false,
    reason,
    userMessage: userMessageForReason(reason),
    diagnosticMessage: `Project file import rejected. reason=${reason}; detail=${detail.slice(
      0,
      MAX_DIAGNOSTIC_DETAIL_LENGTH,
    )}`,
  };
}

function userMessageForReason(reason: ProjectFileImportFailureReason): string {
  if (reason === 'unsupported-schema') {
    return 'このプロジェクトは新しいバージョンで作成されています。アプリを更新してからもう一度読み込んでください。';
  }
  if (reason === 'invalid-project') {
    return 'プロジェクトファイルの内容が正しくありません。現在の曲は変更していません。';
  }
  if (reason === 'file-too-large') {
    return 'プロジェクトファイルが大きすぎます。Compose Tutor Studioで書き出した小さめの .ctsproj.json を選んでください。';
  }
  return 'プロジェクトファイルを読み込めませんでした。Compose Tutor Studioで書き出した .ctsproj.json を選んでください。';
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return String(error);
}

function isSchemaError(detail: string): boolean {
  return detail.includes('schemaVersion') || detail.includes('migration');
}

function isProjectLike(value: unknown): value is Project {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.schemaVersion === 'number' &&
    typeof v.title === 'string' &&
    typeof v.bpm === 'number' &&
    typeof v.updatedAt === 'string' &&
    Array.isArray(v.timeSignature) &&
    v.timeSignature.length === 2 &&
    typeof v.key === 'string' &&
    typeof v.scale === 'string' &&
    typeof v.lengthBars === 'number' &&
    Array.isArray(v.tracks) &&
    Array.isArray(v.chordTrack) &&
    Array.isArray(v.sections)
  );
}

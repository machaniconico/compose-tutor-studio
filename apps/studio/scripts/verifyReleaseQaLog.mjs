import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const defaultQaLogPath = join(appRoot, 'src-tauri', 'target', 'release', 'release', 'release-qa-log-draft.md');

const automatedGateCommands = [
  'pnpm check',
  'pnpm check:privacy',
  'pnpm check:secrets',
  'pnpm check:assets',
  'pnpm build',
  'pnpm check:size',
  'pnpm test:e2e',
  'pnpm build:desktop',
  'pnpm check:size:desktop',
  'pnpm release:manifest',
  'pnpm release:source-status',
  'pnpm release:source-status:verify',
  'pnpm release:verify',
  'pnpm release:verify:publish',
  'pnpm release:installers:verify',
  'pnpm release:installers:smoke:plan',
  'pnpm release:installers:smoke:verify',
  'pnpm release:signing',
  'pnpm release:signing:verify',
  'pnpm release:notices',
  'pnpm release:notices:verify',
  'pnpm release:gates:report',
  'pnpm release:qa-log',
  'pnpm release:qa-log:verify:draft',
  'pnpm release:notes',
  'pnpm release:notes:verify:draft',
  'pnpm check:release',
];

const manualQaIds = [
  'REL-MAN-001',
  'REL-MAN-002',
  'REL-MAN-003',
  'REL-MAN-004',
  'REL-MAN-005',
  'REL-MAN-006',
  'REL-MAN-007',
  'REL-MAN-008',
  'REL-MAN-009',
  'REL-MAN-010',
  'REL-MAN-011',
];

const manualEvidenceQaIds = new Set([
  'REL-MAN-001',
  'REL-MAN-002',
  'REL-MAN-003',
  'REL-MAN-004',
  'REL-MAN-005',
  'REL-MAN-007',
  'REL-MAN-008',
  'REL-MAN-009',
]);

const manualEvidenceHints = new Map([
  [
    'REL-MAN-001',
    {
      pattern: /release-installer-smoke-plan|REL-MAN-001|NSIS|Start-Process|setup\.exe/i,
      message: 'Manual QA evidence note for REL-MAN-001 must reference the NSIS smoke plan, command, or saved log.',
    },
  ],
  [
    'REL-MAN-002',
    {
      pattern: /release-installer-smoke-plan|REL-MAN-002|MSI|msiexec|ProductCode/i,
      message: 'Manual QA evidence note for REL-MAN-002 must reference the MSI smoke plan, command, or saved log.',
    },
  ],
  [
    'REL-MAN-003',
    {
      checks: [
        {
          pattern: /start screen|スタート画面/i,
          message: 'Manual QA evidence note for REL-MAN-003 must mention the Start screen.',
        },
        {
          pattern: /sample song|sample|サンプル曲/i,
          message: 'Manual QA evidence note for REL-MAN-003 must mention the sample song.',
        },
        {
          pattern: /playback|played|audio|sound|音|再生/i,
          message: 'Manual QA evidence note for REL-MAN-003 must mention the playback result.',
        },
      ],
    },
  ],
  [
    'REL-MAN-004',
    {
      checks: [
        {
          pattern: /new project|新規プロジェクト/i,
          message: 'Manual QA evidence note for REL-MAN-004 must mention the new project.',
        },
        {
          pattern: /save|saved|保存/i,
          message: 'Manual QA evidence note for REL-MAN-004 must mention the save result.',
        },
        {
          pattern: /restart|relaunch|reopened|再起動|開き直|復元/i,
          message: 'Manual QA evidence note for REL-MAN-004 must mention the restart or restore result.',
        },
      ],
    },
  ],
  [
    'REL-MAN-005',
    {
      checks: [
        {
          pattern: /export|exported|書き出|エクスポート/i,
          message: 'Manual QA evidence note for REL-MAN-005 must mention the project export.',
        },
        {
          pattern: /import|imported|read back|読み込|インポート/i,
          message: 'Manual QA evidence note for REL-MAN-005 must mention the project import.',
        },
        {
          pattern: /title|renamed|別タイトル|タイトル変更/i,
          message: 'Manual QA evidence note for REL-MAN-005 must mention the changed title.',
        },
      ],
    },
  ],
  [
    'REL-MAN-007',
    {
      pattern: /WAV|\.wav|OS standard player|Windows Media Player|Media Player|標準プレイヤー|再生/i,
      message: 'Manual QA evidence note for REL-MAN-007 must mention the WAV playback check or OS player used.',
    },
  ],
  [
    'REL-MAN-008',
    {
      checks: [
        {
          pattern: /OS standard|native file dialog|file dialog|Explorer|Save dialog|Open dialog|OS 標準|ファイルダイアログ|保存ダイアログ|読み込みダイアログ/i,
          message: 'Manual QA evidence note for REL-MAN-008 must mention the OS/native file dialog.',
        },
        {
          pattern: /export|save|書き出|保存/i,
          message: 'Manual QA evidence note for REL-MAN-008 must mention the export or save dialog path.',
        },
        {
          pattern: /import|open|読み込|開く/i,
          message: 'Manual QA evidence note for REL-MAN-008 must mention the import or open dialog path.',
        },
      ],
    },
  ],
  [
    'REL-MAN-009',
    {
      checks: [
        {
          pattern: /support|サポート/i,
          message: 'Manual QA evidence note for REL-MAN-009 must mention the Support screen evidence.',
        },
        {
          pattern:
            /error screen|unhandled error|unhandled-error|render error|render-error|error boundary|未処理エラー|エラー画面/i,
          message: 'Manual QA evidence note for REL-MAN-009 must mention the unhandled-error screen evidence.',
        },
        {
          pattern: /clipboard|manual copy|クリップボード|手動コピー/i,
          message: 'Manual QA evidence note for REL-MAN-009 must mention clipboard denial or manual-copy evidence.',
        },
      ],
    },
  ],
]);

const allowedResults = new Set(['Pass', 'Fail', 'Blocked', 'Not run']);

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

function parseArgs(argv) {
  const options = {
    allowDraft: false,
    path: process.env.CTS_RELEASE_QA_LOG_PATH || defaultQaLogPath,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-draft') {
      options.allowDraft = true;
    } else if (arg === '--path') {
      index += 1;
      if (!argv[index]) throw new Error('--path requires a file path.');
      options.path = argv[index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.path = isAbsolute(options.path) ? options.path : resolve(repoRoot, options.path);
  return options;
}

function normalizeCell(value) {
  return String(value ?? '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sectionText(text, headings) {
  const starts = headings
    .map((heading) => text.indexOf(heading))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);

  if (starts.length === 0) throw new Error(`Missing section: ${headings.join(' / ')}`);

  const start = starts[0];
  const next = text.slice(start + 1).search(/\n##\s+\d+\./);
  return next >= 0 ? text.slice(start, start + 1 + next) : text.slice(start);
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseFirstTable(section, label) {
  const lines = section.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*\|.*\|\s*$/.test(line));
  if (headerIndex < 0 || !lines[headerIndex + 1]) throw new Error(`Missing table in ${label}.`);

  const headers = splitTableRow(lines[headerIndex]);
  const rows = [];

  for (const line of lines.slice(headerIndex + 2)) {
    if (!/^\s*\|.*\|\s*$/.test(line)) break;
    const cells = splitTableRow(line);
    const row = {};
    headers.forEach((header, index) => {
      row[normalizeCell(header)] = normalizeCell(cells[index] ?? '');
    });
    rows.push(row);
  }

  if (rows.length === 0) throw new Error(`Table in ${label} has no rows.`);
  return rows;
}

function value(row, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  return '';
}

function mapKeyValueRows(rows, keyNames, valueNames) {
  const map = new Map();
  for (const row of rows) {
    map.set(value(row, keyNames), value(row, valueNames));
  }
  return map;
}

function isBlankOrPlaceholder(value) {
  return value === '' || value === 'YYYY-MM-DD' || value === 'Not run' || value === 'Not written';
}

function hasMeaningfulManualEvidenceNote(value) {
  const note = normalizeCell(value);
  const lowerNote = note.toLowerCase();
  const weakNotes = new Set(['', '-', 'N/A', 'NA', 'OK', 'Pass', 'Done', '確認済み']);
  return (
    !weakNotes.has(note) &&
    !lowerNote.includes('remains manual') &&
    !note.includes('手動で行う') &&
    !note.includes('ことも確認する') &&
    !note.includes('それぞれ確認する') &&
    !note.includes('を記録する') &&
    !note.includes('をメモする')
  );
}

function entriesCount(value) {
  if (value === 'Not run') return null;
  if (/^\d+$/.test(value)) return Number(value);
  return Number.NaN;
}

function signOffValue(text, label) {
  const match = text.match(new RegExp(`^- ${label}:[ \\t]*([^\\r\\n]*)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function validateQaLog(text, { allowDraft }) {
  const errors = [];
  const require = (condition, message) => {
    if (!condition) errors.push(message);
  };

  const candidateRows = parseFirstTable(
    sectionText(text, ['## 1. Candidate Build', '## 1. 候補ビルド']),
    'candidate build',
  );
  const sourceReviewRows = parseFirstTable(
    sectionText(text, ['## 2. Source Review Plan', '## 2. ソースレビュー計画']),
    'source review plan',
  );
  const artifactRows = parseFirstTable(
    sectionText(text, ['## 3. Distribution Artifacts', '## 3. 配布成果物']),
    'distribution artifacts',
  );
  const gateRows = parseFirstTable(
    sectionText(text, ['## 4. Automated Gate Results', '## 4. 自動ゲート結果']),
    'automated gate results',
  );
  const manualRows = parseFirstTable(
    sectionText(text, ['## 5. Windows Installer Manual QA', '## 5. Windows インストーラ手動QA']),
    'manual QA',
  );
  const limitationRows = parseFirstTable(
    sectionText(text, ['## 6. Known Limitations', '## 6. 既知の制限']),
    'known limitations',
  );
  const decisionRows = parseFirstTable(
    sectionText(text, ['## 7. Distribution Decision', '## 7. 配布判定']),
    'distribution decision',
  );

  const candidate = mapKeyValueRows(candidateRows, ['Item', '項目'], ['Record', '記録']);
  for (const item of ['Product', 'Version', 'Release candidate']) {
    require(!isBlankOrPlaceholder(candidate.get(item) ?? ''), `Candidate build is missing ${item}.`);
  }

  if (!allowDraft) {
    for (const item of ['QA date', 'Tester', 'Source branch or commit']) {
      require(!isBlankOrPlaceholder(candidate.get(item) ?? ''), `Candidate build is not ready: ${item} is blank.`);
    }

    for (const [item, placeholder] of [
      ['OS / edition', 'Windows 11 / Windows 10'],
      ['Machine type', 'Physical / VM'],
      ['Install state', 'Clean install / Upgrade'],
    ]) {
      const record = candidate.get(item) ?? '';
      require(record !== '' && record !== placeholder, `Candidate build is not ready: ${item} still uses a placeholder.`);
    }
  }

  for (const row of sourceReviewRows) {
    const bundle = value(row, ['Bundle', '束']);
    const entries = value(row, ['Entries', '件数']);
    const reviewStatus = value(row, ['Review status', 'レビュー状態']);
    const count = entriesCount(entries);
    require(bundle !== '', 'Source review plan row is missing Bundle.');
    require(!Number.isNaN(count), `${bundle || 'Source review plan'} has invalid entry count: ${entries || '(blank)'}.`);
    require(allowedResults.has(reviewStatus), `${bundle || 'Source review plan'} has invalid review status: ${reviewStatus || '(blank)'}.`);

    if (!allowDraft) {
      require(count === 0, `Source review plan still contains dirty entries: ${bundle}.`);
      require(reviewStatus === 'Pass', `Source review plan review status must be Pass: ${bundle}.`);
    }
  }

  for (const row of artifactRows) {
    const label = value(row, ['Type', '種別']) || 'artifact';
    const result = value(row, ['Result', '結果']);
    require(allowedResults.has(result), `${label} has invalid result: ${result || '(blank)'}.`);

    if (!allowDraft) {
      require(result === 'Pass', `${label} artifact result must be Pass.`);
      require(value(row, ['File', 'ファイル']) !== '', `${label} artifact file is blank.`);
      require(/^[a-f0-9]{64}$/i.test(value(row, ['SHA-256'])), `${label} artifact SHA-256 is missing or invalid.`);
      require(value(row, ['Size', 'サイズ']) !== '', `${label} artifact size is blank.`);
    }
  }

  const gateResults = new Map();
  for (const row of gateRows) {
    const command = value(row, ['Command', 'コマンド']);
    const result = value(row, ['Result', '結果']);
    gateResults.set(command, result);
    require(allowedResults.has(result), `${command || 'Automated gate'} has invalid result: ${result || '(blank)'}.`);
  }

  for (const command of automatedGateCommands) {
    require(gateResults.has(command), `Automated gate is missing ${command}.`);
    if (!allowDraft) require(gateResults.get(command) === 'Pass', `Automated gate must be Pass: ${command}.`);
  }

  const manualResults = new Map();
  const manualRowsById = new Map();
  for (const row of manualRows) {
    const id = value(row, ['ID']);
    const result = value(row, ['Result', '結果']);
    require(id !== '', 'Manual QA row is missing ID.');
    require(!manualRowsById.has(id), `Manual QA has duplicate ID: ${id}.`);
    manualResults.set(id, result);
    manualRowsById.set(id, row);
    require(allowedResults.has(result), `${id || 'Manual QA row'} has invalid result: ${result || '(blank)'}.`);
  }

  for (const id of manualQaIds) {
    require(manualResults.has(id), `Manual QA is missing ${id}.`);
    if (!allowDraft) {
      require(manualResults.get(id) === 'Pass', `Manual QA must be Pass: ${id}.`);

      if (manualEvidenceQaIds.has(id)) {
        const note = value(manualRowsById.get(id) ?? {}, ['Notes', 'メモ']);
        require(hasMeaningfulManualEvidenceNote(note), `Manual QA evidence note is required: ${id}.`);

        const hint = manualEvidenceHints.get(id);
        if (hint?.pattern) require(hint.pattern.test(note), hint.message);
        for (const check of hint?.checks ?? []) require(check.pattern.test(note), check.message);
      }
    }
  }

  if (!allowDraft) {
    for (const row of limitationRows) {
      const limitation = value(row, ['Limitation', '制限']);
      const impact = value(row, ['User impact', 'ユーザー影響']);
      const releaseNote = value(row, ['Release note entry', 'Release note 記載']);
      const followUp = value(row, ['Planned follow-up', '対応予定']);
      const isPlaceholderRow = [limitation, impact, releaseNote, followUp].every(isBlankOrPlaceholder);
      require(!isPlaceholderRow, 'Known limitations table still contains the blank placeholder row.');
      require(releaseNote !== 'Not written', `Known limitation is missing release note coverage: ${limitation || '(blank)'}.`);
    }
  }

  const decisions = mapKeyValueRows(decisionRows, ['Item', '項目'], ['Result', '結果']);
  for (const [item, result] of decisions) {
    const isFinalDecision = item === '配布してよい' || item === 'Ready to distribute';
    if (allowDraft) {
      require(result === 'Pass' || result === 'Not run' || result === 'Yes' || result === 'No', `${item} has invalid decision result: ${result}.`);
    } else if (isFinalDecision) {
      require(result === 'Yes', 'Distribution decision must be Yes.');
    } else {
      require(result === 'Pass', `Distribution decision item must be Pass: ${item}.`);
    }
  }

  require(text.includes('Sign-off:'), 'Missing Sign-off section.');
  if (!allowDraft) {
    for (const label of ['QA', 'Engineering', 'Release owner']) {
      require(signOffValue(text, label) !== '', `Sign-off is missing ${label}.`);
    }
  }

  return errors;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const text = await readFile(options.path, 'utf8');
  const errors = validateQaLog(text, options);

  if (errors.length > 0) {
    console.error(`Release QA log verification failed: ${relativeFromRepo(options.path)}`);
    for (const error of errors) console.error(`FAIL ${error}`);
    process.exitCode = 1;
    return;
  }

  const mode = options.allowDraft ? 'draft structure' : 'release-ready';
  console.log(`Release QA log verification passed (${mode}): ${relativeFromRepo(options.path)}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const documentationPaths = [
  'docs/01_product_requirements.md',
  'docs/02_feature_specification.md',
  'docs/04_ui_ux_spec.md',
  'docs/05_technical_architecture.md',
  'docs/06_data_model.md',
  'docs/08_qa_test_plan.md',
  'docs/09_risk_legal_notes.md',
  'docs/11_persistence_protocol.md',
  'docs/12_desktop_shell.md',
  'docs/13_pro_daw_gap_matrix.md',
  'docs/COMBINED_SPECIFICATION.md',
];

const sourcePaths = {
  codec: 'packages/project-bundle/src/codec.ts',
  projectCodec: 'packages/project-model/src/project-codec.ts',
  reservation: 'apps/studio/src/features/export/portableProjectBundleReservation.ts',
  nativeGateway: 'apps/studio/src/platform/nativeFileGateway.ts',
  portableService: 'apps/studio/src/features/export/portableProjectBundle.ts',
  exportMenu: 'apps/studio/src/features/export/ExportMenuContent.tsx',
  exportMenuShell: 'apps/studio/src/features/export/ExportMenu.tsx',
  portableE2e: 'apps/studio/e2e/portable-project-bundle.e2e.ts',
  nativeRust: 'apps/desktop/src-tauri/src/native_files.rs',
};

function scalarConstant(source, name) {
  const match = source.match(
    new RegExp(
      `\\b(?:export\\s+)?const\\s+${name}(?:\\s*:\\s*[^=;]+)?\\s*=\\s*([^;]+);`,
      'u',
    ),
  );
  if (!match) return null;
  const expression = match[1].trim().replaceAll('_', '').replace(/[()]/gu, '');
  if (!/^\d+(?:\s*\*\s*\d+)*$/u.test(expression)) return null;
  return expression
    .split('*')
    .map((part) => Number(part.trim()))
    .reduce((product, value) => product * value, 1);
}

function requireScalar(errors, source, sourcePath, name, expected) {
  const actual = scalarConstant(source, name);
  if (actual !== expected) {
    errors.push(
      `${sourcePath}: ${name} must equal ${expected} bytes; found ${
        actual === null ? 'a missing or non-literal constant' : actual
      }.`,
    );
  }
}

function requirePattern(errors, filePath, source, pattern, description) {
  if (!pattern.test(source)) {
    errors.push(`${filePath}: missing ${description}.`);
  }
}

function forbidPattern(errors, filePath, source, pattern, description) {
  if (pattern.test(source)) {
    errors.push(`${filePath}: contains obsolete or unsafe claim: ${description}.`);
  }
}

function ordered(source, patterns) {
  let offset = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(source.slice(offset));
    if (!match) return false;
    offset += match.index + match[0].length;
  }
  return true;
}

export async function checkPortableBundleDocs({ rootDir = defaultRoot } = {}) {
  const errors = [];
  const entries = await Promise.all([
    ...documentationPaths.map(async (relativePath) => [
      relativePath,
      await readFile(path.join(rootDir, relativePath), 'utf8'),
    ]),
    ...Object.entries(sourcePaths).map(async ([name, relativePath]) => [
      name,
      await readFile(path.join(rootDir, relativePath), 'utf8'),
    ]),
  ]);
  const documents = new Map(entries.slice(0, documentationPaths.length));
  const sources = Object.fromEntries(entries.slice(documentationPaths.length));
  const rootPackagePath = 'package.json';
  const rootPackage = JSON.parse(
    await readFile(path.join(rootDir, rootPackagePath), 'utf8'),
  );

  requireScalar(
    errors,
    sources.codec,
    sourcePaths.codec,
    'PORTABLE_PROJECT_BUNDLE_HEADER_BYTES',
    32,
  );
  requireScalar(
    errors,
    sources.codec,
    sourcePaths.codec,
    'MAX_PORTABLE_PROJECT_BUNDLE_MANIFEST_BYTES',
    512 * 1024,
  );
  requireScalar(
    errors,
    sources.codec,
    sourcePaths.codec,
    'MAX_PORTABLE_PROJECT_BUNDLE_BYTES',
    128 * 1024 * 1024,
  );
  requireScalar(
    errors,
    sources.projectCodec,
    sourcePaths.projectCodec,
    'DEFAULT_MAX_PROJECT_JSON_BYTES',
    16 * 1024 * 1024,
  );
  requireScalar(
    errors,
    sources.reservation,
    sourcePaths.reservation,
    'PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES',
    384 * 1024 * 1024,
  );
  requireScalar(
    errors,
    sources.nativeGateway,
    sourcePaths.nativeGateway,
    'NATIVE_PROJECT_BUNDLE_RESERVATION_BYTES',
    384 * 1024 * 1024,
  );
  requireScalar(
    errors,
    sources.nativeRust,
    sourcePaths.nativeRust,
    'PROJECT_BUNDLE_HEADER_BYTES',
    32,
  );
  requireScalar(
    errors,
    sources.nativeRust,
    sourcePaths.nativeRust,
    'PROJECT_BUNDLE_MANIFEST_MAX_BYTES',
    512 * 1024,
  );
  requireScalar(
    errors,
    sources.nativeRust,
    sourcePaths.nativeRust,
    'PROJECT_BUNDLE_MAX_BYTES',
    128 * 1024 * 1024,
  );
  requireScalar(
    errors,
    sources.nativeRust,
    sourcePaths.nativeRust,
    'PROJECT_MAX_BYTES',
    16 * 1024 * 1024,
  );
  requirePattern(
    errors,
    sourcePaths.nativeGateway,
    sources.nativeGateway,
    /NATIVE_PROJECT_BUNDLE_MAX_BYTES\s*=\s*MAX_PORTABLE_PROJECT_BUNDLE_BYTES/u,
    'the native gateway alias to the shared 128 MiB bundle limit',
  );
  requirePattern(
    errors,
    sourcePaths.nativeGateway,
    sources.nativeGateway,
    /manifestLength\s*>\s*NATIVE_PROJECT_BUNDLE_MANIFEST_MAX_BYTES[\s\S]*projectLength\s*>\s*NATIVE_PROJECT_FILE_MAX_BYTES/u,
    'native renderer header rejection for manifest and Project size caps',
  );
  requirePattern(
    errors,
    sourcePaths.nativeRust,
    sources.nativeRust,
    /manifest_length\s*>\s*PROJECT_BUNDLE_MANIFEST_MAX_BYTES\s*\|\|\s*project_length\s*>\s*PROJECT_MAX_BYTES/u,
    'native Rust header rejection for manifest and Project size caps',
  );

  requirePattern(
    errors,
    sourcePaths.codec,
    sources.codec,
    /setUint16\(8,\s*PORTABLE_PROJECT_BUNDLE_VERSION,\s*true\)[\s\S]*setUint16\(10,\s*0,\s*true\)[\s\S]*setUint32\(12,\s*manifestBytes\.byteLength,\s*true\)[\s\S]*setUint32\(16,\s*projectBytes\.byteLength,\s*true\)[\s\S]*setUint32\(20,\s*assets\.length,\s*true\)[\s\S]*setUint32\(24,\s*totalLength,\s*true\)[\s\S]*setUint32\(28,\s*0,\s*true\)/u,
    'the reviewed little-endian v1 header layout',
  );
  requirePattern(
    errors,
    sourcePaths.codec,
    sources.codec,
    /Exact encoded length projection; performs no repository reads or allocation/u,
    'the allocation-free operation size projection contract',
  );
  requirePattern(
    errors,
    sourcePaths.codec,
    sources.codec,
    /sort\(\(left, right\)[\s\S]*left\.checksumSha256/u,
    'canonical checksum ordering',
  );
  requirePattern(
    errors,
    sourcePaths.nativeRust,
    sources.nativeRust,
    /fn clone_validated_project_bundle_raw_body_with_observer[\s\S]*observe\("borrowed-size"\)[\s\S]*validate_payload_size\(FileFormat::ProjectBundle,[\s\S]*observe\("borrowed-header"\)[\s\S]*validate_project_bundle_bytes\(bytes\)\?;[\s\S]*observe\("clone"\);[\s\S]*Ok\(bytes\.clone\(\)\)/u,
    'borrowed native request validation followed by a bounded command-owned copy',
  );
  requirePattern(
    errors,
    sourcePaths.nativeRust,
    sources.nativeRust,
    /fn cancelled_open_envelope\(\) -> Vec<u8> \{\s*vec!\[0\]\s*\}/u,
    'the exact native open-cancel byte',
  );
  if (
    !ordered(sources.portableService, [
      /decodePortableProjectBundle\(bytes/u,
      /repository\.store\(/u,
      /receipt\.checksumSha256/u,
      /cloneProjectForImport/u,
      /replaceProject\(/u,
    ])
  ) {
    errors.push(
      `${sourcePaths.portableService}: import must fully decode, store, verify receipts, clone to a fresh ID, and only then replace the Project.`,
    );
  }
  requirePattern(
    errors,
    sourcePaths.portableService,
    sources.portableService,
    /repository has no delete operation[\s\S]*immutable unreferenced object/u,
    'the repository orphan limitation',
  );
  requirePattern(
    errors,
    sourcePaths.exportMenu,
    sources.exportMenu,
    /第三者へ渡すと素材も共有される[\s\S]*共有の許諾がある音源[\s\S]*自動で外部送信することはありません/u,
    'the original-audio sharing warning in the production export UI',
  );
  requirePattern(
    errors,
    sourcePaths.exportMenu,
    sources.exportMenu,
    /state\.project\s*!==\s*expectedProject/u,
    'the stale-Project adoption fence',
  );
  requirePattern(
    errors,
    sourcePaths.exportMenuShell,
    sources.exportMenuShell,
    /closeDisabled=\{activeOperation !== null\}/u,
    'the non-dismissible busy export/import dialog',
  );
  requirePattern(
    errors,
    sourcePaths.portableE2e,
    sources.portableE2e,
    /page\.on\('request'[\s\S]*\^\(\?:https\?\|wss\?\):[\s\S]*page\.on\('websocket'[\s\S]*target\.host !== allowedHost[\s\S]*expect\(sourceExternalRequests\)\.toEqual\(\[\]\)[\s\S]*expect\(destinationExternalRequests\)\.toEqual\(\[\]\)/u,
    'runtime HTTP(S), WebSocket, and beacon request monitoring in both browser contexts',
  );

  for (const relativePath of documentationPaths) {
    requirePattern(
      errors,
      relativePath,
      documents.get(relativePath),
      /\.ctsbundle/u,
      'the implemented .ctsbundle format',
    );
  }

  const contractDocuments = [
    'docs/02_feature_specification.md',
    'docs/05_technical_architecture.md',
    'docs/11_persistence_protocol.md',
  ];
  const contractRequirements = [
    [/\.ctsproj\.json/u, 'the metadata-only .ctsproj.json boundary'],
    [/32[- ]byte|32 bytes/u, 'the 32-byte header'],
    [/512 KiB/u, 'the 512 KiB manifest limit'],
    [/16 MiB/u, 'the 16 MiB Project JSON limit'],
    [/128 MiB/u, 'the 128 MiB total bundle limit'],
    [/384 MiB/u, 'the 384 MiB renderer reservation'],
    [/borrow/u, 'borrowed decode/native validation'],
    [/clone/u, 'the bounded native/fresh-Project clone boundary'],
    [/\[0x00\]/u, 'the exact native open-cancel wire'],
    [/receipt/u, 'all repository receipts before adoption'],
    [/fresh(?: Project ID|-ID| ID)/u, 'fresh Project identity on import'],
    [/orphan|未参照object/u, 'the orphan/GC limitation'],
  ];
  for (const relativePath of contractDocuments) {
    const source = documents.get(relativePath);
    for (const [pattern, description] of contractRequirements) {
      requirePattern(errors, relativePath, source, pattern, description);
    }
  }

  const documentSpecificRequirements = {
    'docs/01_product_requirements.md': [
      [/音声素材を含む持ち運び/u, 'the user-facing portable-copy requirement'],
      [/operation開始前[\s\S]*checked integer/u, 'computed operation rejection'],
    ],
    'docs/04_ui_ux_spec.md': [
      [/編集情報のみ \(\.ctsproj\.json\)/u, 'the metadata-only section label'],
      [/音声素材を含む持ち運び用 \(\.ctsbundle\)/u, 'the portable section label'],
      [/Portable Projectのcancel/u, 'the no-op cancellation message contract'],
    ],
    'docs/06_data_model.md': [
      [/Portable Project Bundle projection/u, 'the portable projection boundary'],
      [/full validation後[\s\S]*fresh Project ID/u, 'validation/store/adoption ordering'],
    ],
    'docs/08_qa_test_plan.md': [
      [/E2E-008: 音声素材を含むPortable Project/u, 'the portable browser E2E scenario'],
      [/baseURL以外のHTTP\(S\)、WebSocket、sendBeacon/u, 'the runtime no-network assertion'],
    ],
    'docs/09_risk_legal_notes.md': [
      [/元Audio Asset bytes/u, 'the original-audio sharing disclosure'],
      [/第三者へ渡すと音声素材も共有/u, 'the recipient-facing sharing warning'],
      [/自動で外部送信することはありません/u, 'the no-automatic-upload assurance'],
    ],
    'docs/12_desktop_shell.md': [
      [/file_open_project_bundle.*file_export_project_bundle/u, 'the dedicated native commands'],
      [/project\/portable project\/MIDI\/WAVには触れない/u, 'the external bundle erase exclusion'],
    ],
    'docs/13_pro_daw_gap_matrix.md': [
      [/Portable Project Bundle increment:[^\n]*実装する/u, 'the implemented status entry'],
      [/Portable Project Bundle release gate/u, 'the remaining signed-candidate gate'],
    ],
  };
  for (const [relativePath, requirements] of Object.entries(documentSpecificRequirements)) {
    const source = documents.get(relativePath);
    for (const [pattern, description] of requirements) {
      requirePattern(errors, relativePath, source, pattern, description);
    }
  }

  const protocolPath = 'docs/11_persistence_protocol.md';
  const protocol = documents.get(protocolPath);
  for (const [pattern, description] of [
    [/0\.\.7[\s\S]*CTSBNDL1/u, 'header magic at bytes 0..7'],
    [/8\.\.9[\s\S]*version `1`/u, 'little-endian version at bytes 8..9'],
    [/10\.\.11[\s\S]*flags `0`/u, 'zero flags at bytes 10..11'],
    [/12\.\.15[\s\S]*manifest byte length/u, 'manifest length at bytes 12..15'],
    [/16\.\.19[\s\S]*Project JSON byte length/u, 'Project length at bytes 16..19'],
    [/20\.\.23[\s\S]*asset count/u, 'asset count at bytes 20..23'],
    [/24\.\.27[\s\S]*exact byte length/u, 'total length at bytes 24..27'],
    [/28\.\.31[\s\S]*reserved `0`/u, 'zero reserved bytes at 28..31'],
    [/format \/ version \/ project \/ assets/u, 'the exact root manifest keys'],
    [/byteLength \/ checksumSha256/u, 'the exact descriptor keys'],
    [/full validation[\s\S]*store/u, 'full validation before repository store'],
    [/全store receipt[\s\S]*fresh ID/u, 'all receipts before fresh-ID adoption'],
    [/Elastic Audio[\s\S]*ハミング[\s\S]*カラオケ/u, 'derived/transient audio exclusions'],
  ]) {
    requirePattern(errors, protocolPath, protocol, pattern, description);
  }

  const obsoletePatterns = [
    [/Project Bundle（将来案/u, 'Project Bundle as a future proposal'],
    [/MVP未実装/u, 'Project Bundle as unimplemented'],
    [/per-song bundleは引き続き将来案/u, 'per-song bundle as a future proposal'],
    [/futureのper-song bundle proposal/u, 'the old directory proposal'],
    [/portable binary bundle[^。\n]*ない/u, 'portable binary bundle as nonexistent'],
    [/portable bundleはない/u, 'portable bundle as nonexistent'],
    [/portable bundle、waveform/u, 'portable bundle in the future-scope list'],
    [/交換形式は`.ctsproj\.json`だけ/u, '.ctsproj.json as the only exchange format'],
    [/唯一の交換形式/u, '.ctsproj.json as the only exchange format'],
    [/現行MVPの保存・入出力形式ではない/u, 'the bundle as outside current I/O'],
  ];
  for (const relativePath of documentationPaths) {
    const source = documents.get(relativePath);
    for (const [pattern, description] of obsoletePatterns) {
      forbidPattern(errors, relativePath, source, pattern, description);
    }
    for (const [pattern, description] of [
      [/\bclone-free(?:である|を保証する[。.])/iu, 'a clone-free native transport guarantee'],
      [/JSON\/base64 IPCを使う/u, 'JSON/base64 portable bundle IPC'],
      [/検証前にstore/u, 'repository store before full validation'],
      [/receipt照合前に[^。\n]*(?:adoption|採用|置換)/u, 'Project adoption before receipt verification'],
    ]) {
      forbidPattern(errors, relativePath, source, pattern, description);
    }
  }

  if (
    rootPackage.scripts?.['docs:portable-bundle:check']
    !== 'node scripts/check-portable-bundle-docs.mjs'
  ) {
    errors.push(
      `${rootPackagePath}: docs:portable-bundle:check must run node scripts/check-portable-bundle-docs.mjs.`,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Portable Project Bundle documentation contract failed:\n- ${errors.join('\n- ')}`,
    );
  }
  return {
    documents: documentationPaths.length,
    checkedSources: Object.keys(sourcePaths).length,
  };
}

if (
  process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const result = await checkPortableBundleDocs();
  console.log(
    `Verified Portable Project Bundle contract across ${result.documents} documents and ${result.checkedSources} source boundaries.`,
  );
}

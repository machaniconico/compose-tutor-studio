import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, 'docs/COMBINED_SPECIFICATION.md');
const sourcePaths = [
  'docs/00_assumptions.md',
  'docs/00_project_brief.md',
  'docs/01_product_requirements.md',
  'docs/02_feature_specification.md',
  'docs/03_tutorial_learning_spec.md',
  'docs/04_ui_ux_spec.md',
  'docs/05_technical_architecture.md',
  'docs/06_data_model.md',
  'docs/07_development_plan.md',
  'docs/08_qa_test_plan.md',
  'docs/09_risk_legal_notes.md',
  'docs/10_source_research.md',
];

const preamble = [
  '# Compose Tutor Studio 仕様書 v0.1.0',
  '',
  '作成日: 2026-06-11',
  '',
  '> 現行のCubase Pro / Logic Pro比較、実装済・部分・未実装の判定、Batch 3以降の依存roadmapの正本は`docs/13_pro_daw_gap_matrix.md`である。本書に含む`07. 開発計画とタスク分解`のMVP Phase / Milestoneは初期計画の履歴であり、現在の実装順序として使わない。',
].join('\n');

const sources = await Promise.all(
  sourcePaths.map(async (sourcePath) =>
    (await readFile(resolve(root, sourcePath), 'utf8'))
      .replaceAll('\r\n', '\n')
      .trimEnd(),
  ),
);
const combined = `${[preamble, ...sources].join('\n\n---\n\n')}\n`;

if (process.argv.includes('--check')) {
  const current = (await readFile(outputPath, 'utf8')).replaceAll('\r\n', '\n');
  if (current !== combined) {
    throw new Error('docs/COMBINED_SPECIFICATION.md is stale; run pnpm docs:combine.');
  }
  console.log(`Verified combined specification from ${sourcePaths.length} source files.`);
} else {
  await writeFile(outputPath, combined, 'utf8');
  console.log(`Generated docs/COMBINED_SPECIFICATION.md from ${sourcePaths.length} source files.`);
}

// 期待値ファイルの読み書き。GOLDEN_UPDATE=1 のときだけ書き換える。通常実行は比較のみ。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const UPDATE_GOLDEN = process.env.GOLDEN_UPDATE === '1';

/** 期待値と一致するか確認する。差異があれば Error を投げる。 */
export function checkGolden(path: string, actual: string): void {
  if (UPDATE_GOLDEN) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(`golden missing: ${path} (GOLDEN_UPDATE=1 で生成。README 参照)`);
  }
  if (readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== actual) {
    throw new Error(`golden mismatch: ${path} (意図した v10 出力変更でなければ回帰)`);
  }
}

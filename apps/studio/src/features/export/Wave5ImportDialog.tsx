import { useEffect, useRef, useState } from 'react';
import type { Project } from '@cts/project-model';
import { Dialog } from '../common/Dialog';
import type { Wave5ConversionOffer, Wave5ImportConversion } from './wave5Import';

type Props = {
  plan: Wave5ConversionOffer;
  onOpen: (project: Project) => void;
  onCancel: () => void;
};

export function Wave5ImportDialog({ plan, onOpen, onCancel }: Props) {
  const [result, setResult] = useState<Wave5ImportConversion | null>(null);
  const [opening, setOpening] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (result) cancelRef.current?.focus({ preventScroll: true });
  }, [result]);

  const changed = result?.ok ? result.report.filter((item) => item.severity === 'changed').length : 0;
  const dropped = result?.ok ? result.report.filter((item) => item.severity === 'dropped').length : 0;
  return (
    <Dialog title="以前の曲を読み込む" onClose={onCancel} closeDisabled={opening}>
      <div className="export-menu">
        {result === null ? <p>{plan.message}</p> : result.ok ? (
          <>
            <p>変わる項目 {changed}件、消える項目 {dropped}件</p>
            <p>元のファイルは変わりません。コピーとして開きます。</p>
            {result.lines.length === 0 ? <p>ほかにお知らせする項目はありません。</p> : (
              <ul className="wave5-import-report">
                {result.lines.map(({ code, text }, index) => <li key={`${code}-${index}`}>{text}</li>)}
              </ul>
            )}
          </>
        ) : <p role="alert">{result.message}</p>}
        <div className="export-menu__row">
          <button type="button" ref={cancelRef} data-modal-initial-focus onClick={onCancel} disabled={opening}>
            やめる
          </button>
          {result === null ? <button type="button" onClick={() => setResult(plan.convert())}>変換する</button> : null}
          {result?.ok ? (
            <button type="button" disabled={opening} onClick={() => {
              setOpening(true);
              onOpen(result.project);
            }}>
              この内容で開く
            </button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

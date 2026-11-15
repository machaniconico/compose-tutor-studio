import { shortcutHelpGroups, shortcutKeyLabel } from '../../state/keymap';
import { Dialog } from './Dialog';

/** Beginner-friendly list of the keyboard shortcuts, grouped by where they work. */
export function ShortcutHelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="キーボード操作の一覧" onClose={onClose} className="dialog--wide">
      <div className="shortcut-help">
        {shortcutHelpGroups().map((group) => (
          <section key={group.scope}>
            <h3>{group.titleJa}</h3>
            <table>
              <tbody>
                {group.entries.map((entry) => {
                  const keys = shortcutKeyLabel(entry);
                  return (
                    <tr key={keys}>
                      <th scope="row">
                        <kbd>{keys}</kbd>
                      </th>
                      <td>{entry.labelJa}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ))}
        <p>文字を入力している間は、これらのキーは働きません。</p>
      </div>
    </Dialog>
  );
}

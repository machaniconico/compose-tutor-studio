import {
  invoke as invokeTauriCommand,
  isTauri as detectTauriRuntime,
} from '@tauri-apps/api/core';

/** Native commands exposed by the desktop persistence boundary. */
export const PERSISTENCE_COMMANDS = {
  initialize: 'persistence_initialize',
  list: 'persistence_list',
  load: 'persistence_load',
  projectState: 'persistence_get_project_state',
  loadBranch: 'persistence_load_branch',
  loadMostRecent: 'persistence_load_most_recent',
  stageCrashDraft: 'persistence_stage_crash_draft',
  save: 'persistence_save',
  remove: 'persistence_remove',
  eraseAllStatus: 'persistence_get_erase_all_status',
  prepareEraseAll: 'persistence_prepare_erase_all',
  completeEraseAll: 'persistence_complete_erase_all',
} as const;

export type PersistenceCommand =
  (typeof PERSISTENCE_COMMANDS)[keyof typeof PERSISTENCE_COMMANDS];

export type TauriInvokeArguments = Readonly<Record<string, unknown>>;

/**
 * Small injectable boundary around the module Tauri API.
 *
 * `withGlobalTauri` remains disabled: runtime detection and IPC use the
 * official bundled module instead of the public `window.__TAURI__` global.
 * Results deliberately remain `unknown` until the repository validates them.
 */
export type TauriBridge = Readonly<{
  isTauri: () => boolean;
  invoke: (
    command: PersistenceCommand,
    args?: TauriInvokeArguments,
  ) => Promise<unknown>;
}>;

export type TauriBridgeOptions = Readonly<{
  isTauri?: () => boolean;
  invoke?: TauriBridge['invoke'];
}>;

export function createTauriBridge(options: TauriBridgeOptions = {}): TauriBridge {
  return {
    isTauri: options.isTauri ?? detectTauriRuntime,
    invoke:
      options.invoke ??
      ((command, args) => invokeTauriCommand<unknown>(command, args)),
  };
}

export const tauriBridge = createTauriBridge();

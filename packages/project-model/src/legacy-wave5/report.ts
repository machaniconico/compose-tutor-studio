import type { Project } from '../types';

const SEVERITY = {
  'legacy-bar-limit-dropped': 'info',
  'loop-range-dropped': 'dropped',
  'legacy-clip-settings-dropped': 'info',
  'loop-unrolled': 'changed',
  'drum-loop-snapped': 'changed',
  'link-materialized': 'changed',
  'link-broken': 'info',
  'link-cyclic': 'info',
  'duplicate-role-demoted': 'changed',
  'send-dropped': 'dropped',
  'automation-lane-dropped': 'dropped',
  'automation-point-dropped': 'info',
  'audio-clip-unresolved': 'changed',
  'chord-track-audible': 'changed',
  'effects-approximated': 'changed',
  'effect-adjusted': 'changed',
  'effect-dropped': 'dropped',
  'hidden-events-dropped': 'dropped',
  'song-end-trimmed': 'dropped',
  'overlap-split': 'changed',
  'drum-hits-merged': 'dropped',
  'clip-type-changed': 'changed',
} as const;

export type Wave5ReportCode = keyof typeof SEVERITY;
export type Wave5ReportSeverity = (typeof SEVERITY)[Wave5ReportCode];
export const WAVE5_REPORT_CODES: readonly Wave5ReportCode[] = Object.freeze(
  Object.keys(SEVERITY) as Wave5ReportCode[],
);

export type Wave5ReportItem = {
  code: Wave5ReportCode;
  severity: Wave5ReportSeverity;
  trackId?: string;
  clipId?: string;
  effectId?: string;
  detail?: Record<string, string | number | boolean>;
};

export type Wave5ConvertErrorCode = 'not-wave5-v3' | 'invalid-project' | 'over-limit';
export type Wave5ConvertResult =
  | { ok: true; project: Project; report: Wave5ReportItem[] }
  | { ok: false; code: Wave5ConvertErrorCode; reason: string };

export type Report = (code: Wave5ReportCode, fields?: Omit<Wave5ReportItem, 'code' | 'severity'>) => void;

export function reportTo(items: Wave5ReportItem[]): Report {
  return (code, fields) => items.push({ code, severity: SEVERITY[code], ...fields });
}

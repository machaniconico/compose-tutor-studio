import type { MidiRecordingEvent } from '../../state/midiRecording';

/** Input adapters supply note edges; every source shares the transport audio clock. */
export type MidiRecordingNoteInput = (event: Omit<MidiRecordingEvent, 'timeSec'>) => void;

export function createMidiRecordingInput(
  clock: Pick<BaseAudioContext, 'currentTime'>,
  originTime: number,
  feed: (event: MidiRecordingEvent) => void,
): { elapsed: () => number; note: MidiRecordingNoteInput } {
  const elapsed = () => Math.max(0, clock.currentTime - originTime);
  return {
    elapsed,
    note: (event) => feed({ ...event, timeSec: elapsed() }),
  };
}

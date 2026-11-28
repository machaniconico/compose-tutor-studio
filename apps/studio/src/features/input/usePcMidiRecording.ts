import { beatToSecondsAt, PPQ, timeSignatureAtBeat } from '@cts/project-model';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAudioEngine } from '../../audio/engine';
import { scheduleMetronomeClick, type ScheduledMetronomeClick } from '../../audio/metronome';
import type { DropReason, MidiRecordingOptions, MidiRecordingStopped } from '../../state/midiRecording';
import { useStore } from '../../state/store';
import { getPcKeyboardMode } from './pcKeyboardMode';
import { createMidiRecordingInput, type MidiRecordingNoteInput } from './midiRecordingInput';

const dropLabels: Record<DropReason, string> = {
  'pitch-out-of-range': '使える音の高さの範囲外',
  'zero-length': '短すぎて長さがつかなかった',
  'outside-clip': '音の始まりがクリップの外',
  'same-pitch-overlap': '同じ高さの音が重なった',
  invalid: 'クリップに入れられなかった',
};

function describeTake(result: MidiRecordingStopped): string {
  const details = Object.entries(dropLabels).flatMap(([key, label]) => {
    const count = result.droppedByReason[key as DropReason];
    return count ? [`${label}（${count}音）`] : [];
  });
  const summary = result.changed ? '録音を反映しました。' : 'クリップはそのままです。';
  return `${summary} 入らなかった音は ${result.droppedCount} 音です。${details.join('、')}`;
}

export function usePcMidiRecording(playing: boolean) {
  const active = useStore((state) => state.midiRecordingActive);
  const failure = useStore((state) => state.midiRecordingStopFailure);
  const [status, setStatus] = useState('');
  const [arming, setArming] = useState(false);
  const runtime = useRef<{
    input: ReturnType<typeof createMidiRecordingInput>;
    clicks: ScheduledMetronomeClick[];
    timer?: ReturnType<typeof setTimeout>;
  } | null>(null);

  const cancelCountIn = useCallback(() => {
    const take = runtime.current;
    if (!take) return;
    clearTimeout(take.timer);
    for (const click of take.clicks.splice(0)) click.cancel();
  }, []);

  const releaseClock = useCallback(() => {
    cancelCountIn();
    runtime.current = null;
  }, [cancelCountIn]);

  const finish = useCallback(() => {
    const result = useStore.getState().stopMidiRecording();
    if (result?.ok) setStatus(describeTake(result));
  }, []);

  const discard = useCallback(() => {
    if (!window.confirm('録音した内容を捨てて、録音を終えますか？')) return;
    useStore.getState().discardMidiRecording();
    setStatus('テイクを捨てて録音を終えました。');
  }, []);

  useEffect(() => useStore.subscribe((state, previous) => {
    if (!state.midiRecordingActive && previous.midiRecordingActive) releaseClock();
  }), [releaseClock]);

  useEffect(() => {
    if (!playing && runtime.current && useStore.getState().finalizeMidiRecording()) setStatus('');
  }, [playing]);

  useEffect(() => () => {
    if (runtime.current && useStore.getState().finalizeMidiRecording()) releaseClock();
    else cancelCountIn();
  }, [cancelCountIn, releaseClock]);

  const noteInput: MidiRecordingNoteInput = useCallback((event) => {
    runtime.current?.input.note(event);
  }, []);

  const start = async (settings: Pick<MidiRecordingOptions, 'mode' | 'countInBars' | 'autoQuantize'>) => {
    const before = useStore.getState();
    setArming(true);
    setStatus('');
    try {
      const { context, master } = await getAudioEngine().ensureContext();
      if (!getPcKeyboardMode().playing) return;
      const state = useStore.getState();
      if (state.saveState.activationId !== before.saveState.activationId) return;
      if (state.transport.phase !== 'stopped') {
        setStatus('再生を止めてから録音を始めてください。');
        return;
      }
      const track = state.project.tracks.find((item) => item.id === state.editor.selectedTrackId);
      const clip = track?.clips.find((item) => item.id === state.editor.selectedClipId);
      if (track?.type !== 'instrument' || clip?.type !== 'midi') {
        setStatus('録音する楽器のクリップを選んでください。');
        return;
      }
      const { positionBeat, loopEnabled, loopStartBeat, loopEndBeat } = state.transport;
      const loop = loopEnabled ? { startBeat: loopStartBeat, endBeat: loopEndBeat } : null;
      const position = positionBeat >= clip.startBeat && positionBeat < clip.startBeat + clip.lengthBeats
        ? positionBeat
        : clip.startBeat;
      const origin = context.currentTime;
      const input = createMidiRecordingInput(context, origin, state.feedMidiRecording);
      const result = state.startMidiRecording({
        ...settings,
        clipId: clip.id,
        startBeat: Math.round(position * PPQ) / PPQ,
        loop,
      }, input.elapsed);
      if (!result.ok) {
        setStatus(result.message);
        return;
      }
      const session = result.session;
      const take = {
        input,
        clicks: [] as ScheduledMetronomeClick[],
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
      };
      runtime.current = take;
      if (settings.countInBars === 1) {
        const [count, denominator] = timeSignatureAtBeat(session.musicalTime, session.startTick / PPQ);
        for (let index = 0; index < count; index += 1) {
          const beat = session.originBeat + index * (4 / denominator);
          const offset = beatToSecondsAt(session.musicalTime, beat) - session.originSeconds;
          take.clicks.push(scheduleMetronomeClick(context, master, origin + offset, index === 0));
        }
        setStatus('カウントイン中。合図のあとに弾いてください。');
        take.timer = setTimeout(() => setStatus('録音中。PC 鍵盤で弾いてください。'), session.countInSeconds * 1000);
      } else {
        setStatus('録音中。PC 鍵盤で弾いてください。');
      }
    } catch {
      if (runtime.current) useStore.getState().finalizeMidiRecording();
      setStatus('音の準備ができませんでした。もう一度お試しください。');
    } finally {
      setArming(false);
    }
  };

  return { active, arming, status: failure?.message ?? status, start, finish, discard, canDiscard: failure !== null, noteInput };
}

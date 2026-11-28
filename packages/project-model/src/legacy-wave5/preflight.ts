import { MAX_CLIPS_PER_TRACK } from '../limits';
import { MAX_RUNTIME_SCHEDULE_EVENTS } from '../schedule-budget';
import { MAX_PROJECT_TRACKS } from '../validation';
import { OverLimit, type LegacyProject } from './input';

const RAW_WORK_FACTOR = 8;
export const MAX_LEGACY_EVENT_WORK = RAW_WORK_FACTOR * MAX_RUNTIME_SCHEDULE_EVENTS;

/** Guard normalization work. Main's limits apply to the surviving project. */
export function checkRawWorkLimits(project: LegacyProject): void {
  if (project.tracks.length > RAW_WORK_FACTOR * MAX_PROJECT_TRACKS) throw new OverLimit();

  let events = project.chordTrack?.length ?? 0;
  for (const track of project.tracks) {
    if (track.clips.length > RAW_WORK_FACTOR * MAX_CLIPS_PER_TRACK) throw new OverLimit();
    for (const clip of track.clips) {
      events += (clip.notes?.length ?? 0) + (clip.drumEvents?.length ?? 0);
      if (events > MAX_LEGACY_EVENT_WORK) throw new OverLimit();
    }
  }
}

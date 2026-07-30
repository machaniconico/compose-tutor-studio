/** Shared domain limits that are needed below the validation layer. */
export const MAX_CLIPS_PER_TRACK = 1_024;
export const MIN_EVENT_DURATION_BEATS = 1 / 960;
export const MAX_AUDIO_TAKE_FOLDERS = 1_024;
export const MAX_AUDIO_TAKES_PER_FOLDER = 128;
export const MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER = 4_096;
export const MAX_AUDIO_WARP_MARKERS = 128;
export const MAX_AUDIO_PITCH_REGIONS = 128;
export const MAX_AUDIO_WARP_SECONDS = 60;
export const MIN_AUDIO_WARP_SEGMENT_SECONDS = 0.04;
export const MIN_AUDIO_WARP_STRETCH = 0.5;
export const MAX_AUDIO_WARP_STRETCH = 2;
export const MAX_AUDIO_PITCH_SHIFT_CENTS = 300;

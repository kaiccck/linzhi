/** UI state of the check screen: one small reducer, owned by <Screen>. */

export type Profile = 'adult' | 'elder';

export interface UiState {
  /** walking time shown on the map, seconds (0–1200) */
  T: number;
  profile: Profile;
  circle: boolean;
  heat: boolean;
  /** unit code under the pointer / focus, linking map and directory */
  hot: string | null;
  /** 走一遍 replay running: plates, codes and cells hold back their verdict */
  playing: boolean;
  /** the replay has finished at least once (button reads 再走一遍) */
  walked: boolean;
}

export type UiAction =
  | { type: 'scrub'; T: number }
  | { type: 'profile'; profile: Profile }
  | { type: 'circle'; on: boolean }
  | { type: 'heat'; on: boolean }
  | { type: 'hot'; code: string | null }
  | { type: 'play' }
  | { type: 'tick'; T: number }
  | { type: 'stop' }
  | { type: 'finish' };

export const initialUi: UiState = {
  T: 900,
  profile: 'adult',
  circle: true,
  heat: true,
  hot: null,
  playing: false,
  walked: false,
};

export function uiReducer(s: UiState, a: UiAction): UiState {
  switch (a.type) {
    case 'scrub':
      return { ...s, T: a.T, playing: false };
    case 'profile':
      return s.profile === a.profile ? s : { ...s, profile: a.profile };
    case 'circle':
      return { ...s, circle: a.on };
    case 'heat':
      return { ...s, heat: a.on };
    case 'hot':
      return s.hot === a.code ? s : { ...s, hot: a.code };
    case 'play':
      return { ...s, playing: true, T: 0 };
    case 'tick':
      return s.playing ? { ...s, T: a.T } : s;
    case 'stop':
      return s.playing ? { ...s, playing: false } : s;
    case 'finish':
      return { ...s, playing: false, walked: true, T: 900 };
  }
}

/** UI state of the check screen: one small reducer, owned by <Screen>. */
import type { HardCategory, XY } from '@zoudedao/core';
import type { RouteEvidence } from './data/route.js';
import type { WhatIfResult } from './data/whatif.js';

export type Profile = 'adult' | 'elder';

/** The top bar's working modes (报告 is a view of its own, see App's `View`). */
export type Mode = 'check' | 'plan' | 'ask';

/** 体检's two views in the panel: the 体检单 chart, or 圈内设施. */
export type CheckView = 'sheet' | 'fac';

export interface UiState {
  /** walking time shown on the map, seconds (0–1200) */
  T: number;
  profile: Profile;
  circle: boolean;
  heat: boolean;
  /** 灰色区域 layer (facility gaps) on the map; off until asked for, like the mockup */
  gray: boolean;
  /** 方法 layer: the samples by source, the walking paths and the detected barriers (for judges) */
  method: boolean;
  /** 含过街等待: walking time +5 % on the time field and the readouts (a sensitivity estimate) */
  crossing: boolean;
  /** unit code under the pointer / focus, linking map and panel */
  hot: string | null;
  /** 走一遍 replay running: plates, codes and rows hold back their verdict */
  playing: boolean;
  /** the replay has finished at least once (button reads 再走一遍) */
  walked: boolean;
  /** 圈内设施: the categories whose facilities the map shows (all at once is too crowded) */
  facCats: string[];
}

export type UiAction =
  | { type: 'scrub'; T: number }
  | { type: 'profile'; profile: Profile }
  | { type: 'circle'; on: boolean }
  | { type: 'heat'; on: boolean }
  | { type: 'gray'; on: boolean }
  | { type: 'method'; on: boolean }
  | { type: 'crossing'; on: boolean }
  | { type: 'hot'; code: string | null }
  | { type: 'facCat'; cat: string; on: boolean }
  | { type: 'play' }
  | { type: 'tick'; T: number }
  | { type: 'stop' }
  | { type: 'finish' }
  /** another analysis is on screen: its reach starts at 15′, nothing lit, the layers as they were */
  | { type: 'reset' };

export const initialUi: UiState = {
  T: 900,
  profile: 'adult',
  circle: true,
  heat: true,
  gray: false,
  method: false,
  crossing: false,
  hot: null,
  playing: false,
  walked: false,
  facCats: ['幼儿园', '小学', '菜市场', '药店', '社区卫生'],
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
    case 'gray':
      return { ...s, gray: a.on };
    case 'method':
      return { ...s, method: a.on };
    case 'crossing':
      return { ...s, crossing: a.on };
    case 'hot':
      return s.hot === a.code ? s : { ...s, hot: a.code };
    case 'facCat':
      return a.on === s.facCats.includes(a.cat)
        ? s
        : { ...s, facCats: a.on ? [...s.facCats, a.cat] : s.facCats.filter((c) => c !== a.cat) };
    case 'play':
      return { ...s, playing: true, T: 0 };
    case 'tick':
      return s.playing ? { ...s, T: a.T } : s;
    case 'stop':
      return s.playing ? { ...s, playing: false } : s;
    case 'finish':
      return { ...s, playing: false, walked: true, T: 900 };
    case 'reset':
      return { ...s, T: 900, hot: null, playing: false, walked: false };
  }
}

/**
 * 假如在这里开一家…: a site the planner put on the map, in the analysis' local metres and BD-09. It
 * is judged for the category chosen in the panel, so switching category asks the same place again.
 */
export interface WhatIfSite {
  xy: XY;
  bd09: [number, number];
}

/**
 * 实测核验 of a site (POST /api/whatif), or a measurement saved earlier (an analysis branch). A
 * measurement answers one category: it stays only while that category is on screen.
 */
export type Measure =
  | { status: 'idle' }
  | { status: 'running'; cat: HardCategory }
  | {
      status: 'done';
      cat: HardCategory;
      result: WhatIfResult;
      /** read back from the analysis' saved branches (no new Baidu call) */
      saved?: { id: string; created_at: string };
    }
  | { status: 'failed'; cat: HardCategory; message: string };

export interface PlanState {
  /** the next map click places a site (instead of picking a new centre) */
  placing: boolean;
  site: WhatIfSite | null;
  measure: Measure;
  /** a suggestion under the pointer, lit on the map and in the list */
  hotSite: string | null;
}

export const initialPlan: PlanState = {
  placing: false,
  site: null,
  measure: { status: 'idle' },
  hotSite: null,
};

/**
 * 步行路线证据: the real walking route of one unit's check for one category, asked for by clicking the
 * unit (its code, its row, its finding card). `failed` says honestly why there is no route to draw.
 */
export type Evidence = { code: string; cat: HardCategory } & (
  { status: 'loading' } | { status: 'done'; route: RouteEvidence } | { status: 'failed'; message: string }
);

import { outOfChina, type LngLat, type RuleSet } from '@zoudedao/core';

import { EngineError } from './errors.js';
import type { EngineInput, Profile } from './types.js';

export interface Job {
  center: LngLat;
  label: string | undefined;
  profile: Profile;
  rules: RuleSet;
}

const MAX_LABEL = 80;

/** Checks the input the way the server's JSON schema does, so CLI and MCP callers get the same errors. */
export function validateInput(input: EngineInput): Job {
  const c: unknown = input?.center_bd09;
  const ok =
    Array.isArray(c) &&
    c.length === 2 &&
    c.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    !outOfChina(c[0] as number, c[1] as number);
  if (!ok) throw new EngineError('invalid_input', 'center_bd09 须为中国境内的 BD-09 坐标 [经度, 纬度]');
  const profile = input.profile ?? 'adult';
  if (profile !== 'adult' && profile !== 'elder') {
    throw new EngineError('invalid_input', 'profile 只能是 adult（成人）或 elder（老年人）');
  }
  const rules = input.rules ?? 'task';
  if (rules !== 'task' && rules !== 'gb50180') {
    throw new EngineError('invalid_input', 'rules 只能是 task（赛题口径）或 gb50180（国标口径）');
  }
  if (input.label !== undefined && typeof input.label !== 'string') {
    throw new EngineError('invalid_input', 'label 须为文本');
  }
  const label = input.label?.trim().slice(0, MAX_LABEL) || undefined;
  const [lng, lat] = c as [number, number];
  return { center: [lng, lat], label, profile, rules };
}

import { describe, expect, it } from 'vitest';
import { unitNo } from './unitNo';

describe('unitNo', () => {
  it('drops the area letter and the leading zero', () => {
    expect(unitNo('B-04')).toBe('4');
    expect(unitNo('A-10')).toBe('10');
    expect(unitNo('A-30')).toBe('30');
  });
  it('leaves anything else alone', () => {
    expect(unitNo('樟盛苑')).toBe('樟盛苑');
  });
});

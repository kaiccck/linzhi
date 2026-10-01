import { describe, expect, it } from 'vitest';

import { healthKey, laneKey, phaseNumerals, roadNumber, schoolKey, stripRegion } from './names.js';

describe('school keys (official list ↔ Baidu names)', () => {
  it('reduces region, 民办 and the campus spelling to one key', () => {
    const official = schoolKey('上海市浦东新区孙桥小学', '张江校区');
    expect(official).toEqual({ base: '孙桥小学', campus: '张江', key: '孙桥小学#张江' });
    for (const baidu of [
      '孙桥小学(张江校区)',
      '孙桥小学（张江校区）',
      '浦东新区孙桥小学张江校区',
      '上海市浦东新区孙桥小学 (张江校区)',
    ]) {
      expect(schoolKey(baidu).key, baidu).toBe(official.key);
    }
    expect(schoolKey('孙桥小学(申江校区)').key).not.toBe(official.key);
    expect(schoolKey('上海市浦东新区孙桥小学')).toMatchObject({ base: '孙桥小学', campus: null });
    expect(schoolKey('上海浦东新区民办筑桥实验小学').key).toBe(schoolKey('筑桥实验小学').key);
    expect(schoolKey('上海市浦东新区第二中心小学', '张江校区').key).toBe(
      schoolKey('浦东新区第二中心小学(张江校区)').key,
    );
  });

  it('keeps a school-name part apart from the campus: 西校, 东校, 分校 and nested brackets', () => {
    expect(schoolKey('上海市浦东新区进才实验小学西校', '大华校区')).toMatchObject({
      base: '进才实验小学西校',
      campus: '大华',
    });
    expect(schoolKey('进才实验小学西校(大华校区)').key).toBe('进才实验小学西校#大华');
    expect(schoolKey('进才实验小学西校大华校区').key).toBe('进才实验小学西校#大华');
    // a different school, not a campus of 观澜小学
    expect(schoolKey('上海市浦东新区观澜小学东校')).toMatchObject({ base: '观澜小学东校', campus: null });
    expect(schoolKey('上海市浦东新区龚路中心小学', '东校区').key).toBe(schoolKey('龚路中心小学(东校区)').key);
    expect(schoolKey('某某小学张江分校').key).toBe(schoolKey('某某小学', '张江校区').key);
    expect(schoolKey('上海浦东新区民办协和双语学校（康桥校区（过渡校区））')).toMatchObject({
      base: '协和双语学校',
      campus: '康桥',
    });
    expect(schoolKey('上海市浦东新区明珠小学', 'A区').key).toBe(schoolKey('明珠小学(A区)').key);
  });

  it('keeps names that only look like a region prefix', () => {
    expect(stripRegion('上海交通大学附属浦东实验小学')).toBe('交通大学附属浦东实验小学');
    expect(schoolKey('上海中医药大学附属浦东实验小学').base).toBe('中医药大学附属浦东实验小学');
  });
});

describe('health centre keys and addresses', () => {
  it('matches 卫健委 names to Baidu names', () => {
    expect(healthKey('浦东新区张江社区卫生服务中心')).toBe('张江社区卫生服务中心');
    expect(healthKey('上海市浦东新区张江社区卫生服务中心(益江路)')).toBe('张江社区卫生服务中心');
    expect(healthKey('张江社区卫生服务中心')).toBe('张江社区卫生服务中心');
  });

  it('reads road and number whether the site is a 号 or a 弄, even from garbled addresses', () => {
    expect(roadNumber('紫薇路686号')).toBe('紫薇路686');
    expect(roadNumber('上海市浦东新区紫薇路686弄')).toBe('紫薇路686');
    expect(roadNumber('上海市浦东新区张江镇张江路1615号(张江路地铁站1号口步行350米)')).toBe('张江路1615');
    expect(roadNumber('上海市浦东新区益江路店浦东新张江镇区益江路458号')).toBe('益江路458');
    expect(roadNumber('龙东大道666弄')).toBe('龙东大道666');
    expect(roadNumber('川北公路3089号')).toBe('川北公路3089');
    expect(roadNumber('高斯路与紫薇路交叉口北40米')).toBeNull();
    expect(roadNumber(undefined)).toBeNull();
  });

  it('reads lane keys from names and addresses', () => {
    expect(laneKey('顺和路60弄')).toBe('顺和路60弄');
    expect(laneKey('益江路286弄小区')).toBe('益江路286弄');
    expect(laneKey('益丰路55弄109号')).toBe('益丰路55弄');
    expect(laneKey('川和路322弄9号-11号')).toBe('川和路322弄');
    expect(laneKey('横沔江路256弄1－3号')).toBe('横沔江路256弄');
    expect(laneKey('张江路689号')).toBe('张江路689号');
    expect(laneKey('上海市浦东新区张江镇孙环路177弄')).toBe('孙环路177弄');
    expect(laneKey('韩荡村')).toBeNull();
    expect(laneKey('申城佳苑一期A块')).toBeNull();
  });
});

describe('phase numerals', () => {
  it('spells Roman, full-width, Arabic and Chinese phase numbers one way', () => {
    for (const name of [
      '万科翡翠公园-I期',
      '万科翡翠公园-Ⅰ期',
      '万科翡翠公园－Ｉ期',
      '万科翡翠公园-1期',
      '万科翡翠公园一期',
      '万科翡翠公园第一期',
      '万科翡翠公园 01期',
    ]) {
      expect(phaseNumerals(name), name).toBe('万科翡翠公园1期');
    }
    expect(phaseNumerals('万科翡翠公园-VI期')).toBe('万科翡翠公园6期');
    expect(phaseNumerals('万科翡翠公园-六期')).toBe('万科翡翠公园6期');
    expect(phaseNumerals('万科翡翠公园-iv期')).toBe('万科翡翠公园4期');
    expect(phaseNumerals('某某苑十二期')).toBe('某某苑12期');
    expect(phaseNumerals('某某苑二十期')).toBe('某某苑20期');
    expect(phaseNumerals('玉兰香苑一期A组')).toBe('玉兰香苑1期A组');
    expect(phaseNumerals('玉兰香苑二期C块')).toBe('玉兰香苑2期C块');
    expect(phaseNumerals('某某新村三区')).toBe('某某新村3区');
    expect(phaseNumerals('某某新村第2组')).toBe('某某新村2组');
  });

  it('leaves names without a phase number alone', () => {
    for (const name of [
      '川杨新苑-南区',
      '张江玉兰香苑-B块',
      '2049翡翠公园南区',
      '益江路286弄小区',
      '浦东新区',
      'M TOWN',
    ]) {
      expect(phaseNumerals(name), name).toBe(name);
    }
    // a letter block is no Roman numeral, and a number's tail is not a number of its own
    expect(phaseNumerals('某某苑C区')).toBe('某某苑C区');
    expect(phaseNumerals('某某苑DIV区')).toBe('某某苑DIV区');
    expect(phaseNumerals('某某苑2049期')).toBe('某某苑2049期');
  });
});

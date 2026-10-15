/**
 * What a community is called on screen: its number alone (B-04 → 4). The code keeps its area
 * letter as an id (links, the 问 AI anchors), but one area is on screen at a time, where the
 * letter only puzzles; prose names the community instead.
 */
export const unitNo = (code: string): string => code.replace(/^[^-]*-0*(?=\d)/, '');

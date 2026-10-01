import { Fragment } from 'react';
import { NUMBER_RE } from '../advisor/answer.js';

const NUMBER = new RegExp(`(${NUMBER_RE})`);

/** Text with every number (and its unit) in the numeral face: notes and cards, where no plates belong. */
export function NumText({ text }: { text: string }) {
  const parts = text.split(NUMBER);
  return (
    <>
      {parts.map((p, k) =>
        k % 2 ? (
          <span key={k} className="num n">
            {p}
          </span>
        ) : (
          <Fragment key={k}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * While the first analysis loads, the panel holds its own shapes in their final places: the place, the
 * verdict's numeral and its two bars, the five category tiles and the list's rows. The answer then
 * fills them in instead of pushing the page about. The real classes keep the sizes (the same line
 * heights, the 54px tiles, the 38px rows); `.sk` is the quiet stand-in for each word.
 */
import { Fragment, type CSSProperties } from 'react';

/** stand-in widths, em: a few row names of different lengths read as a list, not as stripes */
const ROWS = [7.5, 6, 8.5, 5.5, 7, 6.5];

const sk = (width: string) => <i className="sk" style={{ width }} />;

export function PanelSkeleton() {
  return (
    <div className="skel" aria-hidden="true">
      <section className="place">
        <div className="place-row">
          <h1>{sk('8.5em')}</h1>
        </div>
        <p className="place-meta">{sk('17em')}</p>
      </section>
      <section className="checkup">
        <section className="verdict">
          <div className="v-top">
            <b className="v-n">
              <i className="sk sk-n" />
            </b>
            <p className="v-lines">
              <span className="v-t1">{sk('7em')}</span>
              <span className="v-t2">{sk('13em')}</span>
            </p>
          </div>
          <div className="v-compare">
            {['2.2em', '2.8em'].map((w) => (
              <Fragment key={w}>
                <span className="vc-k">{sk(w)}</span>
                <span className="vc-track" />
                <span className="vc-n">{sk('1em')}</span>
              </Fragment>
            ))}
          </div>
          <p className="v-key">{sk('19em')}</p>
        </section>
        <div className="cats" style={{ '--n': 5 } as CSSProperties}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="cat sk-tile">
              {sk('62%')}
              {sk('84%')}
            </span>
          ))}
        </div>
        <div className="gl">
          {ROWS.map((w, i) => (
            <div key={i} className="gl-row sk-row">
              <i className="sk sk-code" />
              <span className="nm">{sk(`${w}em`)}</span>
              <i className="sk sk-v" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

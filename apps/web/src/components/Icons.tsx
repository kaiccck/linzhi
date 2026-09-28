import type { IconId } from '../model/derive.js';

/** Pictogram sprite: white-on-black signage glyphs, one symbol per id (from the mockup). */
export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <symbol id="pg-walk" viewBox="0 0 24 24">
          <circle cx="13.4" cy="3.6" r="2.3" />
          <path d="M11.2 7.1l3.4.4 2.1 3.6 2.7 1.1-.7 1.7-3.4-1.4-1.1-1.8-.9 3.8 2.8 3.1V23h-2v-5l-3-3.1-1.2 4.7-3.5 3.8-1.5-1.4 3.1-3.4 1.8-8.1-1.7.9v2.8H6.2V9.9z" />
        </symbol>
        <symbol id="pg-school" viewBox="0 0 24 24">
          <path d="M12 2.5l9.5 6.3V10h-19V8.8z" />
          <path d="M4 11h16v10h-5.4v-5.2H9.4V21H4z" />
        </symbol>
        <symbol id="pg-market" viewBox="0 0 24 24">
          <path d="M2.5 10h19l-2.3 11H4.8z" />
          <path d="M8.2 3.2c2.3.3 3.6 2.4 3.4 5.6-2.3-.3-3.6-2.4-3.4-5.6zM15.8 3.2c.2 3.2-1.1 5.3-3.4 5.6-.2-3.2 1.1-5.3 3.4-5.6z" />
        </symbol>
        <symbol id="pg-pharmacy" viewBox="0 0 24 24">
          <path
            d="M9.2 4.3a5 5 0 0 1 7.1 0l3.4 3.4a5 5 0 0 1 0 7.1l-4.9 4.9a5 5 0 0 1-7.1 0l-3.4-3.4a5 5 0 0 1 0-7.1zm-2.8 5.6a3 3 0 0 0 0 4.2l1.7 1.7 4.2-4.2-4.2-4.2z"
            fillRule="evenodd"
          />
        </symbol>
        <symbol id="pg-metro" viewBox="0 0 24 24">
          <path
            d="M7 2.5h10a3.5 3.5 0 0 1 3.5 3.5v9.5A3.5 3.5 0 0 1 17 19H7a3.5 3.5 0 0 1-3.5-3.5V6A3.5 3.5 0 0 1 7 2.5zm-.5 3.5v5h11V6zM8 14.2a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zm8 0a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z"
            fillRule="evenodd"
          />
          <path d="M6.6 20h2.6l-1.3 2.5H5.3zM14.8 20h2.6l1.3 2.5h-2.6z" />
        </symbol>
        <symbol id="pg-kinder" viewBox="0 0 24 24">
          <path d="M3 13.5h8V21H3zM13 13.5h8V21h-8zM8 4.5h8V12H8z" />
        </symbol>
        <symbol id="pg-clinic" viewBox="0 0 24 24">
          <path
            d="M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19zm-1.8 4.7v3h-3v3.6h3v3h3.6v-3h3v-3.6h-3v-3z"
            fillRule="evenodd"
          />
        </symbol>
        <symbol id="pg-play" viewBox="0 0 24 24">
          <path d="M7 3.8l13.5 8.2L7 20.2z" />
        </symbol>
        <symbol id="pg-search" viewBox="0 0 24 24">
          <path
            d="M10.2 2.5a7.7 7.7 0 0 1 6.2 12.3l5.1 5.1-1.8 1.8-5.1-5.1A7.7 7.7 0 1 1 10.2 2.5zm0 2.6a5.1 5.1 0 1 0 0 10.2 5.1 5.1 0 0 0 0-10.2z"
            fillRule="evenodd"
          />
        </symbol>
        <symbol id="pg-north" viewBox="0 0 24 24">
          <path d="M12 2l6.5 18L12 16.4 5.5 20z" />
        </symbol>
        {/* 问询处: the information "i" of public signage, heavy like the rest of the set */}
        <symbol id="pg-info" viewBox="0 0 24 24">
          <circle cx="12" cy="4.7" r="2.5" />
          <path d="M8.2 9h5.7v10.2h2.2v2.6H7.9v-2.6h2.2v-7.6H8.2z" />
        </symbol>
        <symbol id="pg-check" viewBox="0 0 24 24">
          <path d="M9.8 18.4 4.3 12.9l2.1-2.1 3.4 3.4 8-8 2.1 2.1z" />
        </symbol>
        <symbol id="pg-download" viewBox="0 0 24 24">
          <path d="M10.4 2.5h3.2v7.9h3.7L12 16.1l-5.3-5.7h3.7z" />
          <path d="M3.6 14.8h2.6v3.9h11.6v-3.9h2.6v6.5H3.6z" />
        </symbol>
      </defs>
    </svg>
  );
}

export function Pg({ id }: { id: IconId }) {
  return (
    <svg className="pg" aria-hidden="true" focusable="false">
      <use href={`#${id}`} />
    </svg>
  );
}

import type { IconId } from '../model/derive.js';

/** UI glyphs: thin strokes in currentColor on a 24 px grid (search, menus, checkboxes, the map controls). */
export type UiId =
  | 'ui-search'
  | 'ui-chevron'
  | 'ui-check'
  | 'ui-close'
  | 'ui-locate'
  | 'ui-print'
  | 'ui-back'
  | 'ui-next'
  | 'ui-present'
  | 'ui-map-dl'
  | 'ui-layers';

/**
 * One sprite for the page: solid pictograms for places and facilities (from the mockup), and the
 * stroke UI glyphs. Facility pictograms take their category's colour from `fill`.
 */
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
        <symbol id="pg-super" viewBox="0 0 24 24">
          <path d="M1.8 3h3.8l.8 2.9h15.4l-2.5 9.4H8.9l.5 1.9h10v2.2H7.7L4 5.2H1.8z" />
          <circle cx="9.4" cy="21.2" r="1.6" />
          <circle cx="17.6" cy="21.2" r="1.6" />
        </symbol>
        <symbol id="pg-fresh" viewBox="0 0 24 24">
          <path d="M12 8.1c1.9-1.5 5.2-1.7 6.9.6 2 2.7 1.1 7.6-1.4 10.7-1.4 1.8-2.9 2.6-4.3 2l-1.2-.5-1.2.5c-1.4.6-2.9-.2-4.3-2-2.5-3.1-3.4-8-1.4-10.7 1.7-2.3 5-2.1 6.9-.6z" />
          <path d="M12.3 7c-.1-2.6 1.4-4.4 4.3-4.5.1 2.6-1.5 4.4-4.3 4.5z" />
        </symbol>
        <symbol id="pg-elder" viewBox="0 0 24 24">
          <circle cx="10.2" cy="3.8" r="2.3" />
          <path d="M8.1 7.2h3.7l1.9 4 3.4 1.6-.8 1.8-4-1.8-.9-1.7-.8 4 2.5 3v5.4h-2.2v-4.6l-2.1-2.5-1.4 7.1H5.1l2.1-10.4-1.3 1.1-.5 3.3-2.1-.3.7-4.5z" />
          <path d="M17.5 13.2h1.9v9.8h-1.9z" />
        </symbol>
        <symbol id="pg-bus" viewBox="0 0 24 24">
          <path
            d="M6.3 2.5h11.4a2.8 2.8 0 0 1 2.8 2.8v12.4a1.3 1.3 0 0 1-1.3 1.3H4.8a1.3 1.3 0 0 1-1.3-1.3V5.3a2.8 2.8 0 0 1 2.8-2.8zM6 6v5.8h12V6zm1.8 8.3a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm8.4 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"
            fillRule="evenodd"
          />
          <path d="M5.4 19.9h3.4v2.6H5.4zM15.2 19.9h3.4v2.6h-3.4z" />
        </symbol>
        <symbol id="pg-park" viewBox="0 0 24 24">
          <circle cx="12" cy="8.8" r="6.3" />
          <path d="M10.8 13.5h2.4v6.4h-2.4z" />
          <path d="M5.5 19.6h13v2H5.5z" />
        </symbol>
        <symbol id="pg-play" viewBox="0 0 24 24">
          <path d="M7.5 4.6c0-.9 1-1.5 1.8-1l11 7.1c.7.5.7 1.5 0 2l-11 7.1c-.8.5-1.8 0-1.8-1z" />
        </symbol>
        {/* 问询: the information "i" */}
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
        <symbol id="pg-print" viewBox="0 0 24 24">
          <path d="M6.5 2.5h11v5h-11z" />
          <path
            d="M3.8 8.6h16.4a1.8 1.8 0 0 1 1.8 1.8v6.8h-3.6v-3.4H5.6v3.4H2V10.4a1.8 1.8 0 0 1 1.8-1.8zm13.4 1.8a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2z"
            fillRule="evenodd"
          />
          <path d="M7.4 15.3h9.2v6.2H7.4z" />
        </symbol>
        <symbol id="pg-pin" viewBox="0 0 24 24">
          <path
            d="M12 1.8a7.8 7.8 0 0 1 7.8 7.8c0 5.4-7.8 12.6-7.8 12.6S4.2 15 4.2 9.6A7.8 7.8 0 0 1 12 1.8zm-1.1 3.9v2.8H8.1v2.2h2.8v2.8h2.2v-2.8h2.8V8.5h-2.8V5.7z"
            fillRule="evenodd"
          />
        </symbol>
        <symbol id="pg-plus" viewBox="0 0 24 24">
          <path d="M10.4 3.5h3.2v6.9h6.9v3.2h-6.9v6.9h-3.2v-6.9H3.5v-3.2h6.9z" />
        </symbol>

        <symbol id="ui-search" viewBox="0 0 24 24">
          <circle cx="10.5" cy="10.5" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M15.2 15.2l5 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </symbol>
        <symbol id="ui-chevron" viewBox="0 0 24 24">
          <path
            d="M7 10l5 5 5-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </symbol>
        <symbol id="ui-check" viewBox="0 0 16 16">
          <path
            d="M3.8 8.3l2.7 2.7 5.7-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </symbol>
        <symbol id="ui-close" viewBox="0 0 24 24">
          <path
            d="M7 7l10 10M17 7 7 17"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </symbol>
        <symbol id="ui-locate" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="12" cy="12" r="2.2" fill="currentColor" />
          <path
            d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </symbol>
        <symbol id="ui-print" viewBox="0 0 24 24">
          <path
            d="M7 8V3.5h10V8M7 17H4.5A1.5 1.5 0 0 1 3 15.5v-6A1.5 1.5 0 0 1 4.5 8h15A1.5 1.5 0 0 1 21 9.5v6a1.5 1.5 0 0 1-1.5 1.5H17M7 13.5h10v7H7z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </symbol>
        <symbol id="ui-back" viewBox="0 0 24 24">
          <path
            d="M14.5 6.5 9 12l5.5 5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </symbol>
        <symbol id="ui-next" viewBox="0 0 24 24">
          <path
            d="M9.5 6.5 15 12l-5.5 5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </symbol>
        <symbol id="ui-present" viewBox="0 0 24 24">
          <path
            d="M4.5 4.5h15a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 14V6a1.5 1.5 0 0 1 1.5-1.5zM12 15.5v4M8.5 19.5h7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M10.4 7.6v4.8l4-2.4z" fill="currentColor" />
        </symbol>
        <symbol id="ui-layers" viewBox="0 0 24 24">
          <path
            d="M12 3.5 20.5 8 12 12.5 3.5 8zM3.5 12 12 16.5 20.5 12M3.5 16 12 20.5 20.5 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </symbol>
        <symbol id="ui-map-dl" viewBox="0 0 24 24">
          <path
            d="M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-5M9 4.5v13M15 6.5v2M18 3.5v7m-2.6-2.6L18 10.5l2.6-2.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </symbol>
      </defs>
    </svg>
  );
}

/** A solid pictogram; `color` fills it (a facility's category hue), otherwise currentColor. */
export function Pg({ id, color }: { id: IconId; color?: string }) {
  return (
    <svg className="pg" aria-hidden="true" focusable="false" style={color ? { fill: color } : undefined}>
      <use href={`#${id}`} />
    </svg>
  );
}

/** A stroke UI glyph. */
export function Ui({ id }: { id: UiId }) {
  return (
    <svg className="ui" aria-hidden="true" focusable="false">
      <use href={`#${id}`} />
    </svg>
  );
}

/// <reference types="@tarojs/taro" />

declare module '*.png';
declare module '*.svg';

/** API origin baked in at build time (config/index.ts). */
declare const ZDD_API_BASE: string;

declare namespace NodeJS {
  interface ProcessEnv {
    TARO_ENV: 'weapp' | 'h5';
  }
}

/** Vite-only imports in shared web modules (replaced in the build, see config/index.ts). */
declare module '*?url' {
  const url: string;
  export default url;
}
declare module '*?raw' {
  const text: string;
  export default text;
}
declare module '*.css';
interface ImportMeta {
  readonly env: { readonly DEV: boolean; readonly [key: string]: string | boolean | undefined };
}

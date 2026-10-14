import path from 'node:path';
import { defineConfig, type UserConfigExport } from '@tarojs/cli';
import webpack from 'webpack';

const root = path.resolve(__dirname, '..', '..', '..');
/** Shared code compiled from source: the core algorithms and the web app's platform-free model. */
const shared = {
  core: path.join(root, 'packages/core/src'),
  web: path.join(root, 'apps/web/src'),
};

/**
 * Where the mini program reaches the API. In the simulator (with 「不校验合法域名」) the local server
 * works; a phone needs an HTTPS domain on the 合法域名 list (ZDD_API_BASE=https://…).
 */
const apiBase = process.env.ZDD_API_BASE || 'http://localhost:8787';

export default defineConfig<'webpack5'>(async (merge) => {
  const base: UserConfigExport<'webpack5'> = {
    projectName: 'zoudedao-miniapp',
    date: '2026-10-09',
    // sizes are points, as in a native map app: px stays px (pxtransform off below), so a 15 px
    // label is 15 pt on every phone instead of growing with the screen's width
    designWidth: 375,
    deviceRatio: { 640: 2.34 / 2, 750: 1, 375: 2, 828: 1.81 / 2 },
    sourceRoot: 'src',
    outputRoot: 'dist',
    plugins: [],
    defineConstants: { ZDD_API_BASE: JSON.stringify(apiBase) },
    alias: {
      '@web': shared.web,
    },
    // map marker images are read by path at run time (<map> markers), not imported
    copy: { patterns: [{ from: 'src/assets/markers/', to: 'dist/assets/markers/' }], options: {} },
    framework: 'react',
    compiler: { type: 'webpack5', prebundle: { enable: false } },
    cache: { enable: false },
    mini: {
      compile: { include: [shared.core, shared.web] },
      postcss: {
        pxtransform: { enable: false, config: {} },
        cssModules: {
          enable: false,
          config: { namingPattern: 'module', generateScopedName: '[name]__[local]___[hash:base64:5]' },
        },
      },
      webpackChain(chain) {
        const web = path.resolve(__dirname, '../src/platform/web.ts');
        // the browser globals the web data layer uses, built on wx.request (src/platform/web.ts)
        chain.plugin('zdd-web-globals').use(webpack.ProvidePlugin, [
          {
            fetch: [web, 'fetch'],
            AbortController: [web, 'AbortController'],
            TextDecoderStream: [web, 'TextDecoderStream'],
            performance: [web, 'performance'],
          },
        ]);
        // the web app's bundled sample fallbacks (?url / ?raw) stay out of the package
        chain
          .plugin('zdd-no-bundled-samples')
          .use(webpack.NormalModuleReplacementPlugin, [
            /\.json\?(url|raw)$/,
            path.resolve(__dirname, '../src/platform/empty-asset.ts'),
          ]);
        // workspace TS imports carry .js extensions (NodeNext style)
        chain.merge({
          resolve: {
            extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
            alias: {
              '@zoudedao/core$': path.join(shared.core, 'index.ts'),
              // one React for every module: the web's components resolve 'react' from apps/web
              // (React 19) otherwise, and two copies break hooks under Taro's React 18 renderer
              react: path.dirname(require.resolve('react/package.json')),
              'react-dom': path.dirname(require.resolve('react-dom/package.json')),
            },
          },
        });
      },
    },
  };
  if (process.env.NODE_ENV === 'development') return merge({}, base, { mini: { debugReact: false } });
  return merge({}, base, {});
});

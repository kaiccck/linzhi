import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Unit tests run in Node: the workspace core and the web modules from source, @tarojs/taro replaced
// by a stand-in each test drives (test/taro-stub.ts), and the build's constants defined.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@zoudedao\/core$/, replacement: at('../../packages/core/src/index.ts') },
      { find: /^@web\/(.*)$/, replacement: at('../web/src/$1') },
      { find: /^@tarojs\/taro$/, replacement: at('test/taro-stub.ts') },
    ],
  },
  define: { ZDD_API_BASE: JSON.stringify('http://api.test') },
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'] },
});

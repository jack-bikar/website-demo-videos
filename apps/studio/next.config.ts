import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@wdv/compositions', '@wdv/schema', '@wdv/timeline', '@wdv/db', '@wdv/engine'],
  serverExternalPackages: [
    'better-sqlite3',
    '@remotion/renderer',
    '@remotion/bundler',
    'puppeteer-core',
    'steel-sdk',
  ],
};

export default nextConfig;

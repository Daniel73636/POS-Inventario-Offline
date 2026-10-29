import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@pos/contracts', '@pos/domain-pos', '@pos/sync-engine'],
  reactStrictMode: true,
};

export default nextConfig;

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@pos/contracts', '@pos/domain-pos'],
  reactStrictMode: true,
};

export default nextConfig;

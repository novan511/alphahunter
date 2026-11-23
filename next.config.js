/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Turbopack otherwise walks up to a package-lock.json in the parent folder.
  turbopack: { root: __dirname },
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,POST,OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
import nextVitals from 'eslint-config-next/core-web-vitals';

/**
 * ESLint 9 flat config — `next lint` was removed in Next.js 16.
 *
 * We keep the core-web-vitals ruleset (what the project used before the
 * upgrade) and switch off the new React Compiler-era hooks rules, which would
 * otherwise flag 69 pre-existing call sites unrelated to this work.
 */
const config = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'eval/reports/**'] },
  ...nextVitals,
  {
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
];

export default config;

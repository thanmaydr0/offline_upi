const nodeProject = {
  testEnvironment: 'node',
  globals: { __DEV__: true },
  transform: { '^.+\\.[jt]sx?$': ['babel-jest', {
    presets: [['babel-preset-expo', { enableBabelRuntime: false }]],
    caller: { name: 'babel-jest', preserveEnvVars: true },
  }] },
  moduleNameMapper: { '^@offline-pay/shared$': '<rootDir>/../shared/src/index.ts' },
};

module.exports = {
  testTimeout: 15000,
  projects: [
    { ...nodeProject, displayName: 'core', testMatch: ['<rootDir>/__tests__/core/**/*.test.ts'] },
    { ...nodeProject, displayName: 'api-sync', testMatch: ['<rootDir>/src/api/**/*.test.ts', '<rootDir>/src/sync/**/*.test.ts'] },
    { ...nodeProject, displayName: 'offline', testMatch: ['<rootDir>/src/offline/**/*.test.ts'] },
    { displayName: 'ui', preset: 'jest-expo', testMatch: ['<rootDir>/src/ui/**/*.test.tsx'],
      moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1', '^@offline-pay/shared$': '<rootDir>/../shared/src/index.ts' } },
  ],
};

module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/api/**/*.test.ts', '<rootDir>/src/sync/**/*.test.ts'],
  transform: { '^.+\\.[jt]sx?$': ['babel-jest', { presets: [['babel-preset-expo', { enableBabelRuntime: false }]], caller: { name: 'babel-jest', preserveEnvVars: true } }] },
  moduleNameMapper: { '^@offline-pay/shared$': '<rootDir>/../shared/src/index.ts' },
};

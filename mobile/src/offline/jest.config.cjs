module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  modulePaths: ['<rootDir>/node_modules'],
  testMatch: ['<rootDir>/src/offline/**/*.test.ts'],
  transform: { '^.+\\.[jt]sx?$': ['babel-jest', { presets: ['babel-preset-expo'] }] },
  moduleNameMapper: { '^@offline-pay/shared$': '<rootDir>/../shared/src/index.ts' },
};

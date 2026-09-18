import js from '@eslint/js'
import expoFlatConfig from 'eslint-config-expo/flat.js'
import prettierConfig from 'eslint-config-prettier'
import globals from 'globals'
import { config, configs } from 'typescript-eslint'

export default config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.expo/**',
      'apps/hermie/ios/**',
      'apps/hermie/android/**',
      'apps/hermie/macos/**',
      // Vendored upstream sources are linted by their own project, not by ours.
      'packages/hermes-shared/src/**'
    ]
  },
  js.configs.recommended,
  ...expoFlatConfig,
  ...configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart']
    }
  },
  {
    // @hermie/gateway-client has to run on Hermes (React Native) as well as in
    // Node, so it may never reach for a Node built-in.
    files: ['packages/gateway-client/src/**/*.ts'],
    ignores: ['packages/gateway-client/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'packages/gateway-client runs on React Native; Node built-ins are not available there.'
            }
          ]
        }
      ]
    }
  },
  {
    // Build tooling and repo scripts run in Node, not in the app runtime.
    files: [
      'scripts/**/*.mjs',
      'apps/*/scripts/**/*.mjs',
      'apps/*/plugins/**/*.js',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.config.ts',
      'packages/*/src/cli.ts'
    ],
    languageOptions: {
      globals: globals.node
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  prettierConfig
)

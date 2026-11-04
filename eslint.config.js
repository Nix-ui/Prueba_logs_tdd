import globals from 'globals';

export default [
  // Generated files and dependencies must not be linted.
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '.parcel-cache/**',
      '.tddlab/**',
      'script/report.json'
    ]
  },

  // Base configuration for every JavaScript file.
  {
    files: ['**/*.js'],

    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    },

    rules: {
      quotes: [
        'error',
        'single',
        {
          avoidEscape: true,
          allowTemplateLiterals: true
        }
      ],

      semi: ['error', 'always'],
      'object-curly-spacing': ['error', 'always'],
      'array-bracket-spacing': ['error', 'never'],

      'no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'after-used',
          ignoreRestSiblings: true,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none'
        }
      ],

      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-shadow': 'error',
      'consistent-return': 'error',
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-console': 'warn',
      'no-multi-spaces': 'error',
      'no-trailing-spaces': 'error',
      'no-whitespace-before-property': 'error'
    }
  },

  // Browser source files.
  {
    files: [
      'src/**/*.js'
    ],

    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },

  // Node scripts.
  {
    files: [
      'script/**/*.js',
      'semantic-commits.js',
      'cypress.config.js'
    ],

    languageOptions: {
      globals: {
        ...globals.node,
        console: 'readonly',
        crypto: 'readonly'
      }
    },

    rules: {
      // Console output is valid for command-line scripts.
      'no-console': 'off'
    }
  },

  // Jest test files.
  {
    files: [
      '**/*.test.js',
      '**/*.spec.js',
      'script/__tests__/**/*.js'
    ],

    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
        crypto: 'readonly'
      }
    },

    rules: {
      'no-console': 'off'
    }
  },

  // Cypress tests and support files.
  {
    files: [
      'cypress/**/*.js',
      'cypress.config.js'
    ],

    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.mocha,
        cy: 'readonly',
        Cypress: 'readonly',
        assert: 'readonly',
        expect: 'readonly'
      }
    },

    rules: {
      'no-console': 'off'
    }
  }
];
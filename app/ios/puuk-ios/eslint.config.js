module.exports = [
  { ignores: ['node_modules/**', 'ios/**', 'build/**', '**/__tests__/**'] },
  {
    files: [
      'App.js',
      'components/**/*.js',
      'features/**/*.js',
      'hooks/**/*.js',
      'navigation/**/*.js',
      'shared/**/*.js',
      'utils/**/*.js',
    ],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        require: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        AbortController: 'readonly',
        FormData: 'readonly',
      },
    },
    plugins: {
      'react-hooks': require('eslint-plugin-react-hooks'),
    },
    rules: {
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-unreachable': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'no-undef': 'error',
    },
  },
];

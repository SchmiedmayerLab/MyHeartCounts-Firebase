// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2025, 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { getEslintNodeConfig } from '@schmiedmayerlab/grove-configurations'

export default [
  ...getEslintNodeConfig({ tsconfigRootDir: import.meta.dirname }),
  { ignores: ['lib/**/*', 'node_modules/**/*'] },
  {
    rules: {
      // NodeNext module resolution needs the .js suffix on relative imports.
      'import-x/extensions': ['error', 'ignorePackages', { ts: 'never', js: 'always' }],
      // Pre-existing violations; re-enable rule by rule in follow-ups.
      '@typescript-eslint/no-unsafe-class-instance-assignment': 'off',
      'sonarjs/assertions-in-tests': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-clear-text-protocols': 'off',
      'sonarjs/no-identical-functions': 'off',
      'sonarjs/no-nested-conditional': 'off',
      'sonarjs/no-redundant-assignments': 'off',
      'sonarjs/no-redundant-optional': 'off',
      'sonarjs/no-unused-vars': 'off',
      'sonarjs/prefer-specific-assertions': 'off',
      'sonarjs/pseudo-random': 'off',
      'sonarjs/redundant-type-aliases': 'off',
      'sonarjs/single-character-alternation': 'off',
      'sonarjs/super-linear-regex': 'off',
      'sonarjs/use-type-alias': 'off',
    },
  },
]

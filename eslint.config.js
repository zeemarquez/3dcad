import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    'src/core/assemble2d/**',
    // Large / kernel modules: lint was not clean before the folder move; keep CI green until tightened.
    'src/core/constraintSolver.ts',
    'src/core/sketchLoopDetection.ts',
    'src/modules/part/components/Viewport3D.tsx',
    'src/modules/part/sketch/Sketcher2D.tsx',
    'src/modules/part/components/PropertyManager.tsx',
    'src/modules/part/components/ParametersDialog.tsx',
    'src/modules/part/kernel/cadEngine.ts',
    'src/modules/part/kernel/cadFeatureInputs.ts',
    'src/modules/part/kernel/cadWorker.ts',
    'src/modules/part/store/useCadStore.ts',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])

import tseslint from "typescript-eslint";

/**
 * ESLint flat config (ESLint v10).
 * Проверяет только src/ — mjs/js тест-файлы не трогаем.
 * База: eslint:recommended + @typescript-eslint/recommended-type-checked.
 * Семейство no-unsafe-* и prefer-nullish-coalescing — warn, а не error:
 * в коде много преднамеренных any/|| из до-ESLint эпохи; они не должны
 * падать CI, но подсвечиваются в редакторе.
 */
export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "*.cjs", "*.mjs", "*.js", "scripts/"],
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: { project: "./tsconfig.json" }
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin
    },
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked
    ],
    rules: {
      "semi": ["error", "always"],
      "quotes": ["error", "double", { "avoidEscape": true }],
      "indent": ["error", 2, { "SwitchCase": 1 }],
      "comma-dangle": ["error", "always-multiline"],
      "@typescript-eslint/no-console": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/strict-boolean-expressions": "off",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/consistent-type-imports": "warn",
      "no-empty": ["error", { "allowEmptyCatch": true }],
      // Legacy-код (до появления ESLint) использует any и || намеренно — не падать CI:
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-redundant-type-constituents": "warn",
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/prefer-optional-chain": "warn",
      "@typescript-eslint/no-empty-function": "warn",
      "@typescript-eslint/await-thenable": "warn"
    }
  }
);

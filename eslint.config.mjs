import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["build/**", "src/**/*.spec.*", "src/generated/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2021,
      parser: tsParser,
      parserOptions: {
        sourceType: "module",
      },
      globals: {
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        module: "readonly",
        process: "readonly",
        require: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "max-len": ["error", { code: 120 }],
      "no-console": ["warn", { allow: ["error", "info", "warn"] }],
      "no-undef": "off",
      quotes: ["error", "double"],
      semi: ["error", "always"],
      "sort-keys": "error",
    },
  },
];

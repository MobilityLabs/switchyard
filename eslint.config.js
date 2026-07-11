import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist", "drizzle", "worker-sdk/node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.{ts,mjs}", "worker-sdk/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    ...react.configs.flat.recommended,
    files: ["ui/src/**/*.{ts,tsx}"],
  },
  {
    ...react.configs.flat["jsx-runtime"],
    files: ["ui/src/**/*.{ts,tsx}"],
  },
  {
    files: ["ui/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: globals.browser,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      "react/prop-types": "off",
      "react/no-danger": "warn",
      // Only the long-stable hook rules; the rest of the plugin's "recommended"
      // set is the newer React Compiler ruleset, out of scope here.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    rules: {
      // Not yet enforced as errors: preexisting `any` usages and non-null
      // assertions are tracked separately (see SYD-140). Kept as warnings so
      // `npm run lint` stays green while still surfacing them.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  prettier,
);

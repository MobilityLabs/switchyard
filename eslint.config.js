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
  // SYD-281. `HumanActor` is a compile-time brand — erased at runtime — so the
  // real enforcement is the adapters calling `asHuman`/`requireHuman` and
  // throwing. These two rules keep the type honest by making the ways around it
  // greppable rather than invisible.
  //
  // Neither is a security boundary. A cast ban does not stop `f(x as any)`, and
  // a caller that wrongly reaches for NO_SESSION in a supervised path fails open
  // exactly as `{}` would. What they buy is that the wrong choice is a named
  // token a reviewer can search for.
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
    ignores: [
      // asHuman/requireHuman mint the brand; there is nowhere else it can come from.
      "src/services/principal.ts",
      // The hard-gate executor re-drives as the human with deliberately empty
      // attribution, which is what makes the affirmed action NOT re-divert.
      "src/services/hard-gate.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSTypeReference > Identifier[name='HumanActor']",
          message:
            "Never cast to HumanActor — mint it with asHuman()/requireHuman() so the runtime check actually runs. A cast here is how a human-only gate becomes a no-op with no trace.",
        },
        // NOT enforced: a companion rule banning a bare `{}` where an
        // Attribution is expected. It cannot be written syntactically — ESLint
        // sees an empty ObjectExpression and cannot tell an Attribution from a
        // LeaseChannel (updateIssue's 5th argument) or an options bag
        // (claimIssue's 4th). The broad selector produced 71 hits, almost all
        // legitimate, which is the shape of a rule that gets switched off.
        //
        // NO_SESSION still exists and is used at the call sites that have no
        // session; it is just conventional rather than enforced. Honest scope:
        // the sentinel is a legibility control either way — a caller that
        // wrongly reaches for it in a supervised path fails open exactly as
        // `{}` would.
      ],
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

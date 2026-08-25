import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const noDirectNodeOpcua = [
  "error",
  {
    paths: [
      {
        name: "node-opcua",
        message: "Import node-opcua only from packages/node-opcua-adapter.",
      },
    ],
  },
];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["*.{js,mjs,ts}", "**/*.config.ts", "tests/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/client/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "node-opcua", "@ostudio/node-opcua-adapter"],
              message: "Browser code may not import server or OPC UA runtime modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "apps/server/**/*.ts",
      "packages/application/**/*.ts",
      "packages/contracts/**/*.ts",
      "packages/test-support/**/*.ts",
    ],
    languageOptions: { globals: globals.node },
    rules: { "no-restricted-imports": noDirectNodeOpcua },
  },
  {
    files: ["packages/node-opcua-adapter/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
);

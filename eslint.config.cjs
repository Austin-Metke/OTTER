const js = require("@eslint/js");
const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const globals = require("globals");

module.exports = [
  {
    ignores: [
      "dist/",
      "node_modules/",
      ".venv/",
      "venv/",
      "env/",
      "**/site-packages/**",
      "otter_py/",
      "test_data/",
      "assets/"
    ]
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "script"
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  {
    files: ["src/main.ts", "src/preload.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.commonjs
      }
    }
  },
  {
    files: ["src/renderer.ts"],
    languageOptions: {
      parserOptions: {
        sourceType: "module"
      },
      globals: {
        ...globals.browser
      }
    }
  }
];

import js from "@eslint/js";
import globals from "globals";
import hooks from "eslint-plugin-react-hooks";
import refresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["dist"] },
    {
        files: ["service-worker.js"],
        extends: [js.configs.recommended],
        languageOptions: { globals: { ...globals.serviceworker, SHELL: "readonly", __ASSETS__: "readonly" } },
    },
    {
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        files: ["**/*.{ts,tsx}"],
        languageOptions: { globals: globals.browser },
        plugins: { "react-hooks": hooks, "react-refresh": refresh },
        rules: { ...hooks.configs.recommended.rules, "react-refresh/only-export-components": "off" },
    },
);

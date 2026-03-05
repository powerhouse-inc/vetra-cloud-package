import { getConnectBaseViteConfig } from "@powerhousedao/builder-tools";
import { defineConfig, mergeConfig } from "vite";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
    const dirname = import.meta.dirname;
    const baseConnectViteConfig = getConnectBaseViteConfig({
        mode,
        dirname,
    });

    const connectPkg = resolve(dirname, "node_modules/@powerhousedao/connect");

    const additionalViteConfig = {
        resolve: {
            conditions: ["source", "browser", "module", "jsnext:main", "jsnext"],
            alias: {
                "@powerhousedao/connect/style.css": resolve(connectPkg, "lib/style.css"),
                "@powerhousedao/connect/main.js": resolve(connectPkg, "lib/src/main.js"),
            },
        },
        optimizeDeps: {
            exclude: ["@electric-sql/pglite-tools"],
        },
    };

    return mergeConfig(baseConnectViteConfig, additionalViteConfig);
});

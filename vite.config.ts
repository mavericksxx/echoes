import { writeFile } from "node:fs/promises";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

// Dev-only export endpoint for src/dev/gridPainter.ts's walkability grid
// painter (see SPEC.md Phase 4): POST the full walkability manifest here and
// it's written straight to data/walkability.json. `apply: "serve"` means
// this plugin (and its file-write access) only exists in `vite dev` — never
// registered for `vite build`.
function walkabilityExportPlugin(): Plugin {
  return {
    name: "walkability-export",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__walkability-export", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method not allowed");
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          void (async () => {
            try {
              const data = JSON.parse(body);
              const file = path.join(server.config.root, "data", "walkability.json");
              await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
              res.statusCode = 200;
              res.end("ok");
            } catch (err) {
              res.statusCode = 400;
              res.end(err instanceof Error ? err.message : String(err));
            }
          })();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [walkabilityExportPlugin()],
  build: {
    outDir: "dist",
  },
});

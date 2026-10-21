import { accessSync, constants, mkdirSync } from "node:fs";
import { createApp } from "./app";
import { bootstrapAdmin } from "./auth";
import { openDb } from "./db";
import { seedExample } from "./example";
import { pruneUploads, uploadDir } from "./uploads";

/** Stops with a clear hint (German and English) instead of an obscure SQLite or EACCES error later. */
function requireWritable(dir: string) {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch {
    console.error(`Der Ordner ${dir}/ ist nicht beschreibbar. Bei Docker einmalig: sudo chown -R 1000:1000 data`);
    console.error(`The folder ${dir}/ is not writable. With Docker, run once: sudo chown -R 1000:1000 data`);
    process.exit(1);
  }
}

requireWritable("data");
requireWritable(uploadDir());
const db = openDb("data/diko.db");
pruneUploads(db);
await bootstrapAdmin(db, process.env);
if (await seedExample(db)) console.log("Beispielveranstaltung angelegt (im Admin-Bereich unter Veranstaltungen löschbar).");
const app = createApp(db);

export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch };

import { mkdirSync } from "node:fs";
import { createApp } from "./app";
import { bootstrapAdmin } from "./auth";
import { openDb } from "./db";
import { seedExample } from "./example";
import { pruneUploads, uploadDir } from "./uploads";

mkdirSync(uploadDir(), { recursive: true });
const db = openDb("data/diko.db");
pruneUploads(db);
await bootstrapAdmin(db, process.env);
if (await seedExample(db)) console.log("Beispielveranstaltung angelegt (im Admin-Bereich unter Veranstaltungen löschbar).");
const app = createApp(db);

export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch };

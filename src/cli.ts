import { openDb } from "./db/index.js";
import { createActor } from "./services/actors.js";
import { createProject } from "./services/projects.js";
import { createLoginLink } from "./services/auth.js";

const [dbPath, cmd, ...args] = process.argv.slice(2);
if (!dbPath || !cmd) {
  console.log("usage: tsx src/cli.ts <db-path> add-actor <name> <human|agent>");
  console.log("       tsx src/cli.ts <db-path> add-project <KEY> <name...>");
  console.log("       tsx src/cli.ts <db-path> mint-login <name>");
  process.exit(1);
}
const db = openDb(dbPath);

if (cmd === "add-actor") {
  const [name, type] = args;
  if (!name || (type !== "human" && type !== "agent")) {
    console.error("add-actor needs: <name> <human|agent>");
    process.exit(1);
  }
  const { actor, token } = createActor(db, { name, type });
  console.log(`created ${actor.type} actor "${actor.name}" (id ${actor.id})`);
  console.log(`token (shown once, store it now): ${token}`);
} else if (cmd === "add-project") {
  const [key, ...nameParts] = args;
  if (!key) {
    console.error("add-project needs: <KEY> <name...>");
    process.exit(1);
  }
  const project = createProject(db, { key, name: nameParts.join(" ") || key });
  console.log(`created project ${project.key}: ${project.name}`);
} else if (cmd === "mint-login") {
  const [name] = args;
  if (!name) {
    console.error("mint-login needs: <actor name>");
    process.exit(1);
  }
  const { path } = createLoginLink(db, name);
  const base = process.env.SWITCHYARD_URL ?? "http://localhost:3300";
  console.log(`login link (valid 15 minutes, single use):`);
  console.log(base + path);
} else {
  console.error(`unknown command "${cmd}"`);
  process.exit(1);
}

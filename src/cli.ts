import { openDb } from "./db/index.js";
import { createActor } from "./services/actors.js";
import { createProject } from "./services/projects.js";
import { createLoginLink } from "./services/auth.js";
import { addWebhook, listWebhooks, removeWebhook } from "./services/webhooks.js";
import { addGithubRepo, listGithubRepos, removeGithubRepo } from "./services/github-repos.js";
import { SwitchyardError } from "./services/errors.js";

const [dbPath, cmd, ...args] = process.argv.slice(2);
if (!dbPath || !cmd) {
  console.log("usage: tsx src/cli.ts <db-path> add-actor <name> <human|agent>");
  console.log("       tsx src/cli.ts <db-path> add-project <KEY> <name...>");
  console.log("       tsx src/cli.ts <db-path> mint-login <name>");
  console.log("       tsx src/cli.ts <db-path> add-webhook <url> [PROJECT_KEY] [secret]");
  console.log("       tsx src/cli.ts <db-path> list-webhooks");
  console.log("       tsx src/cli.ts <db-path> rm-webhook <id>");
  console.log("       tsx src/cli.ts <db-path> add-github-repo <owner/repo> [PROJECT_KEY] [secret]");
  console.log("       tsx src/cli.ts <db-path> list-github-repos");
  console.log("       tsx src/cli.ts <db-path> rm-github-repo <id>");
  process.exit(1);
}
const db = openDb(dbPath);

try {
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
  } else if (cmd === "add-webhook") {
    const [url, projectKey, secret] = args;
    if (!url) {
      console.error("add-webhook needs: <url> [PROJECT_KEY] [secret]");
      process.exit(1);
    }
    const hook = addWebhook(db, { url, projectKey, secret });
    console.log(`webhook ${hook.id} -> ${hook.url}${projectKey ? ` (project ${projectKey})` : " (all projects)"}${secret ? " (signed)" : ""}`);
  } else if (cmd === "list-webhooks") {
    for (const h of listWebhooks(db)) {
      console.log(`${h.id}: ${h.url} projectId=${h.projectId ?? "all"}`);
    }
  } else if (cmd === "rm-webhook") {
    const id = args[0];
    if (!id) {
      console.error("rm-webhook needs: <id>");
      process.exit(1);
    }
    removeWebhook(db, Number(id));
    console.log("removed");
  } else if (cmd === "add-github-repo") {
    const [fullName, projectKey, secret] = args;
    if (!fullName) {
      console.error("add-github-repo needs: <owner/repo> [PROJECT_KEY] [secret]");
      process.exit(1);
    }
    const repo = addGithubRepo(db, { fullName, projectKey, secret });
    console.log(`github repo ${repo.id} -> ${repo.fullName}${projectKey ? ` (project ${projectKey})` : " (no project scope)"}${secret ? " (own secret)" : " (shares GITHUB_WEBHOOK_SECRET)"}`);
  } else if (cmd === "list-github-repos") {
    for (const r of listGithubRepos(db)) {
      console.log(`${r.id}: ${r.fullName} projectId=${r.projectId ?? "none"} secret=${r.secret ? "own" : "shared"}`);
    }
  } else if (cmd === "rm-github-repo") {
    const id = args[0];
    if (!id) {
      console.error("rm-github-repo needs: <id>");
      process.exit(1);
    }
    removeGithubRepo(db, Number(id));
    console.log("removed");
  } else {
    console.error(`unknown command "${cmd}"`);
    process.exit(1);
  }
} catch (err) {
  if (err instanceof SwitchyardError) {
    console.error("error:", err.message);
    process.exit(1);
  }
  throw err;
}

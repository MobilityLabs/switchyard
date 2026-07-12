import type { SettingsTab } from "../../router";
import { href, SETTINGS_TABS } from "../../router";
import ProjectsTab from "./ProjectsTab";
import ActorsTab from "./ActorsTab";
import IntegrationsTab from "./IntegrationsTab";
import ConfigTab from "./ConfigTab";

const TAB_LABELS: Record<SettingsTab, string> = {
  projects: "Projects",
  actors: "Bot identities",
  integrations: "Integrations",
  config: "Config",
};

/** /settings shell (SYD-158): tab nav over the four admin areas. Human-only
 * by nav gating (Shell) — the server enforces the real rule per mutation. */
export default function Settings({ tab }: { tab: SettingsTab }) {
  return (
    <main className="settings">
      <h1>Settings</h1>
      <nav className="tabs">
        {SETTINGS_TABS.map((t) => (
          <a key={t} href={href({ view: "settings", tab: t })} className={t === tab ? "active" : ""}>
            {TAB_LABELS[t]}
          </a>
        ))}
      </nav>
      {tab === "projects" && <ProjectsTab />}
      {tab === "actors" && <ActorsTab />}
      {tab === "integrations" && <IntegrationsTab />}
      {tab === "config" && <ConfigTab />}
    </main>
  );
}

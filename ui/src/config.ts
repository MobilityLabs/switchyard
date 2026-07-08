// Per-project repo base URLs used to build autolinks (commit SHAs, file paths)
// in markdown-rendered issue text. Unknown project keys fall back to plain
// <code> spans with no link.
//
// TODO: move this to a server-side per-project setting (future issue) —
// for now it's a static map maintained alongside the projects it serves.
export const PROJECT_REPOS: Record<string, string> = {
  SYD: "https://github.com/MobilityLabs/switchyard",
};

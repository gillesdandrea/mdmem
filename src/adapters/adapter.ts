/**
 * An Adapter teaches one agent to use the shared `.memory/` store: it installs the
 * protocol into that agent's native instruction location and reports whether the
 * wiring is in place. Adapters are the only agent-specific code; everything else
 * is agent-neutral.
 */

export interface AdapterContext {
  /** Repo root that holds `.memory/`. */
  projectRoot: string;
  /** Absolute path to the `.memory/` store. */
  storeDir: string;
}

export interface LinkResult {
  title: string;
  actions: string[];
}

export interface AgentStatus {
  title: string;
  linked: boolean;
  details: string[];
}

export interface Adapter {
  readonly id: string;
  readonly title: string;
  link: (ctx: AdapterContext) => Promise<LinkResult>;
  unlink: (ctx: AdapterContext) => Promise<LinkResult>;
  status: (ctx: AdapterContext) => Promise<AgentStatus>;
}

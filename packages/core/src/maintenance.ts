import type { AppRegistry, ResolvedSettings } from "./config.ts";
import type { AppScope, BanStore, MessageStore } from "./stores.ts";

export interface MaintenanceReport {
  expired: number;
  trimmed: number;
  bansExpired: number;
}

/**
 * Daily cleanup: delete messages past each app's retention, trim rooms over
 * `maxMessagesPerRoom`, and drop expired bans. Rooms vanish once their messages do.
 */
export async function runMaintenance(deps: {
  messages: MessageStore;
  bans: BanStore;
  registry: AppRegistry;
  now?: () => number;
}): Promise<MaintenanceReport> {
  const now = (deps.now ?? Date.now)();
  const report: MaintenanceReport = { expired: 0, trimmed: 0, bansExpired: 0 };

  const apply = async (scope: AppScope, settings: ResolvedSettings) => {
    if (settings.retentionMs !== null) {
      report.expired += await deps.messages.purgeOlderThan(scope, now - settings.retentionMs);
    }
    if (settings.maxMessagesPerRoom !== null) {
      report.trimmed += await deps.messages.trimRooms(scope, settings.maxMessagesPerRoom);
    }
  };

  const configured = deps.registry.configuredApps();
  for (const app of configured) await apply({ app }, deps.registry.settings(app)!);
  await apply({ excludeApps: configured }, deps.registry.defaults());

  report.bansExpired = await deps.bans.purgeExpired(now);
  return report;
}

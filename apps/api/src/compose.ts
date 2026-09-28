import type { AppContext, RouteModule } from "./http/app.js";

/**
 * Composition root. The trading, market-data, scheduler and learning services are attached
 * here, and route modules are listed in registration order. (Populated by the API build.)
 */
export async function composeServices(_ctx: AppContext): Promise<void> {
  // filled in by apps/api/src/services/* wiring
}

export const routeModules: RouteModule[] = [];

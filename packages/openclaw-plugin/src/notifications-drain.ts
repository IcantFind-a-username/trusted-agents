import { formatNotificationLines } from "trusted-agents-tapd";
import type { OpenClawTapdClient } from "./tapd-client.js";

export { formatNotificationLines };

export interface PrependContextResult {
	prependContext: string;
}

/**
 * Drains queued tapd notifications and wraps the canonical block (rendered
 * by tapd's `formatNotificationLines`) for the OpenClaw `before_prompt_build`
 * hook. Returns null when there is nothing to surface so the caller can
 * short-circuit without producing an empty block.
 */
export async function drainAndFormatNotifications(
	client: OpenClawTapdClient,
): Promise<PrependContextResult | null> {
	const result = await client.drainNotifications();
	const block = formatNotificationLines(result.notifications ?? []);
	return block === null ? null : { prependContext: block };
}

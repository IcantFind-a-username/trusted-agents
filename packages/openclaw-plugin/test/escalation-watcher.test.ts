import { afterEach, describe, expect, it } from "vitest";
import { EscalationWatcher } from "../src/escalation-watcher.js";
import { type FakeTapdHandle, startFakeTapd } from "./helpers/fake-tapd.js";

describe("EscalationWatcher", () => {
	const handles: FakeTapdHandle[] = [];
	const watchers: EscalationWatcher[] = [];

	afterEach(async () => {
		while (watchers.length > 0) {
			watchers.pop()?.stop();
		}
		while (handles.length > 0) {
			await handles.pop()?.stop();
		}
	});

	async function startSseTapd() {
		const handle = await startFakeTapd({ routes: [], enableSse: true });
		handles.push(handle);
		return handle;
	}

	function attach(watcher: EscalationWatcher) {
		watchers.push(watcher);
		return watcher;
	}

	function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
		const start = Date.now();
		return new Promise((resolve, reject) => {
			const tick = () => {
				if (predicate()) {
					resolve();
					return;
				}
				if (Date.now() - start > timeoutMs) {
					reject(new Error("timed out waiting for predicate"));
					return;
				}
				setTimeout(tick, 10);
			};
			tick();
		});
	}

	it("triggers onEscalation for action.pending events", async () => {
		const handle = await startSseTapd();
		const events: Array<{ type: string; payload: unknown }> = [];
		const watcher = attach(
			new EscalationWatcher({
				socketPath: handle.socketPath,
				onEscalation: (event) => events.push(event),
			}),
		);
		watcher.start();

		// Give the watcher a moment to connect before publishing.
		await waitFor(() => true, 50).catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 50));

		handle.publishSse({
			id: "evt-1",
			type: "action.pending",
			data: { requestId: "req-1", kind: "transfer" },
		});

		await waitFor(() => events.length > 0);

		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({
			type: "action.pending",
			payload: { requestId: "req-1", kind: "transfer" },
		});
	});

	it("triggers onEscalation for connection.requested events", async () => {
		const handle = await startSseTapd();
		const events: Array<{ type: string; payload: unknown }> = [];
		const watcher = attach(
			new EscalationWatcher({
				socketPath: handle.socketPath,
				onEscalation: (event) => events.push(event),
			}),
		);
		watcher.start();
		await new Promise((resolve) => setTimeout(resolve, 50));

		handle.publishSse({
			id: "evt-2",
			type: "connection.requested",
			data: { requestId: "req-2" },
		});

		await waitFor(() => events.length > 0);
		expect(events[0].type).toBe("connection.requested");
	});

	it("triggers onEscalation for message.received with a priority postage tier", async () => {
		const handle = await startSseTapd();
		const events: Array<{ type: string; payload: unknown }> = [];
		const watcher = attach(
			new EscalationWatcher({
				socketPath: handle.socketPath,
				onEscalation: (event) => events.push(event),
			}),
		);
		watcher.start();
		await new Promise((resolve) => setTimeout(resolve, 50));

		// A standard-paid message must NOT wake the agent...
		handle.publishSse({
			id: "evt-p1",
			type: "message.received",
			data: { text: "cheap", postage: { tier: "standard", cost: "0.001" } },
		});
		// ...but a priority-paid one bought exactly that.
		handle.publishSse({
			id: "evt-p2",
			type: "message.received",
			data: { text: "urgent", postage: { tier: "priority", cost: "0.01" } },
		});

		await waitFor(() => events.length > 0);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({
			type: "message.received",
			payload: { text: "urgent", postage: { tier: "priority", cost: "0.01" } },
		});
	});

	it("does not trigger onEscalation for unrelated event types", async () => {
		const handle = await startSseTapd();
		const events: Array<{ type: string; payload: unknown }> = [];
		const watcher = attach(
			new EscalationWatcher({
				socketPath: handle.socketPath,
				onEscalation: (event) => events.push(event),
			}),
		);
		watcher.start();
		await new Promise((resolve) => setTimeout(resolve, 50));

		handle.publishSse({ id: "evt-3", type: "message.received", data: { text: "hi" } });
		handle.publishSse({ id: "evt-4", type: "action.completed", data: {} });

		// Wait briefly to confirm nothing fires.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(events).toHaveLength(0);
	});

	it("stops cleanly without firing more callbacks", async () => {
		const handle = await startSseTapd();
		const events: Array<{ type: string; payload: unknown }> = [];
		const watcher = attach(
			new EscalationWatcher({
				socketPath: handle.socketPath,
				onEscalation: (event) => events.push(event),
			}),
		);
		watcher.start();
		await new Promise((resolve) => setTimeout(resolve, 50));

		watcher.stop();
		// Remove from cleanup list since we already stopped it.
		watchers.pop();

		// Wait for any in-flight close to settle, then publish — should be ignored.
		await new Promise((resolve) => setTimeout(resolve, 50));
		handle.publishSse({ id: "evt-5", type: "action.pending", data: {} });
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(events).toHaveLength(0);
	});
});

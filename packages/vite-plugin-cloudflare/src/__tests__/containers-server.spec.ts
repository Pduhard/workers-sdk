import fs from "node:fs";
import path from "node:path";
import {
	cleanupContainers,
	prepareContainerImagesForDev,
} from "@cloudflare/containers-shared";
import { runInTempDir } from "@cloudflare/workers-utils/test-helpers";
import { createBuilder, createServer, preview } from "vite";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { cloudflare } from "../index";

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	const { fileURLToPath } = await import("node:url");
	const sourceWorkers = fileURLToPath(new URL("../workers/", import.meta.url));
	const builtWorkers = fileURLToPath(
		new URL("../../dist/workers/", import.meta.url)
	);
	return {
		...original,
		// Source imports resolve bundled Workers under src; read their real build
		// outputs from dist so dev exercises the same Workers as the published plugin.
		readFileSync(
			file: Parameters<typeof original.readFileSync>[0],
			options: Parameters<typeof original.readFileSync>[1]
		) {
			if (
				typeof file === "string" &&
				file.startsWith(sourceWorkers) &&
				file.endsWith(".js")
			) {
				file = builtWorkers + file.slice(sourceWorkers.length);
			}
			return original.readFileSync(file, options);
		},
	};
});

vi.mock("@cloudflare/containers-shared", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@cloudflare/containers-shared")>();
	return {
		...original,
		prepareContainerImagesForDev: vi.fn(async () => ({ aborted: false })),
		cleanupContainers: vi.fn(),
	};
});

describe.each(["dev", "preview"] as const)(
	"Container preparation in Vite %s",
	(mode) => {
		runInTempDir();

		beforeEach(async () => {
			// Vite rejects Windows 8.3 paths such as RUNNER~1. Unlike the
			// synchronous helper, fs.promises.realpath expands these short names.
			const root = await fs.promises.realpath(process.cwd());
			process.chdir(root);
			vi.stubEnv("PWD", root);
			vi.stubEnv("WRANGLER_DOCKER_HOST", "unix:///test/docker.sock");
			vi.stubEnv("CLOUDFLARE_API_TOKEN", undefined);
			vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", undefined);
			vi.mocked(prepareContainerImagesForDev).mockClear();
			vi.mocked(cleanupContainers).mockReset().mockReturnValue(true);
		});

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		if (mode === "dev") {
			test("retries failed cleanup across restarts without duplicating exit listeners", async ({
				expect,
				onTestFinished,
			}) => {
				fs.writeFileSync(
					"index.js",
					`
					import { DurableObject } from "cloudflare:workers";
					export class Probe extends DurableObject {}
					export default { fetch() { return new Response("ready"); } };
				`
				);
				fs.writeFileSync("Dockerfile", "FROM alpine:3.19\n");
				fs.writeFileSync("package.json", JSON.stringify({ type: "module" }));
				fs.writeFileSync(
					"wrangler.jsonc",
					JSON.stringify({
						name: "container-restart-test",
						main: "index.js",
						compatibility_date: "2026-09-21",
						containers: [
							{
								class_name: "Probe",
								scheduling_policy: "durable_object",
								images: { app: { dockerfile: "./Dockerfile" } },
							},
						],
						durable_objects: {
							bindings: [{ name: "PROBE", class_name: "Probe" }],
						},
						migrations: [{ tag: "v1", new_sqlite_classes: ["Probe"] }],
					})
				);
				const initialExitListeners = new Set(process.listeners("exit"));
				const server = await createServer({
					configFile: false,
					logLevel: "silent",
					server: { port: 0 },
					plugins: [
						cloudflare({
							inspectorPort: false,
							persistState: false,
							remoteBindings: false,
						}),
					],
				});
				onTestFinished(() => server.close());
				const containerExitListeners = () =>
					process
						.listeners("exit")
						.filter(
							(listener) =>
								!initialExitListeners.has(listener) &&
								listener.name === "cleanupContainerImages"
						);
				const pendingTags = () =>
					new Set(
						vi
							.mocked(prepareContainerImagesForDev)
							.mock.calls.flatMap(([args]) =>
								args.containerOptions.map(({ image_tag }) => image_tag)
							)
					);
				const exitListener = containerExitListeners()[0];
				expect(exitListener).toBeDefined();
				await server.listen();
				for (let restart = 0; restart < 2; restart++) {
					const tagsBeforeRestart = pendingTags();
					vi.mocked(cleanupContainers).mockReturnValueOnce(false);
					await server.restart();
					expect(cleanupContainers).toHaveBeenLastCalledWith(
						expect.any(String),
						tagsBeforeRestart
					);
					expect(prepareContainerImagesForDev).toHaveBeenCalledTimes(
						restart + 2
					);
					expect(pendingTags().size).toBe(restart + 2);
					expect(containerExitListeners()).toEqual([exitListener]);
				}
				const allTags = pendingTags();
				await server.restart();
				expect(cleanupContainers).toHaveBeenLastCalledWith(
					expect.any(String),
					allTags
				);
				expect(containerExitListeners()).toEqual([exitListener]);
				const latestImages = vi
					.mocked(prepareContainerImagesForDev)
					.mock.calls.at(-1)?.[0].containerOptions;
				exitListener?.(0);
				expect(cleanupContainers).toHaveBeenLastCalledWith(
					expect.any(String),
					new Set(latestImages?.map(({ image_tag }) => image_tag))
				);
				expect(containerExitListeners()).toHaveLength(0);
				await server.close();
				expect(cleanupContainers).toHaveBeenCalledTimes(4);
			});
		}

		test.for(["image-free", "configured", "disabled", "absent"] as const)(
			"prepares only enabled Containers: %s",
			async (scenario, { expect, onTestFinished }) => {
				fs.writeFileSync(
					"index.js",
					`
				import { DurableObject } from "cloudflare:workers";
				export class Probe extends DurableObject {}
				export default { fetch() { return new Response("ready"); } };
			`
				);
				fs.writeFileSync("Dockerfile", "FROM alpine:3.19\n");
				fs.writeFileSync("package.json", JSON.stringify({ type: "module" }));
				fs.writeFileSync(
					"wrangler.jsonc",
					JSON.stringify({
						name: "container-test",
						main: "index.js",
						compatibility_date: "2026-09-21",
						dev: { enable_containers: scenario !== "disabled" },
						containers:
							scenario === "absent"
								? []
								: [
										{
											class_name: "Probe",
											scheduling_policy: "durable_object",
											...(scenario === "configured"
												? {
														images: {
															app: { dockerfile: "./Dockerfile" },
														},
													}
												: {}),
										},
									],
						durable_objects: {
							bindings: [{ name: "PROBE", class_name: "Probe" }],
						},
						migrations: [{ tag: "v1", new_sqlite_classes: ["Probe"] }],
					})
				);
				function config() {
					return {
						root: process.cwd(),
						configFile: false as const,
						logLevel: "silent" as const,
						server: { port: 0 },
						preview: { port: 0 },
						plugins: [
							cloudflare({
								configPath: path.resolve("wrangler.jsonc"),
								inspectorPort: false,
								persistState: false,
								remoteBindings: false,
							}),
						],
					};
				}
				async function startServer() {
					if (mode === "preview") {
						const builder = await createBuilder(config());
						await builder.buildApp();
					}
					const server = await (mode === "dev"
						? createServer(config())
						: preview(config()));
					onTestFinished(() => server.close());
					return server;
				}
				const initialExitListeners = new Set(process.listeners("exit"));
				const server = await startServer();
				const containerExitListeners = () =>
					process
						.listeners("exit")
						.filter(
							(listener) =>
								!initialExitListeners.has(listener) &&
								listener.name === "cleanupContainerImages"
						);

				if (scenario === "disabled" || scenario === "absent") {
					expect(prepareContainerImagesForDev).not.toHaveBeenCalled();
				} else {
					expect(prepareContainerImagesForDev).toHaveBeenCalledTimes(1);
					const options = vi.mocked(prepareContainerImagesForDev).mock
						.calls[0]?.[0].containerOptions;
					expect(options).toHaveLength(scenario === "configured" ? 1 : 0);
				}

				if (scenario !== "configured") {
					expect(containerExitListeners()).toHaveLength(0);
					await server.close();
					expect(cleanupContainers).not.toHaveBeenCalled();
					return;
				}

				// Two servers must retain independent cleanup callbacks. Closing one
				// must not remove the other's process-exit fallback.
				expect(containerExitListeners()).toHaveLength(1);
				const firstExitListener = containerExitListeners()[0];
				const secondServer = await startServer();
				expect(containerExitListeners()).toHaveLength(2);
				const plannedImages = vi
					.mocked(prepareContainerImagesForDev)
					.mock.calls.map(
						([args]) =>
							new Set(args.containerOptions.map(({ image_tag }) => image_tag))
					);
				vi.mocked(cleanupContainers).mockReturnValueOnce(false);
				await server.close();
				expect(cleanupContainers).toHaveBeenCalledExactlyOnceWith(
					expect.any(String),
					plannedImages[0]
				);
				// Failed graceful cleanup must leave the exit fallback and tags intact.
				expect(containerExitListeners()).toHaveLength(2);
				expect(containerExitListeners()).toContain(firstExitListener);
				firstExitListener?.(0);
				expect(cleanupContainers).toHaveBeenNthCalledWith(
					2,
					expect.any(String),
					plannedImages[0]
				);
				expect(containerExitListeners()).toHaveLength(1);
				expect(containerExitListeners()).not.toContain(firstExitListener);

				// Exercise only this server's listener, without emitting process.exit.
				const secondExitListener = containerExitListeners()[0];
				expect(secondExitListener).toBeDefined();
				secondExitListener?.(0);
				expect(cleanupContainers).toHaveBeenNthCalledWith(
					3,
					expect.any(String),
					plannedImages[1]
				);
				await secondServer.close();
				expect(cleanupContainers).toHaveBeenCalledTimes(3);
				expect(containerExitListeners()).toHaveLength(0);
			}
		);
	}
);

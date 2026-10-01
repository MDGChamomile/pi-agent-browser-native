import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import parser, { type Token } from "stream-json/parser.js";
import ignore from "stream-json/filters/ignore.js";
import stringer from "stream-json/stringer.js";
import disassembler from "stream-json/disassembler.js";

import { extractUpstreamCommandTokens } from "./argv-descriptor.js";
import { getAgentBrowserSessionIdentityKey, isAgentBrowserSessionIdentityKeyInNamespace } from "./argv-grammar.js";
import { batchHasSuccessfulCloseAll, getSuccessfulBatchCloseLifecycle } from "./batch-lifecycle.js";
import { BROWSER_RESULT_TOOLS, BROWSER_STATE_FIELDS, BROWSER_TRANSITION_ENTRY, applyArtifactChanges, artifactChanges, browserStateEffects, getBrowserRecord, snapshotDefinition, type BrowserPageChange, type BrowserRecord, type BrowserSnapshot } from "./browser-transcript.js";
import { projectJson, readRange, scanJournalMetadata, type JournalRange } from "./browser-journal.js";
import { isCloseAllCommand, isCloseCommand, isReadOnlyDiagnosticSessionTargetCommand } from "./command-taxonomy.js";
import { isRecord } from "./parsing.js";
import { isSessionArtifactManifest } from "./results/artifact-manifest.js";
import type { SessionArtifactManifest } from "./results/contracts.js";
import { buildNoActivePageRefSnapshotInvalidation, extractSessionTabTargetFromBatchResults, isNoActivePageSnapshotFailure, normalizeSessionTabTarget, type SessionRefSnapshot, type SessionRefSnapshotInvalidation, type SessionTabTarget } from "./session-page-state.js";

interface LegacyPage {
	target?: SessionTabTarget;
	unknown?: true;
	reopenPending?: boolean;
	snapshot?: { id: string; digest: string; usable: boolean; candidate: boolean };
	pending?: { operationId: string; toolCallId: string; index: number };
}
interface LegacyProjection { pages: Map<string, LegacyPage>; manifest?: SessionArtifactManifest; nextIndex: number }
const emptyProjection = (): LegacyProjection => ({ pages: new Map(), nextIndex: 0 });

function legacyTarget(value: Record<string, unknown>): SessionTabTarget | undefined {
	return normalizeSessionTabTarget({
		url: typeof value.url === "string" ? value.url : undefined,
		title: typeof value.title === "string" ? value.title : undefined,
		targetId: typeof value.targetId === "string" ? value.targetId : undefined,
	});
}

function legacyMessage(entry: Record<string, unknown>): Record<string, unknown> | undefined {
	if (entry.type === "custom" && entry.customType === BROWSER_TRANSITION_ENTRY && isRecord(entry.data) && isRecord(entry.data.details)) return entry.data;
	const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
	return message && typeof message.toolName === "string" && BROWSER_RESULT_TOOLS.has(message.toolName) && isRecord(message.details)
		&& message.details.browserEventVersion !== 1 ? message : undefined;
}

function legacySnapshot(value: unknown, id: string): BrowserSnapshot | undefined {
	if (!isRecord(value) || !Array.isArray(value.refIds)) return undefined;
	const refIds = value.refIds.filter((ref): ref is string => typeof ref === "string" && /^e\d+$/.test(ref));
	const sourceRefs = isRecord(value.refs) ? value.refs : {};
	const snapshot: SessionRefSnapshot = {
		snapshotId: typeof value.snapshotId === "string" ? value.snapshotId : id, refIds,
		generation: typeof value.generation === "string" ? value.generation : undefined,
		refs: Object.fromEntries(refIds.flatMap(refId => {
			const ref = sourceRefs[refId];
			if (!isRecord(ref) || typeof ref.name !== "string" || typeof ref.role !== "string") return [];
			return [[refId, { name: ref.name, role: ref.role, ...(typeof ref.isEditable === "boolean" ? { isEditable: ref.isEditable } : {}), ...(typeof ref.isContentEditable === "boolean" ? { isContentEditable: ref.isContentEditable } : {}) }]];
		})),
		target: isRecord(value.target) ? legacyTarget(value.target) : undefined,
	};
	return snapshotDefinition(snapshot);
}

/** Offline only: normalize old receipts along their actual parent ancestry, never physical-order equality. */
export function convertLegacyBrowserEntry(entry: Record<string, unknown>, parent: LegacyProjection = emptyProjection(), ownerSessionId?: string): { record?: BrowserRecord; projection: LegacyProjection } {
	const current: LegacyProjection = { pages: new Map(parent.pages), manifest: parent.manifest, nextIndex: parent.nextIndex };
	const nativeId = typeof entry.id === "string" ? entry.id : randomUUID();
	const canonical = getBrowserRecord(entry);
	if (canonical) {
		current.manifest = applyArtifactChanges(parent.manifest, canonical.event.artifacts);
		for (const page of canonical.event.pages ?? []) {
			const prior = current.pages.get(page.key) ?? {};
			if (page.clear) { current.pages.delete(page.key); continue; }
			const definition = canonical.snapshot;
			const digest = definition?.refs ? createHash("sha256").update(JSON.stringify({ refs: definition.refs, target: definition.target, generation: definition.generation })).digest("hex") : prior.snapshot?.digest ?? "";
			current.pages.set(page.key, { target: page.target, unknown: page.unknown, reopenPending: page.reopenPending,
				snapshot: page.refs.kind === "replace" || page.refs.kind === "reuse" ? { id: page.refs.snapshotId, digest, usable: true, candidate: false }
					: prior.snapshot ? { ...prior.snapshot, usable: false, candidate: canonical.event.phase === "begin" } : undefined,
				pending: canonical.event.phase === "begin" ? { operationId: canonical.event.operationId, toolCallId: canonical.event.toolCallId, index: canonical.event.commandIndex } : undefined });
		}
		return { projection: current };
	}
	if (entry.type === "custom" && entry.customType === "agent-browser-script-session" && isRecord(entry.data)) {
		return { record: { event: { version: 1, phase: "state", operationId: `legacy-${nativeId}`, toolCallId: `legacy-${nativeId}`, commandIndex: 0, isError: entry.data.cleanup !== "closed", state: { scriptLease: { ...entry.data, ownerSessionId: entry.data.ownerSessionId ?? ownerSessionId } } } }, projection: current };
	}
	const message = legacyMessage(entry);
	if (!message || !isRecord(message.details)) return { projection: parent };
	const details = message.details;
	const sessionName = typeof details.sessionName === "string" ? details.sessionName : undefined;
	const namespace = typeof details.namespace === "string" ? details.namespace : undefined;
	const key = sessionName ? getAgentBrowserSessionIdentityKey(sessionName, namespace) : undefined;
	const args = Array.isArray(details.args) ? details.args.filter((arg): arg is string => typeof arg === "string") : [];
	const tokens = extractUpstreamCommandTokens(args);
	const command = typeof details.command === "string" ? details.command : tokens[0];
	const subcommand = typeof details.subcommand === "string" ? details.subcommand : tokens[1];
	const isError = message.isError === true;
	const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : `legacy-${nativeId}`;
	const prior = key ? current.pages.get(key) ?? {} : {};
	const begin = entry.type === "custom" && details.sessionTabTargetUnknown === true && details.command === undefined && details.exitCode === undefined && details.agentBrowserStarted === undefined;
	const pending = prior.pending?.toolCallId === toolCallId ? prior.pending : undefined;
	const phase = begin ? "begin" : pending ? "finish" : "state";
	const commandIndex = begin ? current.nextIndex++ : pending?.index ?? 0;
	const operationId = pending?.operationId ?? `legacy-${nativeId}`;
	const pages: BrowserPageChange[] = [];
	const closeLifecycle = getSuccessfulBatchCloseLifecycle(details.batchSteps);
	const closeAll = details.closeAllApplied === true || (!isError && isCloseAllCommand(tokens)) || batchHasSuccessfulCloseAll(details.batchSteps);
	const lifecycleReset = !isError && isCloseCommand(command) || closeLifecycle !== undefined;
	if (closeAll) {
		for (const pageKey of current.pages.keys()) if (isAgentBrowserSessionIdentityKeyInNamespace(pageKey, namespace)) { current.pages.delete(pageKey); pages.push({ key: pageKey, clear: true, refs: { kind: "invalidate" } }); }
	} else if (key && lifecycleReset) { current.pages.delete(key); pages.push({ key, clear: true, refs: { kind: "invalidate" } }); }
	let definition: BrowserSnapshot | undefined;
	const hasPageEffects = begin || ["sessionTabTargetUnknown", "sessionTabTarget", "sessionTabReopenPending", "refSnapshot", "refSnapshotInvalidation"].some(field => details[field] !== undefined)
		|| command === "batch" && Array.isArray(details.data);
	if (key && hasPageEffects && !((closeAll || lifecycleReset) && (isCloseCommand(command) || closeLifecycle?.endsClosed === true))) {
		const page: LegacyPage = { ...(current.pages.get(key) ?? {}) };
		if (begin) {
			page.target = undefined; page.unknown = true;
			page.snapshot = prior.snapshot ? { ...prior.snapshot, usable: false, candidate: true } : undefined;
			page.pending = { toolCallId, operationId, index: commandIndex };
			pages.push({ key, refs: { kind: "unknown" }, unknown: true });
		} else if (details.sessionTabTargetUnknown === true) {
			page.target = undefined; page.unknown = true; page.pending = undefined;
			page.snapshot = page.snapshot ? { ...page.snapshot, usable: false, candidate: false } : undefined;
			pages.push({ key, refs: { kind: "unknown", invalidation: isRecord(details.refSnapshotInvalidation) ? details.refSnapshotInvalidation as unknown as SessionRefSnapshotInvalidation : undefined }, unknown: true });
		} else {
			if (!isRecord(details.compiledNetworkSourceLookup) && !isReadOnlyDiagnosticSessionTargetCommand(command, subcommand) && isRecord(details.sessionTabTarget)) page.target = legacyTarget(details.sessionTabTarget) ?? page.target;
			else if (command === "batch" && !isRecord(details.compiledNetworkSourceLookup)) page.target = extractSessionTabTargetFromBatchResults(details.data) ?? page.target;
			if (page.target) page.unknown = undefined;
			if (typeof details.sessionTabReopenPending === "boolean") page.reopenPending = details.sessionTabReopenPending;
			const invalidation = isRecord(details.refSnapshotInvalidation) && ["no-active-page", "page-transition"].includes(String(details.refSnapshotInvalidation.reason))
				? details.refSnapshotInvalidation as unknown as SessionRefSnapshotInvalidation
				: isNoActivePageSnapshotFailure(command, typeof details.error === "string" ? details.error : typeof details.summary === "string" ? details.summary : undefined) ? buildNoActivePageRefSnapshotInvalidation() : undefined;
			const candidate = invalidation ? undefined : legacySnapshot(details.refSnapshot, `snapshot-${nativeId}`);
			let refs: BrowserPageChange["refs"];
			if (candidate) {
				const digest = createHash("sha256").update(JSON.stringify({ refs: candidate.refs, target: candidate.target, generation: candidate.generation })).digest("hex");
				if (page.snapshot?.digest === digest && (page.snapshot.usable || page.snapshot.candidate)
					&& (!isRecord(details.refSnapshot) || typeof details.refSnapshot.snapshotId !== "string" || details.refSnapshot.snapshotId === page.snapshot.id)) refs = { kind: "reuse", snapshotId: page.snapshot.id };
				else { definition = candidate; refs = { kind: "replace", snapshotId: candidate.id }; }
				page.snapshot = { id: refs.snapshotId, digest, usable: true, candidate: false };
			} else if (invalidation) {
				refs = { kind: "invalidate", invalidation: { reason: invalidation.reason, summary: typeof invalidation.summary === "string" ? invalidation.summary : "The prior refs were invalidated; take a fresh snapshot." } };
				page.snapshot = page.snapshot ? { ...page.snapshot, usable: false, candidate: false } : undefined;
			} else refs = page.snapshot?.usable ? { kind: "reuse", snapshotId: page.snapshot.id } : { kind: "invalidate" };
			page.pending = undefined;
			pages.push({ key, target: page.target, unknown: page.unknown, reopenPending: page.reopenPending, refs });
		}
		current.pages.set(key, page);
	}
	if (isSessionArtifactManifest(details.artifactManifest) && (!parent.manifest || details.artifactManifest.updatedAtMs >= parent.manifest.updatedAtMs)) current.manifest = details.artifactManifest;
	const artifacts = artifactChanges(parent.manifest, current.manifest);
	if (!artifacts) current.manifest = parent.manifest;
	const state = browserStateEffects(details);
	if (isRecord(state.electron)) {
		const stamp = (value: unknown) => isRecord(value) ? { ...value, ownerSessionId: value.ownerSessionId ?? ownerSessionId } : value;
		const cleanup = isRecord(state.electron.cleanup) ? state.electron.cleanup : undefined;
		state.electron = { ...state.electron, launch: stamp(state.electron.launch), ...(cleanup ? { cleanup: {
			...cleanup, records: Array.isArray(cleanup.records) ? cleanup.records.map(stamp) : cleanup.records,
			results: Array.isArray(cleanup.results) ? cleanup.results.map(row => isRecord(row) ? { ...row, record: stamp(row.record) } : row) : cleanup.results,
		} } : {}) };
	}
	return { record: { event: { version: 1, phase, operationId, toolCallId, commandIndex, isError, state, pages, artifacts }, ...(definition ? { snapshot: definition } : {}) }, projection: current };
}

/** Explicit archive/in-memory conversion. Runtime restoration never invokes the legacy decoder. */
export function convertBrowserEntries(entries: unknown[], ownerSessionId?: string): unknown[] {
	const states = new Map<string, LegacyProjection>();
	let linear = emptyProjection();
	return entries.map((value, index) => {
		if (!isRecord(value)) return value;
		const entry: Record<string, unknown> & { id: string } = { ...value, id: typeof value.id === "string" ? value.id : `archive-${index}`, parentId: value.parentId ?? null };
		const parent = typeof value.parentId === "string" ? states.get(value.parentId) ?? emptyProjection() : Object.hasOwn(value, "parentId") ? emptyProjection() : linear;
		const converted = convertLegacyBrowserEntry(entry, parent, ownerSessionId);
		states.set(entry.id, converted.projection); linear = converted.projection;
		return converted.record ? { ...entry, ...(entry.type === "custom" ? { customType: BROWSER_TRANSITION_ENTRY } : {}), data: converted.record } : entry;
	});
}

const LEGACY_DETAILS_FIELDS = [...BROWSER_STATE_FIELDS, "browserEventVersion", "electron", "compiledNetworkSourceLookup", "sessionTabTarget", "sessionTabTargetUnknown", "sessionTabReopenPending", "refSnapshot", "refSnapshotInvalidation", "artifactManifest", "error", "summary"];
const LEGACY_FIELDS = [
	["data", "event"], ["data", "snapshot"], ["data", "cleanup"], ["data", "sessionName"], ["data", "closeCommandArgs"], ["data", "launchAttempted"],
	["data", "toolCallId"], ["data", "isError"], ["message", "toolName"], ["message", "toolCallId"], ["message", "isError"],
	...["data", "message"].flatMap(root => LEGACY_DETAILS_FIELDS.map(field => [root, "details", field])),
	...["data", "message"].flatMap(root => [
		...["command", "success", "lifecycle"].map(field => [root, "details", "batchSteps", "*", field]),
		...[["data", "lifecycle"], ["result", "lifecycle"]].map(field => [root, "details", "batchSteps", "*", ...field]),
	]),
	...["data", "message"].flatMap(root => [
		...[["command"], ["success"], ["error"]].map(field => [root, "details", "data", "*", ...field]),
		...["url", "title", "origin", "targetId"].map(field => [root, "details", "data", "*", "result", field]),
	]),
];

async function sourceChecksum(file: FileHandle, size: number): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of readRange(file, { offset: 0, length: size })) hash.update(chunk);
	return hash.digest("hex");
}

async function writeBytes(file: FileHandle, chunks: AsyncIterable<Uint8Array | string>): Promise<void> {
	for await (const chunk of chunks) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
			if (!bytesWritten) throw new Error("Could not write converted journal.");
			offset += bytesWritten;
		}
	}
}

async function rewriteMessage(file: FileHandle, range: JournalRange, destination: FileHandle, record: BrowserRecord): Promise<void> {
	async function* decode() {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		for await (const bytes of readRange(file, range)) yield decoder.decode(bytes, { stream: true });
		const tail = decoder.decode(); if (tail) yield tail;
	}
	const tokenizer = parser.asStream({ packValues: false, packKeys: true, streamKeys: false });
	const filter = ignore.asStream({ filter: /^(?:data|message\.details\.(?:refSnapshot|artifactManifest|browserEventVersion))$/ });
	async function* inject(tokens: AsyncIterable<Token>) {
		let depth = 0;
		for await (const token of tokens) {
			if (token.name === "startObject" || token.name === "startArray") depth++;
			if (token.name === "endObject" || token.name === "endArray") {
				depth--;
				if (depth === 0) {
					yield { name: "keyValue", value: "data" } as Token;
					yield* disassembler({ packValues: false, packKeys: true, streamKeys: false })(record);
				}
			}
			yield token;
		}
	}
	const output = stringer.asStream({ useKeyValues: true });
	const processing = pipeline(Readable.from(decode()), tokenizer, filter, inject, output);
	try { await writeBytes(destination, output); await processing; }
	finally { tokenizer.destroy(); filter.destroy(); output.destroy(); }
	await destination.write("\n");
}

export interface BrowserConversionReceipt {
	version: 1;
	source: string;
	destination: string;
	sessionId: string;
	sourceSha256: string;
	destinationSha256: string;
	entryCount: number;
	convertedRecords: number;
	snapshotDefinitions: number;
	sourceBytes: number;
	destinationBytes: number;
}

/** Separate-copy publication only. The operator must quiesce the exact writer first. */
export async function convertBrowserSession(options: { source: string; destination: string; confirmedStopped: boolean }): Promise<BrowserConversionReceipt> {
	if (!options.confirmedStopped) throw new Error("Stop/quiesce the exact session writer first, then pass --confirm-stopped. Conversion never stops a session.");
	const source = resolve(options.source); const destination = resolve(options.destination);
	if (source === destination) throw new Error("Conversion requires a separate destination; originals are never rewritten.");
	const sourcePathStat = await lstat(source);
	if (!sourcePathStat.isFile() || sourcePathStat.isSymbolicLink()) throw new Error("Conversion source must be a regular file, not a symlink.");
	const directory = dirname(destination);
	await mkdir(directory, { mode: 0o700, recursive: true });
	const directoryStat = await lstat(directory);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || process.platform !== "win32" && (directoryStat.uid !== process.getuid?.() || (directoryStat.mode & 0o077) !== 0)) throw new Error("Conversion destination must be a private current-user directory (0700 on POSIX), without symlinks.");
	try { await lstat(destination); throw new Error("Conversion destination is occupied."); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const file = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	const stagePath = `${destination}.${randomUUID()}.tmp`;
	let stage: FileHandle | undefined;
	let published = false;
	try {
		const initial = await file.stat();
		if (initial.dev !== sourcePathStat.dev || initial.ino !== sourcePathStat.ino) throw new Error("Conversion source changed before capture.");
		const checksum = await sourceChecksum(file, initial.size);
		const metadata = await scanJournalMetadata(file, initial.size, true);
		const header = metadata[0];
		if (header?.value.type !== "session" || typeof header.value.id !== "string") throw new Error("Conversion source has no native session header.");
		const ids = new Set<string>();
		const states = new Map<string, LegacyProjection>();
		stage = await open(stagePath, "wx+", 0o600);
		let convertedRecords = 0; let snapshotDefinitions = 0;
		for (const entry of metadata) {
			let record: BrowserRecord | undefined;
			if (entry.value.type !== "session") {
				if (typeof entry.value.id !== "string" || ids.has(entry.value.id)) throw new Error("Conversion source contains a missing or duplicate native entry ID.");
				if (entry.value.parentId !== null && (typeof entry.value.parentId !== "string" || !ids.has(entry.value.parentId))) throw new Error("Conversion source contains a missing or forward parent.");
				ids.add(entry.value.id);
				const parent = typeof entry.value.parentId === "string" ? states.get(entry.value.parentId) ?? emptyProjection() : emptyProjection();
				const relevant = entry.value.type === "custom" && [BROWSER_TRANSITION_ENTRY, "agent-browser-script-session"].includes(String(entry.value.customType))
					|| isRecord(entry.value.message) && BROWSER_RESULT_TOOLS.has(String(entry.value.message.toolName));
				if (relevant) {
					const details = await projectJson(readRange(file, entry), LEGACY_FIELDS, Infinity);
					const conversion = convertLegacyBrowserEntry({ ...entry.value, ...details }, parent, header.value.id);
					record = conversion.record;
					states.set(entry.value.id, conversion.projection);
				} else states.set(entry.value.id, parent);
			}
			if (record) {
				const data = { ...record, archive: { sourceSha256: checksum, offset: entry.offset, length: entry.length } };
				if (entry.value.type === "message") await rewriteMessage(file, entry, stage, data);
				else await stage.write(`${JSON.stringify({ ...entry.value, customType: BROWSER_TRANSITION_ENTRY, data })}\n`);
				convertedRecords++; if (record.snapshot) snapshotDefinitions++;
			} else {
				await writeBytes(stage, readRange(file, entry));
				if (entry.offset + entry.length === initial.size) {
					const lastByte = Buffer.alloc(1); await file.read(lastByte, 0, 1, initial.size - 1);
					if (lastByte[0] !== 10) await stage.write("\n");
				}
			}
		}
		await stage.sync();
		const output = await stage.stat();
		const destinationSha256 = await sourceChecksum(stage, output.size);
		const final = await file.stat(); const finalPath = await lstat(source);
		if (final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs
			|| finalPath.dev !== initial.dev || finalPath.ino !== initial.ino || await sourceChecksum(file, initial.size) !== checksum) throw new Error("Conversion source changed; no destination was published.");
		await stage.close(); stage = undefined;
		await link(stagePath, destination); // Exclusive publication; never overwrite an existing destination.
		published = true;
		return { version: 1, source, destination, sessionId: header.value.id, sourceSha256: checksum, destinationSha256, entryCount: ids.size,
			convertedRecords, snapshotDefinitions, sourceBytes: initial.size, destinationBytes: output.size };
	} finally {
		await stage?.close(); await file.close();
		await unlink(stagePath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
		if (published && process.platform !== "win32") { const parent = await open(directory, constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); } }
	}
}

import http from "node:http";
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join, parse, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
//#region lib/gateway-client.ts
/**
* HTTP client for the TDAI Gateway, with Bearer token authentication and
* silent-failure semantics suitable for cc hook handlers (any error returns
* an empty / no-op response rather than throwing). Failures are also
* appended to an optional log file so the daemon's health can be diagnosed
* via /memory-status without re-attaching a debugger.
*
* RESILIENCE NOTES (Phase 3):
* - Timeouts are named constants (see below) so they are easy to tune.
* - The capture/write path (POST /capture) gets a separate, more generous
*   timeout than recall, so transient gateway slowness during session save
*   does not silently drop the session.
* - On 401 (stale token after gateway restart) the client re-reads the token
*   file once and retries the request automatically.
* - On any capture failure the caller (hook.ts) emits a loud stderr warning
*   visible in the Claude Code UI — not just a hidden log file.
*/
/** Recall timeout: must not hang the prompt; kept short and non-blocking.
*  Defence-in-depth at 6s (was 4s): the corpus-embedding that used to push the
*  first-turn recall to ~5s is now built off the critical path (see
*  tdai-core.buildCornerstoneInBackground), so recall is normally <1s. 6s still
*  bounds the prompt but no longer clips a legitimately slow (cold/contended)
*  query embedding, which silently dropped the whole session-open injection. */
const RECALL_TIMEOUT_MS = 6e3;
/** Capture timeout: session save is more important; allow extra time for a
*  slow gateway write-through before declaring the save lost. */
const CAPTURE_TIMEOUT_MS = 12e3;
var GatewayClient = class {
	baseUrl;
	token;
	timeoutMs;
	logPath;
	/** Path to the token file; when set, token is always read fresh from disk. */
	tokenPath;
	constructor(config) {
		this.baseUrl = new URL(config.baseUrl);
		this.token = config.token;
		this.timeoutMs = config.timeoutMs ?? 5e3;
		this.logPath = config.logPath;
		this.tokenPath = config.tokenPath;
	}
	/**
	* Read the current token from disk (Phase 3: TOKEN/AUTH — no cached token).
	* Falls back to the in-memory token if the file cannot be read.
	*/
	async freshToken() {
		if (!this.tokenPath) return this.token;
		try {
			const t = (await readFile(this.tokenPath, "utf-8")).trim();
			if (t) {
				this.token = t;
				return t;
			}
		} catch {}
		return this.token;
	}
	async logFailure(method, path, detail) {
		if (!this.logPath) return;
		try {
			await appendFile(this.logPath, `[${(/* @__PURE__ */ new Date()).toISOString()}] gateway-client ${method} ${path}: ${detail}\n`);
		} catch {}
	}
	describeStatus(status, body) {
		return `HTTP ${status} ${body.length > 200 ? body.slice(0, 200) + "…" : body}`;
	}
	/**
	* /health with its body, so callers can see `last_capture_at`.
	* Returns null when the gateway cannot be reached or answers non-200.
	*/
	async healthDetailed() {
		try {
			const token = await this.freshToken();
			const { status, body } = await this.rawRequest("GET", "/health", void 0, token);
			if (status !== 200 && status !== 503) {
				await this.logFailure("GET", "/health", this.describeStatus(status, body));
				return null;
			}
			return {
				...JSON.parse(body),
				reachable: true
			};
		} catch (err) {
			await this.logFailure("GET", "/health", err instanceof Error ? err.message : String(err));
			return null;
		}
	}
	async health() {
		try {
			const token = await this.freshToken();
			const { status, body } = await this.rawRequest("GET", "/health", void 0, token);
			if (status === 200) return true;
			await this.logFailure("GET", "/health", this.describeStatus(status, body));
			return false;
		} catch (err) {
			await this.logFailure("GET", "/health", err instanceof Error ? err.message : String(err));
			return false;
		}
	}
	async recall(query, sessionKey, project, sessionId) {
		try {
			const token = await this.freshToken();
			const { status, body } = await this.rawRequest("POST", "/recall", {
				query,
				session_key: sessionKey,
				project,
				session_id: sessionId
			}, token, RECALL_TIMEOUT_MS);
			if (status !== 200) {
				await this.logFailure("POST", "/recall", this.describeStatus(status, body));
				return { context: "" };
			}
			const parsed = JSON.parse(body);
			return {
				context: parsed.context ?? "",
				strategy: parsed.strategy,
				memory_count: parsed.memory_count
			};
		} catch (err) {
			await this.logFailure("POST", "/recall", err instanceof Error ? err.message : String(err));
			return { context: "" };
		}
	}
	/**
	* POST /observe — PostToolUse proactive injection by situation. Short timeout
	* (same budget as recall): if the gateway is slow/down, stay silent rather
	* than block the turn. Returns "" for silence.
	*/
	async observe(payload) {
		try {
			const token = await this.freshToken();
			const { status, body } = await this.rawRequest("POST", "/observe", {
				session_key: payload.sessionKey,
				tool_name: payload.toolName,
				tool_input: payload.toolInput,
				tool_output_text: payload.toolOutputText,
				tool_output_is_error: payload.toolOutputIsError,
				tool_risk: payload.toolRisk
			}, token, RECALL_TIMEOUT_MS);
			if (status !== 200) {
				await this.logFailure("POST", "/observe", this.describeStatus(status, body));
				return "";
			}
			return JSON.parse(body).context ?? "";
		} catch (err) {
			await this.logFailure("POST", "/observe", err instanceof Error ? err.message : String(err));
			return "";
		}
	}
	/**
	* POST /capture — uses CAPTURE_TIMEOUT_MS (generous) so slow gateway writes
	* are not falsely treated as failures (Phase 3: HOOK CLIENT TIMEOUT).
	*
	* Returns null on failure; the caller (handleStop in hook.ts) is responsible
	* for emitting a LOUD user-visible warning in that case (Phase 3: NO SILENT
	* FAILURE).
	*/
	async captureTurn(payload) {
		const result = await this.captureTurnOnce(payload);
		if (result !== null) return result;
		await new Promise((r) => setTimeout(r, 2e3));
		return this.captureTurnOnce(payload);
	}
	/** Single attempt at POST /capture; returns null (and logs) on any error. */
	async captureTurnOnce(payload) {
		try {
			const token = await this.freshToken();
			const { status, body } = await this.rawRequest("POST", "/capture", payload, token, CAPTURE_TIMEOUT_MS);
			if (status === 401 && this.tokenPath) {
				this.token = "";
				const freshTok = await this.freshToken();
				const retry = await this.rawRequest("POST", "/capture", payload, freshTok, CAPTURE_TIMEOUT_MS);
				if (retry.status === 200) return JSON.parse(retry.body);
				await this.logFailure("POST", "/capture", `401 after token refresh: ${this.describeStatus(retry.status, retry.body)}`);
				return null;
			}
			if (status !== 200) {
				await this.logFailure("POST", "/capture", this.describeStatus(status, body));
				return null;
			}
			return JSON.parse(body);
		} catch (err) {
			await this.logFailure("POST", "/capture", err instanceof Error ? err.message : String(err));
			return null;
		}
	}
	async searchMemories(query, opts) {
		try {
			const token = await this.freshToken();
			const { status, body } = await this.rawRequest("POST", "/search/memories", {
				query,
				limit: opts?.limit,
				type: opts?.type,
				scene: opts?.scene
			}, token);
			if (status !== 200) {
				await this.logFailure("POST", "/search/memories", this.describeStatus(status, body));
				return {
					results: "",
					total: 0
				};
			}
			return JSON.parse(body);
		} catch (err) {
			await this.logFailure("POST", "/search/memories", err instanceof Error ? err.message : String(err));
			return {
				results: "",
				total: 0
			};
		}
	}
	async searchConversations(query, opts) {
		try {
			const token = await this.freshToken();
			const { status, body } = await this.rawRequest("POST", "/search/conversations", {
				query,
				limit: opts?.limit,
				session_key: opts?.sessionKey
			}, token);
			if (status !== 200) {
				await this.logFailure("POST", "/search/conversations", this.describeStatus(status, body));
				return {
					results: "",
					total: 0
				};
			}
			return JSON.parse(body);
		} catch (err) {
			await this.logFailure("POST", "/search/conversations", err instanceof Error ? err.message : String(err));
			return {
				results: "",
				total: 0
			};
		}
	}
	async sessionEnd(sessionKey) {
		try {
			const token = await this.freshToken();
			const { status, body } = await this.rawRequest("POST", "/session/end", { session_key: sessionKey }, token);
			if (status !== 200) await this.logFailure("POST", "/session/end", this.describeStatus(status, body));
		} catch (err) {
			await this.logFailure("POST", "/session/end", err instanceof Error ? err.message : String(err));
		}
	}
	/**
	* POST /memory/confirm | /memory/reject — resolve a grounded-trust gate from
	* Claude Code. 200 and 409 both carry `{ok, text}` (409 = the store could
	* not apply it); 400 carries `{error}` and is mapped to `{ok:false, text}`.
	* Returns null only on transport failure or an unexpected status, so the
	* caller can say "not applied" instead of pretending.
	*/
	async resolveGatedMemory(decision, ownerId, ownerKind) {
		const path = `/memory/${decision}`;
		try {
			const token = await this.freshToken();
			const { status, body } = await this.rawRequest("POST", path, {
				owner_id: ownerId,
				owner_kind: ownerKind
			}, token);
			if (status === 200 || status === 409) {
				const parsed = JSON.parse(body);
				return {
					ok: parsed.ok === true,
					text: parsed.text ?? ""
				};
			}
			if (status === 400) return {
				ok: false,
				text: JSON.parse(body).error ?? this.describeStatus(status, body)
			};
			await this.logFailure("POST", path, this.describeStatus(status, body));
			return null;
		} catch (err) {
			await this.logFailure("POST", path, err instanceof Error ? err.message : String(err));
			return null;
		}
	}
	rawRequest(method, path, bodyObj, token = this.token, timeoutMs = this.timeoutMs) {
		return new Promise((resolve, reject) => {
			const bodyStr = bodyObj !== void 0 ? JSON.stringify(bodyObj) : void 0;
			const opts = {
				protocol: this.baseUrl.protocol,
				hostname: this.baseUrl.hostname,
				port: this.baseUrl.port,
				method,
				path,
				headers: {
					Authorization: `Bearer ${token}`,
					...bodyStr ? {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(bodyStr).toString()
					} : {}
				}
			};
			const req = http.request(opts, (res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({
					status: res.statusCode ?? 0,
					body: Buffer.concat(chunks).toString("utf-8")
				}));
			});
			req.setTimeout(timeoutMs, () => {
				req.destroy(/* @__PURE__ */ new Error(`Timeout after ${timeoutMs}ms`));
			});
			req.on("error", reject);
			if (bodyStr) req.write(bodyStr);
			req.end();
		});
	}
};
//#endregion
//#region lib/session-key.ts
/**
* Compute a stable session key for a given working directory.
*
* Default: SHA-256 of the normalized absolute path, first 16 hex chars (64 bits).
* Override: TDAI_SESSION_KEY env var, if non-empty.
*
* Used by hook handlers to partition memory by project rather than by
* Claude Code session, so multiple cc terminals on the same project share
* recall results.
*/
function getSessionKey(cwd) {
	const override = process.env.TDAI_SESSION_KEY;
	if (override && override.length > 0) return override;
	const normalized = resolve(cwd);
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
/**
* Human-readable project name for a working directory: the basename of the
* resolved cwd (e.g. C:\…\tencentdb-agent-memory → "tencentdb-agent-memory").
* Used to select per-project principles. Returns "" for a root/empty path.
*/
function getProjectName(cwd) {
	return basename(resolve(cwd));
}
//#endregion
//#region lib/transcript.ts
/**
* Parse cc transcript jsonl files defensively. cc's transcript format is
* NOT a documented stable API — fields may rename across versions. This
* module returns null on any unexpected shape rather than throwing.
*/
/**
* Parse a single JSONL line. Returns null on malformed or unrecognized shape.
*/
function parseTranscriptLine(line) {
	let obj;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}
	if (!obj || typeof obj !== "object") return null;
	const o = obj;
	const type = typeof o.type === "string" ? o.type : null;
	if (!type) return null;
	const message = o.message;
	if (!message || typeof message !== "object") return null;
	const role = typeof message.role === "string" ? message.role : type;
	const content = extractContent(message.content);
	if (content === null) return null;
	return {
		type,
		role,
		content,
		contentIsArray: Array.isArray(message.content),
		uuid: typeof o.uuid === "string" ? o.uuid : void 0,
		parentUuid: typeof o.parentUuid === "string" ? o.parentUuid : void 0,
		timestamp: typeof o.timestamp === "string" ? o.timestamp : void 0
	};
}
function extractContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts = [];
		for (const item of content) {
			if (!item || typeof item !== "object") continue;
			const it = item;
			if (typeof it.text === "string") parts.push(it.text);
		}
		return parts.length > 0 ? parts.join("\n") : null;
	}
	return null;
}
/**
* Read ALL complete user+assistant turns from a transcript. Each turn
* merges multi-part assistant responses (split by tool cycles) into a
* single string, same as {@link readLatestTurn}.
*/
async function readAllTurns(path) {
	let raw;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return [];
	}
	const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
	if (lines.length === 0) return [];
	const turns = [];
	let currentUser = null;
	let assistantParts = [];
	for (const line of lines) {
		const entry = parseTranscriptLine(line);
		if (!entry) continue;
		if (entry.role === "user" && !entry.contentIsArray) {
			if (currentUser !== null && assistantParts.length > 0) turns.push({
				user: currentUser,
				assistant: assistantParts.join("\n\n")
			});
			currentUser = entry.content;
			assistantParts = [];
		} else if (entry.role === "assistant" && entry.content) assistantParts.push(entry.content);
	}
	if (currentUser !== null && assistantParts.length > 0) turns.push({
		user: currentUser,
		assistant: assistantParts.join("\n\n")
	});
	return turns;
}
//#endregion
//#region lib/daemon.ts
/**
* Daemon manager — spawns the TdaiGateway as a long-lived sidecar bound
* to the parent cc process. Mirrors the supervisor.py pattern from
* hermes-plugin/.
*/
const DEFAULT_PORT_START = 8421;
const DEFAULT_PORT_END = 8430;
const STATE_FILE = "state.json";
async function readDaemonState(dataDir) {
	const path = join(dataDir, STATE_FILE);
	if (!existsSync(path)) return null;
	try {
		const raw = await readFile(path, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
async function writeDaemonState(dataDir, state) {
	await mkdir(dataDir, { recursive: true });
	const tmp = join(dataDir, `${STATE_FILE}.tmp`);
	const final = join(dataDir, STATE_FILE);
	await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 384 });
	await rename(tmp, final);
}
async function clearDaemonState(dataDir) {
	const path = join(dataDir, STATE_FILE);
	try {
		await unlink(path);
	} catch {}
}
var DaemonManager = class {
	dataDir;
	portStart;
	portEnd;
	constructor(config) {
		this.dataDir = config.dataDir;
		this.portStart = config.portStart ?? DEFAULT_PORT_START;
		this.portEnd = config.portEnd ?? DEFAULT_PORT_END;
	}
	async generateToken() {
		await mkdir(this.dataDir, { recursive: true });
		const token = randomBytes(32).toString("base64url");
		const tokenPath = join(this.dataDir, "token");
		await writeFile(tokenPath, token, { mode: 384 });
		return tokenPath;
	}
	async readToken(tokenPath) {
		const st = await stat(tokenPath);
		if (process.platform !== "win32" && (st.mode & 63) !== 0) throw new Error(`Token file permission too loose: ${tokenPath}`);
		if (process.platform !== "win32" && typeof process.getuid === "function") {
			const uid = process.getuid();
			if (st.uid !== uid) throw new Error(`Token file owner mismatch: expected uid=${uid}, got uid=${st.uid} for ${tokenPath}`);
		}
		return (await readFile(tokenPath, "utf-8")).trim();
	}
	async findFreePort(start = this.portStart, end = this.portEnd) {
		for (let p = start; p <= end; p++) if (await this.isPortFree(p)) return p;
		throw new Error(`No free port in ${start}..${end}`);
	}
	isPortFree(port) {
		return new Promise((resolve) => {
			const tester = net.createServer();
			tester.once("error", () => resolve(false));
			tester.once("listening", () => {
				tester.close(() => resolve(true));
			});
			tester.listen(port, "127.0.0.1");
		});
	}
	async probe() {
		const state = await readDaemonState(this.dataDir);
		if (!state) return false;
		let token;
		try {
			token = await this.readToken(state.tokenPath);
		} catch {
			return false;
		}
		return this.healthCheck(state.port, token);
	}
	healthCheck(port, token, timeoutMs = 2e3) {
		return new Promise((resolve) => {
			const req = http.request({
				host: "127.0.0.1",
				port,
				path: "/health",
				method: "GET",
				headers: { Authorization: `Bearer ${token}` }
			}, (res) => resolve(res.statusCode === 200));
			req.setTimeout(timeoutMs, () => {
				req.destroy();
				resolve(false);
			});
			req.on("error", () => resolve(false));
			req.end();
		});
	}
	async ensureRunning(ccPid) {
		const reuseExisting = async () => {
			const existing = await readDaemonState(this.dataDir);
			if (!existing) return null;
			if (existing.ccPid > 0 && existing.ccPid !== ccPid) return null;
			let token = "";
			try {
				token = await this.readToken(existing.tokenPath);
			} catch {
				return null;
			}
			if (!token) return null;
			if (await this.healthCheck(existing.port, token)) return existing;
			const deadline = Date.now() + 1e4;
			while (Date.now() < deadline) {
				await sleep(500);
				if (await this.healthCheck(existing.port, token)) return existing;
			}
			return null;
		};
		const reused = await reuseExisting();
		if (reused) return reused;
		const lock = await this.acquireSpawnLock();
		if (!lock) {
			const deadline = Date.now() + 35e3;
			while (Date.now() < deadline) {
				await sleep(500);
				const r = await reuseExisting();
				if (r) return r;
			}
			throw new Error("daemon spawn lock contention timed out");
		}
		try {
			const r = await reuseExisting();
			if (r) return r;
			return await this.spawn(ccPid);
		} finally {
			await lock.release();
		}
	}
	/**
	* Returns a held lock handle, or null if another process owns the lock.
	* Stale locks (>60s old) are forcibly broken so a crashed hook never wedges
	* the daemon-up path.
	*/
	async acquireSpawnLock() {
		await mkdir(this.dataDir, { recursive: true });
		const lockPath = join(this.dataDir, "spawn.lock");
		const tryCreate = async () => {
			try {
				const fh = await open(lockPath, "wx");
				await fh.write(`${process.pid}\n`);
				await fh.close();
				return { release: async () => {
					try {
						await unlink(lockPath);
					} catch {}
				} };
			} catch (err) {
				if (err.code === "EEXIST") return null;
				throw err;
			}
		};
		const first = await tryCreate();
		if (first) return first;
		try {
			const st = await stat(lockPath);
			if (Date.now() - st.mtimeMs > 6e4) {
				await unlink(lockPath).catch(() => {});
				return tryCreate();
			}
		} catch {
			return tryCreate();
		}
		return null;
	}
	/**
	* Spawn the Gateway daemon by invoking `npx tdai-memory-gateway`.
	*
	* The user must have `@tencentdb-agent-memory/memory-tencentdb` installed,
	* either globally (`npm install -g`) or in the current project (which exposes
	* the `tdai-memory-gateway` bin via npx's PATH resolution).
	*/
	async spawn(ccPid) {
		const port = await this.findFreePort();
		const tokenPath = await this.generateToken();
		const token = await this.readToken(tokenPath);
		const rawGatewayCommand = process.env.TDAI_GATEWAY_COMMAND?.trim();
		const gatewayParts = rawGatewayCommand ? rawGatewayCommand.split(/\s+/) : [];
		const command = rawGatewayCommand ? gatewayParts[0] : "npx";
		const args = rawGatewayCommand ? gatewayParts.slice(1) : ["--yes", "tdai-memory-gateway"];
		const childEnv = {
			...process.env,
			TDAI_GATEWAY_PORT: String(port),
			TDAI_CC_PID: String(ccPid),
			TDAI_TOKEN_PATH: tokenPath,
			TDAI_DATA_DIR: process.env.TDAI_DATA_DIR ?? this.dataDir
		};
		delete childEnv.TDAI_GATEWAY_TOKEN;
		await mkdir(this.dataDir, { recursive: true });
		const logPath = join(this.dataDir, "daemon.log");
		let logFd = "ignore";
		try {
			logFd = openSync(logPath, "a");
		} catch {}
		const child = spawn(command, args, {
			env: childEnv,
			cwd: this.dataDir,
			shell: process.platform === "win32",
			detached: true,
			windowsHide: true,
			stdio: [
				"ignore",
				logFd,
				logFd
			]
		});
		child.unref();
		if (!child.pid) throw new Error("Failed to spawn daemon: child has no pid");
		const pendingState = {
			pid: child.pid,
			port,
			ccPid,
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			tokenPath
		};
		await writeDaemonState(this.dataDir, pendingState);
		const deadline = Date.now() + 3e4;
		while (Date.now() < deadline) {
			if (await this.healthCheck(port, token, 500)) return pendingState;
			await sleep(200);
		}
		await clearDaemonState(this.dataDir);
		throw new Error(`Daemon did not become healthy on port ${port} within 30s`);
	}
};
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
/**
* Find the plugins `data` root by walking up from the script path.
*
* An ancestor qualifies when `<ancestor>/data` exists AND contains at least
* one entry whose name starts with the plugin name. Requiring one of OUR dirs
* avoids latching onto some unrelated `data/` folder that happens to sit on
* the path (e.g. a repo checkout with its own `data/`).
*/
function findPluginsDataRoot(scriptPath) {
	let cur = dirname(scriptPath);
	const { root } = parse(cur);
	for (let hops = 0; hops < 32; hops++) {
		const candidate = join(cur, "data");
		try {
			if (existsSync(candidate) && statSync(candidate).isDirectory()) {
				if (readdirSync(candidate).some((n) => n.startsWith("tdai-memory"))) return candidate;
			}
		} catch {}
		if (cur === root) break;
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return null;
}
/**
* True for a directory that is an archived copy, not the live store.
*
* WHY THIS MATTERS (found the hard way, 2026-08-23): the live dir's state.json
* was truncated to 0 bytes while the gateway was still running, so it stopped
* being a candidate — and a `*.BACKUP-20260614-pre-reindex` dir, whose stale
* state.json still parsed, won the election. The plugin would then have written
* every new memory into a two-month-old database, silently. A backup must never
* outrank a live directory, whatever their timestamps say.
*/
function isBackupDir(dir) {
	return /\.(BACKUP|bak)[-_.]/i.test(basename(dir));
}
/**
* Enumerate our data dirs under a plugins `data` root, best candidate first.
*
* Order: PID alive, then non-backup, then newest state.json. A backup is kept
* in the list (it may legitimately be the only thing left) but can only win
* when nothing better exists — and the caller is told, via `chosenIsBackup`.
*/
function findOwnDataDirs(dataRoot) {
	let names;
	try {
		names = readdirSync(dataRoot);
	} catch {
		return [];
	}
	const out = [];
	for (const name of names) {
		if (!name.startsWith("tdai-memory")) continue;
		const dir = join(dataRoot, name);
		const statePath = join(dir, "state.json");
		try {
			const mtimeMs = statSync(statePath).mtimeMs;
			const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
			const pid = typeof parsed.pid === "number" ? parsed.pid : 0;
			out.push({
				dir,
				pid,
				mtimeMs,
				isBackup: isBackupDir(dir)
			});
		} catch {}
	}
	out.sort((a, b) => Number(a.isBackup) - Number(b.isBackup) || b.mtimeMs - a.mtimeMs);
	return out;
}
/** True if a process with this PID currently exists (POSIX + Windows). */
function defaultIsPidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}
/**
* Resolve the data dir, reporting HOW it was found.
*
* Order:
*   1. on-disk discovery (authoritative — prefers a dir whose PID is alive);
*   2. `CLAUDE_PLUGIN_DATA`, but only when it is one of OUR dirs (Claude Code
*      injects a single plugin's value into the generic Bash environment, so
*      for skill/slash-command invocations it routinely names another plugin);
*   3. `~/.tdai-memory` — a last resort that means "we are lost". Callers MUST
*      treat `source === "fallback"` as a failure worth shouting about.
*/
function resolveDataDirDetailed(opts) {
	const env = opts.env ?? process.env;
	const home = opts.home ?? homedir();
	const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
	const root = findPluginsDataRoot(opts.scriptPath);
	const candidates = root ? findOwnDataDirs(root) : [];
	if (candidates.length > 0) {
		const alive = candidates.filter((c) => isAlive(c.pid));
		const winner = (alive.length > 0 ? alive : candidates)[0];
		return {
			dir: winner.dir,
			source: "discovered",
			candidates,
			chosenIsBackup: winner.isBackup
		};
	}
	const fromEnv = env.CLAUDE_PLUGIN_DATA;
	if (fromEnv && basename(fromEnv).startsWith("tdai-memory")) return {
		dir: fromEnv,
		source: "env",
		candidates,
		chosenIsBackup: isBackupDir(fromEnv)
	};
	return {
		dir: join(home, ".tdai-memory"),
		source: "fallback",
		candidates,
		chosenIsBackup: false
	};
}
//#endregion
//#region lib/alarm.ts
/**
* NO SILENT FAILURE.
*
* Sinapsys stopped capturing on 2026-08-13 and nobody noticed until 2026-08-22,
* because every failure mode wrote to a log file nobody reads:
*
*   - the gateway was down for 5 days      → "connect ECONNREFUSED" in hook.log
*   - the data dir could not be resolved   → "no daemon, skipped" in hook.log
*   - a capture could be dropped gateway-side with nothing written at all
*
* A log file is not a signal. This module turns a failure into something the
* USER sees, using the only channel Claude Code renders directly to them: the
* `systemMessage` field of a UserPromptSubmit hook.
*
* Because a hook process is short-lived and a failure usually happens in a
* DIFFERENT hook (stop / session-start) than the one that can speak
* (user-prompt-submit), alarms are persisted as a breadcrumb file and drained
* on the next prompt. Nothing is ever lost and nothing is ever silent.
*/
const ALARM_FILE = "alarms.json";
/** Human-facing prefix. Deliberately loud — this is the whole point. */
const PREFIX = "🚨 SINAPSYS";
async function readAlarms(dataDir) {
	try {
		const raw = await readFile(join(dataDir, ALARM_FILE), "utf-8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isAlarmRecord);
	} catch {
		return [];
	}
}
function isAlarmRecord(v) {
	if (!v || typeof v !== "object") return false;
	const o = v;
	return typeof o.code === "string" && typeof o.message === "string";
}
/**
* Record a failure. Never throws: an alarm that crashes the hook would be a
* worse bug than the one it reports.
*
* Repeats of the same code are collapsed into one record with a counter, so a
* gateway that has been down for five days produces one clear line
* ("×512 volte, dal 13/08") instead of five days of noise.
*/
async function raiseAlarm(dataDir, code, message, now = /* @__PURE__ */ new Date()) {
	const iso = now.toISOString();
	try {
		const existing = await readAlarms(dataDir);
		const next = existing.find((a) => a.code === code) ? existing.map((a) => a.code === code ? {
			...a,
			message,
			lastSeen: iso,
			count: a.count + 1
		} : a) : [...existing, {
			code,
			message,
			firstSeen: iso,
			lastSeen: iso,
			count: 1
		}];
		const path = join(dataDir, ALARM_FILE);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(next, null, 1), { mode: 384 });
	} catch {}
	try {
		process.stderr.write(`${PREFIX}: ${message}\n`);
	} catch {}
}
/** Clear a specific alarm once the underlying condition is healthy again. */
async function clearAlarm(dataDir, code) {
	try {
		const existing = await readAlarms(dataDir);
		const next = existing.filter((a) => a.code !== code);
		if (next.length === existing.length) return;
		const path = join(dataDir, ALARM_FILE);
		if (next.length === 0) {
			await rm(path, { force: true });
			return;
		}
		await writeFile(path, JSON.stringify(next, null, 1), { mode: 384 });
	} catch {}
}
/**
* Render pending alarms as a single user-facing line, then clear them.
*
* Returns "" when everything is healthy, so the caller can simply skip the
* `systemMessage` field.
*/
async function drainAlarms(dataDir) {
	const alarms = await readAlarms(dataDir);
	if (alarms.length === 0) return "";
	const parts = alarms.map((a) => {
		const times = a.count > 1 ? ` (×${a.count}, dal ${a.firstSeen.slice(0, 16).replace("T", " ")})` : "";
		return `${a.message}${times}`;
	});
	try {
		await rm(join(dataDir, ALARM_FILE), { force: true });
	} catch {}
	return `${PREFIX} — la memoria NON sta funzionando: ${parts.join(" · ")}`;
}
//#endregion
//#region lib/staleness.ts
/**
* The last tripwire: "memory has a HOLE".
*
* The other alarms fire when something reports an error. This one fires when
* nothing reports anything — the failure mode that actually happened. A hook
* that is never called cannot complain; a gateway that is up but starving
* answers 200 forever. So we compare two independent facts:
*
*   A. the newest message memory has stored     (from /health last_capture_at)
*   B. the newest Claude Code session on disk   (transcript mtimes)
*
* If sessions kept happening well after memory stopped recording, there is a
* hole — regardless of which component broke, or whether it ever said so.
*
* Crucially this does NOT fire during a holiday: with no new sessions, B stops
* advancing too, and the two stay in step.
*/
/** A gap this large between work and memory is a fault, not a lull. */
const STALE_GAP_MS = 1440 * 60 * 1e3;
/** mtime of the most recently written transcript under ~/.claude/projects. */
function newestTranscriptMs(projectsRoot) {
	let newest = 0;
	let dirs;
	try {
		dirs = readdirSync(projectsRoot);
	} catch {
		return 0;
	}
	for (const d of dirs) {
		const dir = join(projectsRoot, d);
		let files;
		try {
			if (!statSync(dir).isDirectory()) continue;
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			try {
				const m = statSync(join(dir, f)).mtimeMs;
				if (m > newest) newest = m;
			} catch {}
		}
	}
	return newest;
}
/**
* Decide whether memory is lagging behind real work.
*
* Unknowns are never treated as faults: a missing `last_capture_at` (old
* gateway, alternative store) or an unreadable projects dir yields `stale:false`.
* A false alarm would train the user to ignore alarms, which is the one thing
* this whole mechanism cannot afford.
*/
function assessStaleness(lastCaptureIso, newestSessionMs, nowMs, gapMs = STALE_GAP_MS) {
	const captureMs = lastCaptureIso ? Date.parse(lastCaptureIso) : NaN;
	if (!Number.isFinite(captureMs) || newestSessionMs <= 0) return {
		stale: false,
		gapMs: 0,
		lastCapture: null,
		lastSession: null
	};
	const session = Math.min(newestSessionMs, nowMs);
	const gap = session - captureMs;
	return {
		stale: gap > gapMs,
		gapMs: Math.max(0, gap),
		lastCapture: new Date(captureMs),
		lastSession: new Date(session)
	};
}
function describeStaleness(v) {
	const days = Math.floor(v.gapMs / (1440 * 60 * 1e3));
	const hours = Math.floor(v.gapMs / (3600 * 1e3)) % 24;
	return `BUCO nella memoria: hai lavorato per ${days > 0 ? `${days} giorni e ${hours} ore` : `${hours} ore`} dopo l'ultimo ricordo salvato (${v.lastCapture ? v.lastCapture.toISOString().slice(0, 16).replace("T", " ") : "mai"})`;
}
//#endregion
//#region lib/destructive-commands.ts
/** Commands whose success is worth remembering. Order = first match wins. */
const DESTRUCTIVE_RULES = [
	{
		label: "git worktree remove",
		pattern: /\bgit\s+worktree\s+remove\b/
	},
	{
		label: "rm -r",
		pattern: /(^|[\s;&|"'(])rm\s+(-[A-Za-z]*[rR][A-Za-z]*\b|--recursive\b)/
	},
	{
		label: "git reset --hard",
		pattern: /\bgit\s+reset\s+(?:[^|&;]*\s)?--hard\b/
	},
	{
		label: "git clean -f",
		pattern: /\bgit\s+clean\b[^|&;]*\s-[A-Za-z]*f[A-Za-z]*\b/
	},
	{
		label: "git push --force",
		pattern: /\bgit\s+push\b[^|&;]*\s(?:--force(?:-with-lease)?\b|-f\b)/
	},
	{
		label: "git branch -D",
		pattern: /\bgit\s+branch\s+(?:[^|&;]*\s)?-D\b/
	},
	{
		label: "DROP TABLE",
		pattern: /\bdrop\s+table\b/i
	},
	{
		label: "TRUNCATE",
		pattern: /\btruncate\b/i
	},
	{
		label: "del /s",
		pattern: /(^|[\s;&|"'(])del\s+(?:\/[a-z]\s+)*\/s\b/i
	},
	{
		label: "Remove-Item -Recurse",
		pattern: /\bremove-item\b[^|&;]*\s-recurse\b/i
	},
	{
		label: "format <drive>",
		pattern: /(^|[\s;&|"'(])format\s+[a-z]:/i
	}
];
/**
* Returns the label of the first destructive rule matching `command`, or null
* when the command is not on the list.
*/
function matchDestructiveCommand(command) {
	if (typeof command !== "string" || !command.trim()) return null;
	for (const rule of DESTRUCTIVE_RULES) if (rule.pattern.test(command)) return rule.label;
	return null;
}
//#endregion
//#region lib/hook.ts
/**
* Unified hook entry point. Dispatched by the first CLI arg.
*
* Usage from cc plugin hook config:
*   node ${CLAUDE_PLUGIN_ROOT}/dist/lib/hook.mjs <event-name>
*
* Where <event-name> is one of:
*   session-start | user-prompt-submit | post-tool-use | post-tool-use-failure |
*   stop | search | search-stdin | status | clear-session | confirm | reject
*/
const MAX_INJECT_CHARS = 1e4;
const MAX_CAPTURE_TURNS = 50;
async function handleHook(event, input) {
	const data = parseStdin(input.stdin);
	const dataDir = input.dataDir ?? resolveDataDir();
	switch (event) {
		case "session-start": return handleSessionStart(data, input.client, dataDir);
		case "user-prompt-submit": return handleUserPromptSubmit(data, input.client, dataDir);
		case "post-tool-use": return handlePostToolUse(data, input.client);
		case "post-tool-use-failure": return handlePostToolUseFailure(data, input.client);
		case "stop": return handleStop(data, input.client, dataDir);
		case "search": return handleSearch(input.args ?? [], input.client);
		case "search-stdin": return handleSearchStdin(input.stdin, input.client);
		case "status": return handleStatus(input.client);
		case "clear-session": return handleClearSession(data, input.client);
		case "confirm": return handleResolveGatedMemory("confirm", input.stdin, input.client);
		case "reject": return handleResolveGatedMemory("reject", input.stdin, input.client);
		default: return "";
	}
}
function parseStdin(raw) {
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}
async function handleSessionStart(_data, client, dataDir) {
	const health = await client.healthDetailed();
	if (!health) {
		await raiseAlarm(dataDir, "gateway-unreachable", "il gateway non risponde — NULLA viene salvato in memoria");
		return "";
	}
	await clearAlarm(dataDir, "gateway-unreachable");
	if (health.status === "degraded" || health.embedding === "failing") await raiseAlarm(dataDir, "memory-degraded", "l'embedder non risponde bene — la memoria funziona ma richiama peggio");
	else await clearAlarm(dataDir, "memory-degraded");
	const verdict = assessStaleness(health.last_capture_at, newestTranscriptMs(join(homedir(), ".claude", "projects")), Date.now());
	if (verdict.stale) await raiseAlarm(dataDir, "memory-stale", describeStaleness(verdict));
	else await clearAlarm(dataDir, "memory-stale");
	return "";
}
async function handleUserPromptSubmit(data, client, dataDir) {
	const prompt = data.prompt ?? "";
	const cwd = data.cwd ?? process.cwd();
	const alarmLine = await drainAlarms(dataDir);
	if (!prompt) return alarmLine ? JSON.stringify({ systemMessage: alarmLine }) : "";
	const sessionKey = getSessionKey(cwd);
	const project = getProjectName(cwd);
	let context = (await client.recall(prompt, sessionKey, project, data.session_id)).context ?? "";
	if (!context) {
		const conv = await client.searchConversations(prompt, {
			limit: 3,
			sessionKey
		});
		if (conv.total > 0 && conv.results) context = `## Past conversations (relevant to current prompt)\n\n${conv.results}`;
	}
	if (!context) {
		const dataDir = process.env.TDAI_DATA_DIR;
		if (dataDir) context = await searchL0JsonlDirect(join(dataDir, "conversations"), prompt, sessionKey, 3);
	}
	if (!context) return alarmLine ? JSON.stringify({ systemMessage: alarmLine }) : "";
	const bannerMatch = context.match(/<session-open-banner>[\s\S]*?<\/session-open-banner>/);
	const bannerLine = bannerMatch ? bannerMatch[0].split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("<") && !s.startsWith("FIRST TURN"))[0] ?? "" : "";
	if (context.length > MAX_INJECT_CHARS) context = context.slice(0, MAX_INJECT_CHARS - 100) + "\n\n[…recall truncated — use /memory-search for full results…]";
	const out = { hookSpecificOutput: {
		hookEventName: "UserPromptSubmit",
		additionalContext: context
	} };
	const message = alarmLine || bannerLine;
	if (message) out.systemMessage = message;
	return JSON.stringify(out);
}
/** Max characters of failed-tool output forwarded to the gateway. */
const MAX_TOOL_OUTPUT_CHARS = 2e3;
/**
* Best-effort stringification of a tool result for friction capture. Returns
* undefined when there is nothing usable — the caller then sends nothing and
* behaviour is exactly as before.
*/
function stringifyToolOutput(resp, maxChars = MAX_TOOL_OUTPUT_CHARS) {
	if (resp == null) return void 0;
	let text;
	if (typeof resp === "string") text = resp;
	else if (resp instanceof Error) text = resp.message;
	else try {
		text = JSON.stringify(resp) ?? "";
	} catch {
		return;
	}
	text = text.trim();
	if (!text) return void 0;
	return text.length > maxChars ? text.slice(0, maxChars) : text;
}
/** Max characters of a SUCCESSFUL destructive command's output forwarded. */
const MAX_DESTRUCTIVE_OUTPUT_CHARS = 400;
async function handlePostToolUse(data, client) {
	const toolName = data.tool_name ?? "";
	if (!toolName) return "";
	const sessionKey = getSessionKey(data.cwd ?? process.cwd());
	let toolOutputText = data.tool_output_is_error === true ? stringifyToolOutput(data.tool_response) : void 0;
	const toolRisk = (toolName === "Bash" && data.tool_output_is_error !== true ? matchDestructiveCommand(data.tool_input?.command) : null) ? "destructive" : void 0;
	if (toolRisk && toolOutputText === void 0) toolOutputText = stringifyToolOutput(data.tool_response, MAX_DESTRUCTIVE_OUTPUT_CHARS);
	let context = await client.observe({
		toolName,
		sessionKey,
		toolInput: data.tool_input,
		toolOutputIsError: data.tool_output_is_error,
		toolOutputText,
		toolRisk
	});
	if (!context) return "";
	if (context.length > MAX_INJECT_CHARS) context = context.slice(0, MAX_INJECT_CHARS - 100) + "\n\n[…truncated…]";
	return JSON.stringify({ hookSpecificOutput: {
		hookEventName: "PostToolUse",
		additionalContext: context
	} });
}
/**
* PostToolUseFailure (Claude Code >= 2.1): the host reports a failed tool call
* on its own event with an `error` field instead of `tool_output_is_error` on
* PostToolUse. Forward it as a failed observation so friction capture finally
* fires live (it produced ZERO events in its first 29 days because nothing
* ever subscribed to this event). A user interrupt is not friction: skip it.
*/
async function handlePostToolUseFailure(data, client) {
	const toolName = data.tool_name ?? "";
	if (!toolName) return "";
	if (data.is_interrupt === true) return "";
	const sessionKey = getSessionKey(data.cwd ?? process.cwd());
	const toolOutputText = stringifyToolOutput(data.error) ?? (data.error_type ? String(data.error_type) : void 0);
	let context = await client.observe({
		toolName,
		sessionKey,
		toolInput: data.tool_input,
		toolOutputIsError: true,
		toolOutputText
	});
	if (!context) return "";
	if (context.length > MAX_INJECT_CHARS) context = context.slice(0, MAX_INJECT_CHARS - 100) + "\n\n[…truncated…]";
	return JSON.stringify({ hookSpecificOutput: {
		hookEventName: "PostToolUseFailure",
		additionalContext: context
	} });
}
async function handleStop(data, client, dataDirIn) {
	if (data.stop_hook_active === true) return "";
	if (!data.transcript_path) return "";
	await waitForTranscriptStable(data.transcript_path, 2e3);
	const allTurns = await readAllTurns(data.transcript_path);
	if (allTurns.length === 0) {
		await safeLog(join(dataDirIn, "hook.log"), `stop: 0 turni leggibili da ${data.transcript_path} — niente da salvare`);
		return "";
	}
	const dataDir = dataDirIn;
	const cursorId = sanitizeCursorId(data.session_id ?? (basename(data.transcript_path).replace(/\.jsonl$/, "") || "default"));
	const lastSent = await readCursor(dataDir, cursorId);
	let newTurns = allTurns.slice(lastSent);
	if (newTurns.length === 0) {
		await safeLog(join(dataDirIn, "hook.log"), `stop: nessun turno nuovo (${allTurns.length} totali, cursore a ${lastSent})`);
		return "";
	}
	if (newTurns.length > MAX_CAPTURE_TURNS) newTurns = newTurns.slice(-MAX_CAPTURE_TURNS);
	const sessionKey = getSessionKey(data.cwd ?? process.cwd());
	const messages = newTurns.flatMap((t) => [{
		role: "user",
		content: t.user
	}, {
		role: "assistant",
		content: t.assistant
	}]);
	const lastTurn = newTurns[newTurns.length - 1];
	const captureResult = await client.captureTurn({
		user_content: lastTurn.user,
		assistant_content: lastTurn.assistant,
		messages,
		session_key: sessionKey,
		session_id: data.session_id
	});
	if (captureResult === null) {
		await raiseAlarm(dataDir, "capture-failed", `sessione NON salvata (${newTurns.length} turni persi) — gateway giù o token scaduto`);
		await safeLog(join(dataDir, "hook.log"), "stop: captureTurn failed after retry — session not saved");
		return "";
	}
	if (captureResult.l0_recorded === 0) {
		await raiseAlarm(dataDir, "capture-empty", `il gateway ha risposto OK ma non ha scritto nulla (${newTurns.length} turni)`);
		return "";
	}
	await clearAlarm(dataDir, "capture-failed");
	await clearAlarm(dataDir, "capture-empty");
	await writeCursor(dataDir, cursorId, allTurns.length);
	await safeLog(join(dataDir, "hook.log"), `stop: salvati ${captureResult.l0_recorded} messaggi (${newTurns.length} turni) — cursore ${lastSent}→${allTurns.length}`);
	return "";
}
async function waitForTranscriptStable(path, maxMs) {
	const start = Date.now();
	let lastSize = -1;
	let stableTicks = 0;
	while (Date.now() - start < maxMs) {
		try {
			const st = await stat(path);
			if (st.size === lastSize) {
				stableTicks++;
				if (stableTicks >= 2) return;
			} else {
				stableTicks = 0;
				lastSize = st.size;
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
}
/**
* Resolve the gateway data directory. See ./data-dir.ts for the full story —
* in short, this used to count `..` hops and broke the day Claude Code changed
* the plugin install layout, which silently stopped capture for 10 days.
*/
function resolveDataDirWithSource() {
	let scriptPath;
	try {
		scriptPath = fileURLToPath(import.meta.url);
	} catch {
		scriptPath = process.argv[1] ?? "";
	}
	const res = resolveDataDirDetailed({ scriptPath });
	return {
		dir: res.dir,
		source: res.source,
		isBackup: res.chosenIsBackup
	};
}
function resolveDataDir() {
	return resolveDataDirWithSource().dir;
}
function sanitizeCursorId(id) {
	return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "default";
}
async function readCursor(dataDir, cursorId) {
	try {
		const raw = await readFile(join(dataDir, "cursors", `${cursorId}.json`), "utf-8");
		const obj = JSON.parse(raw);
		return typeof obj.lastSentIndex === "number" && obj.lastSentIndex >= 0 ? obj.lastSentIndex : 0;
	} catch {
		return 0;
	}
}
async function writeCursor(dataDir, cursorId, lastSentIndex) {
	const dir = join(dataDir, "cursors");
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `${cursorId}.json.tmp`);
	const final = join(dir, `${cursorId}.json`);
	await writeFile(tmp, JSON.stringify({
		lastSentIndex,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	}), { mode: 384 });
	await rename(tmp, final);
}
async function handleSearch(args, client) {
	const query = args.join(" ").trim();
	if (!query) return "Usage: /memory-search <query>";
	return (await client.searchMemories(query, { limit: 10 })).results || "No memories found.";
}
/**
* Read the query from stdin instead of argv. Used by the memory-search skill
* to avoid the cc `$ARGUMENTS` literal-replaceAll RCE surface (see Anthropic
* GH issue #16163) — when the query rides on stdin it never touches a shell
* word-split or expansion stage.
*/
async function handleSearchStdin(rawStdin, client) {
	const query = rawStdin.trim();
	if (!query) return "Usage: pipe the query to stdin";
	return (await client.searchMemories(query, { limit: 10 })).results || "No memories found.";
}
/**
* Confirm / reject a gated (grounded-trust) memory from Claude Code. The owner
* id rides on stdin for the same reason as search-stdin: `$ARGUMENTS` is a
* literal replaceAll in cc, so an id on argv would be a command-injection
* surface. `owner_kind` is inferred from the id prefix the store uses
* (`fact_…` / `event_…`); anything else is refused with a clear message —
* exit code stays 0 so the skill output is rendered, not swallowed.
*/
async function handleResolveGatedMemory(decision, rawStdin, client) {
	const ownerId = rawStdin.trim();
	if (!ownerId) return `Usage: pipe the memory id (fact_… or event_…) to stdin for /memory-${decision}`;
	const ownerKind = inferOwnerKind(ownerId);
	if (!ownerKind) return `Cannot ${decision} "${ownerId}": the id must start with "fact_" or "event_" (copy it from the memory prompt).`;
	const res = await client.resolveGatedMemory(decision, ownerId, ownerKind);
	if (!res) return `Memory gateway unreachable — ${decision} of ${ownerId} NOT applied. Try /memory-status.`;
	return res.text || (res.ok ? `${decision} applied to ${ownerId}` : `${decision} NOT applied to ${ownerId}`);
}
/** Owner kind from the id prefix the store uses; null when unrecognised. */
function inferOwnerKind(ownerId) {
	if (/^fact_[A-Za-z0-9]+$/.test(ownerId)) return "fact";
	if (/^event_[A-Za-z0-9]+$/.test(ownerId)) return "event";
	return null;
}
async function handleStatus(client) {
	const ok = await client.health();
	const dataDir = resolveDataDir();
	const hookLog = join(dataDir, "hook.log");
	const daemonLog = join(dataDir, "daemon.log");
	return `${ok ? "TDAI memory daemon: healthy" : "TDAI memory daemon: unreachable"}\nhook log:   ${hookLog}\ndaemon log: ${daemonLog}`;
}
async function handleClearSession(data, client) {
	const sessionKey = getSessionKey(data.cwd ?? process.cwd());
	await client.sessionEnd(sessionKey);
	return `Cleared session buffer for: ${sessionKey}`;
}
async function searchL0JsonlDirect(convDir, query, sessionKey, limit) {
	let files;
	try {
		files = (await readdir(convDir)).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return "";
	}
	if (files.length === 0) return "";
	const withMtime = await Promise.all(files.map(async (f) => {
		try {
			return {
				name: f,
				mtime: (await stat(join(convDir, f))).mtimeMs
			};
		} catch {
			return {
				name: f,
				mtime: 0
			};
		}
	}));
	withMtime.sort((a, b) => b.mtime - a.mtime);
	const sortedFiles = withMtime.map((e) => e.name);
	const CJK_STOP = new Set([
		"之前",
		"前聊",
		"聊的",
		"还记",
		"记得",
		"得么",
		"得吗",
		"一下",
		"怎么",
		"什么",
		"关于",
		"知道",
		"以前",
		"上次",
		"如何",
		"为何",
		"为啥",
		"哪里",
		"哪些",
		"为什",
		"请问",
		"请帮",
		"帮我",
		"麻烦"
	]);
	const keywords = [];
	for (const seg of query.toLowerCase().replace(/[^\w一-鿿]/g, " ").split(/\s+/)) {
		if (!seg) continue;
		if (/[一-鿿]/.test(seg)) for (let i = 0; i <= seg.length - 2; i++) {
			const gram = seg.slice(i, i + 2);
			if (!CJK_STOP.has(gram)) keywords.push(gram);
		}
		else if (seg.length >= 2) keywords.push(seg);
	}
	if (keywords.length === 0) return "";
	const matches = [];
	const seen = /* @__PURE__ */ new Set();
	for (const f of sortedFiles) {
		let rl;
		try {
			rl = createInterface({
				input: createReadStream(join(convDir, f), { encoding: "utf-8" }),
				crlfDelay: Infinity
			});
		} catch {
			continue;
		}
		try {
			for await (const line of rl) {
				if (!line.trim()) continue;
				try {
					const rec = JSON.parse(line);
					if (rec.sessionKey !== sessionKey) continue;
					const text = rec.content ?? "";
					const textLower = text.toLowerCase();
					const hits = keywords.filter((kw) => textLower.includes(kw)).length;
					if (hits === 0) continue;
					const fingerprint = text.slice(0, 120);
					if (seen.has(fingerprint)) continue;
					seen.add(fingerprint);
					matches.push({
						role: rec.role ?? "unknown",
						content: text.length > 2e3 ? text.slice(0, 2e3) + "…" : text,
						recordedAt: rec.recordedAt ?? "",
						hits
					});
				} catch {}
			}
		} finally {
			rl.close();
		}
	}
	if (matches.length === 0) return "";
	const rolePriority = (r) => r === "assistant" ? 1 : 0;
	matches.sort((a, b) => rolePriority(b.role) - rolePriority(a.role) || b.hits - a.hits || b.content.length - a.content.length);
	const selected = matches.slice(0, limit);
	const lines = [`Found ${selected.length} matching conversation(s):`, ""];
	for (const m of selected) {
		lines.push("---");
		lines.push(`**[${m.role}]** ${m.recordedAt}`);
		lines.push("");
		lines.push(m.content);
		lines.push("");
	}
	return `## Past conversations (relevant to current prompt)\n\n${lines.join("\n")}`;
}
async function main() {
	const event = process.argv[2] ?? "";
	const args = process.argv.slice(3);
	const { dir: dataDir, source: dataDirSource, isBackup: dataDirIsBackup } = resolveDataDirWithSource();
	const logPath = join(dataDir, "hook.log");
	if (dataDirSource === "fallback") await raiseAlarm(dataDir, "data-dir-lost", "il plugin non trova la cartella del gateway — cattura e recall SPENTI");
	else await clearAlarm(dataDir, "data-dir-lost");
	if (dataDirIsBackup) await raiseAlarm(dataDir, "writing-to-backup", "la memoria sta puntando a una cartella di BACKUP — i nuovi ricordi finirebbero in un archivio vecchio");
	else await clearAlarm(dataDir, "writing-to-backup");
	try {
		const stdin = await readStdin();
		const mgr = new DaemonManager({ dataDir });
		let state = await readDaemonState(dataDir);
		if (event === "session-start") {
			if (state && state.ccPid > 0 && !await mgr.probe()) {
				await safeLog(logPath, `session-start: stale daemon state (pid=${state.pid} port=${state.port}) unreachable — clearing and respawning`);
				await clearDaemonState(dataDir);
				state = null;
			}
			if (!state) try {
				state = await mgr.ensureRunning(process.ppid);
			} catch (err) {
				await safeLog(logPath, `session-start: spawn failed: ${err.message}`);
			}
		}
		if (!state) {
			await safeLog(logPath, `${event}: no daemon, skipped`);
			if (event !== "user-prompt-submit") await raiseAlarm(dataDir, "gateway-unreachable", "nessun gateway attivo — la sessione NON viene salvata");
			else {
				const msg = await drainAlarms(dataDir) || "🚨 SINAPSYS — la memoria NON sta funzionando: nessun gateway attivo";
				process.stdout.write(JSON.stringify({ systemMessage: msg }));
			}
			return;
		}
		const token = await mgr.readToken(state.tokenPath);
		const out = await handleHook(event, {
			stdin,
			client: new GatewayClient({
				baseUrl: `http://127.0.0.1:${state.port}`,
				token,
				timeoutMs: event === "user-prompt-submit" ? RECALL_TIMEOUT_MS : CAPTURE_TIMEOUT_MS,
				logPath,
				tokenPath: state.tokenPath
			}),
			args,
			dataDir
		});
		if (out) process.stdout.write(out);
	} catch (err) {
		await safeLog(logPath, `${event}: ${err.message}`);
		await reportHookCrash(dataDir, event, err);
		if (event === "user-prompt-submit") try {
			const line = await drainAlarms(dataDir);
			if (line) process.stdout.write(JSON.stringify({ systemMessage: line }));
		} catch {}
	}
}
/** Max chars of an error message forwarded to the user-facing alarm. */
const MAX_CRASH_MESSAGE_CHARS = 200;
/**
* Turn an unexpected exception into a signal Lorenzo actually sees.
* Never throws: reporting a failure must not become one.
*/
async function reportHookCrash(dataDir, event, err) {
	await raiseAlarm(dataDir, "hook-crashed", `la memoria si è fermata con un errore (${event}) — nulla viene salvato né richiamato: ${(err instanceof Error ? err.message : String(err)).slice(0, MAX_CRASH_MESSAGE_CHARS)}`);
}
function readStdin() {
	return new Promise((resolve) => {
		if (process.stdin.isTTY) {
			resolve("");
			return;
		}
		const chunks = [];
		process.stdin.on("data", (c) => chunks.push(c));
		process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		process.stdin.on("error", () => resolve(""));
	});
}
async function safeLog(path, msg) {
	try {
		await appendFile(path, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}\n`);
	} catch {}
}
if (!!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => process.exit(0));
//#endregion
export { handleHook, inferOwnerKind, reportHookCrash };

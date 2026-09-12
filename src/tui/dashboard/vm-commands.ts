/**
 * The dashboard's operator-command sender (28i): one-shot request/response over
 * the status socket's command intake (status-socket.ts's `deps.commands`). The
 * dashboard spawns the server as a CHILD process, so no production dashboard
 * ever holds the `VmService` handle — these socket commands ARE the production
 * Sandbox Stop/Restart path: `{"cmd":"vm-stop"}` / `{"cmd":"vm-restart"}`, one
 * `vm-cmd-result` line back. Works for a spawn-owned dashboard and an attached
 * one alike: the same loopback socket, the same 0600 same-user trust boundary.
 *
 * **Accepted, not completed.** The reply says the server KICKED the command
 * off; progress is the vm-state feed the command's transitions emit (27h),
 * which the dashboard's live `subscribe` already renders. Nothing here polls.
 *
 * **Never throws.** Every failure — no socket (the server is down), an
 * unreachable or OLDER server without the command intake, a refusal, a
 * timeout — resolves `err` with an actionable message the Sandbox screen
 * flashes inline. The 3s timeout names the likely cause explicitly.
 *
 * **Connection seam (injectable)** — the socket-client.ts precedent: tests
 * inject a scripted connection; the default is a real `net.createConnection`
 * adapter. A fresh connection per command (no shared stream state), destroyed
 * once the reply lands.
 */
import { createConnection } from "node:net";
import { parseVmCmdResultLine, statusSocketPath, type VmCommandName } from "../../observability/status-socket.ts";
import { err, ok, type Result } from "../../tools/result.ts";

/**
 * The minimal connection surface the command sender needs — socket-client.ts's
 * `SocketConnection` plus `write` (this client SENDS, which the read-only feed
 * never does). `net.Socket` satisfies it via the default adapter.
 */
export interface VmCommandConnection {
	write(chunk: string): void;
	onData(listener: (chunk: Buffer) => void): void;
	onError(listener: (err: Error) => void): void;
	onClose(listener: () => void): void;
	destroy(): void;
}

/** Injection seams for {@link sendVmCommand} (the socket-client precedent). */
export interface SendVmCommandDeps {
	/** Override the socket path (tests use a temp path). Defaults to {@link statusSocketPath}. */
	path?: string;
	/** Connection factory (tests inject a scripted fake). Defaults to the real adapter. */
	connect?: (path: string) => VmCommandConnection;
	/** How long to wait for the server's reply. Default 3000ms. */
	timeoutMs?: number;
}

/** The default connection: a real Unix-domain-socket client (the feed's adapter + write). */
export function connectVmCommandSocket(path: string): VmCommandConnection {
	const socket = createConnection(path);
	return {
		write: (chunk) => void socket.write(chunk),
		onData: (cb) => void socket.on("data", cb),
		onError: (cb) => void socket.on("error", cb),
		onClose: (cb) => void socket.on("close", cb),
		destroy: () => void socket.destroy(),
	};
}

/** The timeout's message — the one diagnostic a reply-less (older-server) connection needs. */
export const VM_COMMAND_TIMEOUT_MESSAGE =
	"the server did not answer (is it an older openhammer? restart it to gain sandbox control)";

/** Narrow an unknown catch/error value to its message (AGENTS.md: `catch` is `unknown`). */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Send one operator command and await its `vm-cmd-result` reply. Resolves `ok`
 * when the server accepted (kicked off) the command; `err` with the refusal's
 * verbatim message when it refused; an actionable diagnostic when the socket
 * is missing/unreachable, closes before answering, or stays silent past the
 * timeout. Never rejects. Other line kinds on the stream (request events,
 * state lines) are skipped — the additive-parse posture.
 */
export function sendVmCommand(cmd: VmCommandName, deps: SendVmCommandDeps = {}): Promise<Result<void, Error>> {
	const path = deps.path ?? statusSocketPath();
	const connect = deps.connect ?? connectVmCommandSocket;
	const timeoutMs = deps.timeoutMs ?? 3_000;
	return new Promise((resolve) => {
		let settled = false;
		let conn: VmCommandConnection | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let buf = "";
		const finish = (result: Result<void, Error>): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			conn?.destroy();
			resolve(result);
		};
		timer = setTimeout(() => finish(err(new Error(VM_COMMAND_TIMEOUT_MESSAGE))), timeoutMs);
		try {
			conn = connect(path);
		} catch (e) {
			finish(err(new Error(`cannot reach the server's control socket: ${messageOf(e)}`)));
			return;
		}
		conn.onData((chunk) => {
			buf += chunk.toString("utf8");
			// NDJSON: a chunk may split a line or carry many. Only OUR command's
			// result line settles this — everything else (the event/state dump a
			// connect always delivers first, echoes of other verbs) is skipped.
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
				const result = parseVmCmdResultLine(line);
				if (result === null || result.cmd !== cmd) continue;
				finish(result.ok ? ok(undefined) : err(new Error(result.error ?? `the server refused ${result.cmd}`)));
				return;
			}
		});
		conn.onError((e) => {
			finish(err(new Error(`cannot reach the server's control socket: ${messageOf(e)}`)));
		});
		conn.onClose(() => {
			finish(err(new Error("the server closed the control connection without answering")));
		});
		conn.write(`${JSON.stringify({ cmd })}\n`);
	});
}

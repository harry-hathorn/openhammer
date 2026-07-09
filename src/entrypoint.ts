import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when `argv1` is this module running as the process entrypoint (not when
 * imported by a test or another module). npm installs the `openhammer` bin as a
 * **symlink**, so `process.argv[1]` is the symlink path while `import.meta.url`
 * is the resolved real file — without `realpathSync` the two never compare equal
 * and the installed binary silently exits 0 on every command (no dispatch). The
 * `try/catch` preserves the historical guard semantics: a missing or odd `argv1`
 * resolves to "not the entrypoint" instead of throwing at module load.
 */
export function isMainEntry(argv1: string | undefined, moduleUrl: string): boolean {
	if (typeof argv1 !== "string") return false;
	try {
		return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
	} catch {
		return false;
	}
}

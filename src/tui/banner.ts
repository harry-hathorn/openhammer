/**
 * The OpenHammer ASCII banner.
 *
 * A byte-for-byte mirror of the README's first text-fenced code block
 * (README lines 1–22). README is the single source of truth; the co-located
 * banner.test.ts re-extracts that block and asserts byte-equality, refusing
 * drift. If the banner ever changes, update README first, then regenerate this
 * constant from it (it is JSON-escaped, so every byte survives verbatim).
 */
export const BANNER: string =
	"                                         ████████\n                                         ██╳╳╳╳██\n                                         ██╳╳╳╳██\n                                         ██╳╳╳╳██\n                                         ██╳╳╳╳██\n                                         ████████\n                            ██████████████████████████████████\n                            ██╔════════════════════════════╗██\n                            ██║                            ║██\n                            ██║   ᚦ   ᛟ   ᚱ   ᛞ   ᚱ   ᛟ    ║██\n                            ██║                            ║██\n                            ██╚════════════════════════════╝██\n                            ██████████████████████████████████\n\n ██████╗ ██████╗ ███████╗███╗   ██╗██╗  ██╗ █████╗ ███╗   ███╗███╗   ███╗███████╗██████╗\n██╔═══██╗██╔══██╗██╔════╝████╗  ██║██║  ██║██╔══██╗████╗ ████║████╗ ████║██╔════╝██╔══██╗\n██║   ██║██████╔╝█████╗  ██╔██╗ ██║███████║███████║██╔████╔██║██╔████╔██║█████╗  ██████╔╝\n██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██╔══██║██╔══██║██║╚██╔╝██║██║╚██╔╝██║██╔══╝  ██╔══██╗\n╚██████╔╝██║     ███████╗██║ ╚████║██║  ██║██║  ██║██║ ╚═╝ ██║██║ ╚═╝ ██║███████╗██║  ██║\n ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝";

/**
 * Minimal writable surface printBanner needs; process.stdout satisfies this.
 */
export interface BannerStream {
	write(chunk: string | Uint8Array): boolean;
}

/**
 * Write the banner to `stream` (default `process.stdout`), followed by a
 * trailing newline so subsequent output starts on a fresh line.
 */
export function printBanner(stream: BannerStream = process.stdout): void {
	stream.write(`${BANNER}\n`);
}

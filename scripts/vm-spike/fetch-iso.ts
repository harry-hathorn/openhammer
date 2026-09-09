// Standalone pinned-ISO fetch: `SPIKE_DIR=... npx tsx scripts/vm-spike/fetch-iso.ts`.
// Exists so the multi-GB download can run (and be polled) separately from a boot.
import { ensureIso } from "./iso.ts";
import { openSpikeDirs } from "./scratch.ts";

const dirs = openSpikeDirs();
const iso = await ensureIso(dirs);
console.log(`iso ready: ${iso.path} action=${iso.action} size=${iso.size} sha256=${iso.sha256}`);

  Openhammer test notes (since that was the point)

  Two things worth flagging from driving it hard:
  1. mcp__openhammer__bash resets to its server root (/home/haz/source/openhammer) on every
  call — cwd does not persist. My first mkdir Vanta/src landed inside openhammer's own repo by
  mistake; I caught it, removed it, and switched to absolute paths for everything after.
  2. ls/pwd/write all behaved as expected, and parallel write calls in a single message worked
  fine.

  One thing I couldn't do through openhammer: take a screenshot to eyeball the design — there's
  no screenshot tool on that server. If you want, I can boot it in the background on a fixed
  port so you can open it in a browser, or write a quick Playwright capture.

✻ Sautéed for 10m 41s

❯ when you uuse your native write tool does it remember where you are?

  Thought for 1m 1s (ctrl+o to expand)

● Short answer: yes — differently, and more reliably than openhammer. Here's the real
  distinction:

  Native tools (Read / Write / Edit / Bash)
  - Anchored to my session working directory, which is /home/haz/scratchpad.
  - Native Bash persists its cwd between calls — a cd in one call sticks for the next
  (openhammer's does not).
  - Native Write/Read require absolute paths, so there's no ambiguity — the file lands exactly
  where the path says.

  openhammer tools
  - Pinned to the server's own root (/home/haz/source/openhammer), regardless of my session
  cwd.
  - Resets to that root on every call — cd only lives inside a single command. That's exactly
  why mkdir Vanta/src slipped into openhammer's repo instead of /home/haz/source.

  One extra wrinkle worth flagging: the directory you actually wanted — /home/haz/source/Vanta
  — is neither openhammer's root nor my session cwd (/home/haz/scratchpad). So even with native
  tools, a relative path would have dropped it in /home/haz/scratchpad, also wrong. That's why
  I switched to absolute paths for everything. Absolute paths are the only thing both toolsets
  honor identically.

  So if I'd used native Write with an absolute path, it would've gone to the right place on the
  first try, and native Bash would've remembered the cd. The cost of the openhammer test was
  catching that root-reset behavior — which we did.

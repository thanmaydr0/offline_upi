# RULES (every Codex session must follow)

1. BRANCHING: work only on `main`. Never create/switch branches or worktrees. Never force-push, reset --hard, stash, rebase others' work away, or `git add -A` / `git commit -a`. Stage ONLY the paths you own (SPEC section 9): `git add <your paths>` then `git commit -m "<id>: message" -- <your paths>`. If a remote exists: `git pull --rebase origin main` before `git push origin main`. If a git lock exists, wait and retry. Commit small and often.
2. OWNERSHIP: edit only files in your owned paths (SPEC section 9). If you need a change elsewhere, do NOT edit it; write the request to docs/handoff/<your-id>.md and mention it in your final message.
3. DEPENDENCIES: P0 installed everything. Do not add dependencies unless truly necessary. If you must, install only into your own workspace (`npm install <pkg> -w <workspace>`; mobile: `cd mobile && npx expo install <pkg>`). If a new dependency is a NATIVE module in mobile, STOP and tell the user it forces a new EAS dev build (limited quota) and ask before proceeding.
4. FINAL MESSAGE FORMAT (always, exactly these headings):
   ## DONE  (what you built, files/dirs, how to run it, test results)
   ## MANUAL STEPS FOR YOU  (numbered; exact commands; things an AI cannot do: logins, faucets, keys, installing APK, phone toggles. Write "None" if none.) Also save this section to docs/manual/<your-id>.md
   ## NEXT  (which prompts are now unblocked and which can run in parallel)
   ## HANDOFF REQUESTS  (anything you needed from files you do not own, or "None")
5. TESTING: run tests, typecheck and lint for your area before finishing. Never commit failing tests or type errors.
6. SECRETS: never commit secrets. Use .env (ignored) and .env.example (placeholders only). Never log private keys, signatures of secrets, or tokens.
7. MONEY: integers only (bigint / paise). No floating point for money, ever.
8. SECURITY: validate all external input with zod. TypeScript strict. No `any` without a comment.
9. HONESTY: do not claim hardware guarantees that are not implemented. If a security feature is best-effort, say so in code comments and docs.
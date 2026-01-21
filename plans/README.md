# Claude Mobile Bridge - Development Plan

## What Changed

Your PRD has been completely revised with a **test-first, Ralph-optimized approach**.

### Before (Manual Testing)
- 17 tasks, mostly manual verification
- "Send message to bot and check..."
- Not repeatable
- No lasting value
- Hard for Ralph to verify

### After (Automated Testing)
- 14 tasks, mostly automated tests
- Unit tests for every component
- CI integration
- 80%+ coverage requirement
- Ralph can verify automatically

## PRD Structure

### Phase 1: Refactoring (1 task)
**flatten-monorepo** - One big refactoring task to flatten the structure
- Combines all the file moves, config merges, import updates
- Makes sense as one atomic operation
- Review this one carefully!

### Phase 2: Testing (9 tasks)
Independent test-writing tasks:
1. **setup-test-infrastructure** - Set up Bun test framework
2. **test-session-manager** - Tests for session management
3. **test-message-router** - Tests for message routing
4. **test-telegram-commands** - Tests for bot commands
5. **test-voice-handler** - Tests for voice transcription
6. **test-file-handler** - Tests for file uploads
7. **test-bot-lifecycle** - Integration tests for startup/shutdown
8. **test-streaming-responses** - Tests for Claude streaming
9. **test-error-handling** - Tests for edge cases

### Phase 3: CI/CD (2 tasks)
10. **setup-ci-tests** - GitHub Actions workflow
11. **add-test-coverage-reporting** - Coverage enforcement

### Phase 4: Documentation (1 task)
12. **update-readme** - Update docs with testing info

### Phase 5: Manual Verification (1 task)
13. **manual-e2e-verification** - Final human verification

## How to Use with Ralph

### Option 1: Human-in-the-Loop (Recommended for first task)

```bash
cd ~/Dev/claude-mobile-bridge

# Run the refactoring task first (review carefully!)
claude "Use ralph-claude skill. Run one iteration on my PRD."

# Review the changes
git diff
git log -1

# If good, continue with tests
claude "Use ralph-claude skill. Run one iteration on my PRD."
```

### Option 2: Autonomous (After refactoring is done)

```bash
# Let Ralph write all the tests overnight
claude "Use ralph-claude skill. Run autonomous mode for 12 iterations.
Start with setup-test-infrastructure, then do all test-* tasks."
```

### Option 3: Parallel Testing (Advanced)

```bash
# After refactoring, run multiple test tasks in parallel
# (Each test file is independent)
```

## Task Priorities

Tasks are marked with priority (1-7):
- **Priority 1**: Refactoring (do first, alone)
- **Priority 2**: Test infrastructure setup
- **Priority 3**: Core unit tests (can do in any order)
- **Priority 4**: Integration tests
- **Priority 5**: CI setup
- **Priority 6**: Documentation
- **Priority 7**: Manual verification (last!)

## Acceptance Criteria Highlights

Every task has **automated, verifiable** acceptance criteria:

✅ **Good:**
- "All tests pass: bun test src/__tests__/session-manager.test.ts"
- "bun run typecheck exits with code 0"
- "Test coverage >80%"

❌ **Bad (old approach):**
- "Send message to bot"
- "Verify message appears"
- "Check console output"

## Expected Timeline

**With Ralph (autonomous):**
- Refactoring: 45 min (human review recommended)
- Test infrastructure: 30 min
- 9 test suites: ~5 hours (can run overnight)
- CI setup: 40 min
- Documentation: 25 min
- Manual verification: 30 min

**Total: ~7-8 hours of coding agent time**

## Success Metrics

You'll know you're done when:
- ✅ All 14 tasks marked `"passes": true` in prd.json
- ✅ `bun test` shows all tests passing
- ✅ `bun test --coverage` shows >80% coverage
- ✅ GitHub Actions CI is green
- ✅ Manual E2E verification checklist complete

## Files in This Directory

- **prd.json** - The task list (Ralph reads this)
- **progress.txt** - Ralph's memory (appends after each task)
- **testing-strategy.md** - Detailed testing approach and examples
- **README.md** - This file
- **manual-verification.md** - Will be created by final task

## Testing Philosophy

From `testing-strategy.md`:

1. **Unit tests** - Fast, isolated, mocked dependencies
2. **Integration tests** - Component interactions, no external services
3. **E2E manual tests** - Final verification with real Telegram

**Why this matters:**
- Automated tests run in CI
- Every PR is validated
- Refactoring is safe
- Regressions are caught
- Code is documented by tests

## Prompting Examples

### Start the refactoring:
```
Use ralph-claude skill. Work on the flatten-monorepo task from my PRD.
Take your time and be thorough - this is a big refactoring.
```

### Continue with testing:
```
Use ralph-claude skill. Run the next highest priority task from my PRD.
```

### Run multiple iterations:
```
Use ralph-claude skill. Run 5 iterations on my PRD, 
starting with setup-test-infrastructure.
```

### Check progress:
```bash
# See what's done
grep '"passes": true' plans/prd.json | wc -l

# See what's left
grep '"passes": false' plans/prd.json

# Read Ralph's notes
tail -20 plans/progress.txt
```

## What Makes This Ralph-Optimized

✅ **Independent tasks** - Tests can be written in any order
✅ **Automated verification** - Ralph knows if tests pass
✅ **Clear acceptance criteria** - No ambiguity
✅ **Small, focused tasks** - 20-40 min each
✅ **No manual steps** - (except final verification)
✅ **Git commits** - One per task
✅ **Fresh context** - Each iteration starts clean

## Next Steps

1. **Review the PRD** - Read `prd.json` to understand the plan
2. **Start with refactoring** - Do the `flatten-monorepo` task first
3. **Set up testing** - Let Ralph do `setup-test-infrastructure`
4. **Write tests** - Run Ralph on test tasks (can go overnight)
5. **Add CI** - Let Ralph set up GitHub Actions
6. **Manual verification** - You do this last, after all tests pass

## Questions?

- See `testing-strategy.md` for detailed testing patterns
- See `prd.json` for full task list
- Check `progress.txt` after each iteration for Ralph's notes

---

**Ready to start? Run:**

```bash
claude "Use ralph-claude skill. Run one iteration on my PRD."
```

🚀 Let Ralph handle the boring test-writing so you can focus on features!

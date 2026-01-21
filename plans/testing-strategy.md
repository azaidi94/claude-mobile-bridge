# Testing Strategy for Claude Mobile Bridge

## Overview

This document outlines the testing approach for the claude-mobile-bridge bot after refactoring to a flat structure.

## Goals

1. ✅ **Automated verification** - Tests run without human intervention
2. ✅ **High coverage** - 80%+ code coverage minimum
3. ✅ **Fast feedback** - Tests complete in <10 seconds
4. ✅ **CI integration** - All tests run on every PR
5. ✅ **Maintainable** - Tests are clear and easy to update

## Test Layers

### Unit Tests (Priority 1)
Test individual components in isolation with mocked dependencies.

**Components to test:**
- `SessionManager` - Session discovery, tracking, switching
- `MessageRouter` - Message routing logic
- `CommandHandlers` - Bot command processing
- `VoiceHandler` - Voice transcription
- `FileHandler` - File/photo processing
- `StreamingHandler` - Response streaming to Telegram

**Mocking approach:**
- Mock Telegram API calls
- Mock file system operations
- Mock OpenAI Whisper API
- Mock Claude Code session interactions

### Integration Tests (Priority 2)
Test component interactions without external services.

**Tests:**
- Bot lifecycle (startup/shutdown)
- End-to-end message flow (mocked Telegram)
- Session switching workflow
- Error handling and recovery

### Manual E2E Tests (Priority 3)
Final verification with real Telegram and Claude Code.

**Checklist:**
- Real bot startup
- Real Telegram messages
- Real Claude Code sessions
- Real file uploads
- Real voice messages

## Test Structure

```
src/
├── __tests__/
│   ├── session-manager.test.ts
│   ├── message-router.test.ts
│   ├── commands.test.ts
│   ├── voice-handler.test.ts
│   ├── file-handler.test.ts
│   ├── streaming.test.ts
│   ├── error-handling.test.ts
│   └── bot-lifecycle.test.ts
├── __mocks__/
│   ├── telegram.ts
│   ├── openai.ts
│   ├── filesystem.ts
│   └── claude-session.ts
└── ...
```

## Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test src/__tests__/session-manager.test.ts

# Run with coverage
bun test --coverage

# Watch mode (re-run on file change)
bun test --watch
```

## Coverage Requirements

Minimum coverage thresholds:
- **Statements**: 80%
- **Branches**: 75%
- **Functions**: 80%
- **Lines**: 80%

CI will fail if coverage drops below these thresholds.

## Example Test Pattern

```typescript
import { test, expect, mock } from "bun:test";
import { SessionManager } from "../session-manager";

// Mock dependencies
const mockFs = {
  readdir: mock(() => Promise.resolve(["session-1", "session-2"])),
  stat: mock(() => Promise.resolve({ isDirectory: () => true }))
};

test("discovers active Claude Code sessions", async () => {
  const manager = new SessionManager({ fs: mockFs });
  const sessions = await manager.discoverSessions();
  
  expect(sessions).toHaveLength(2);
  expect(sessions[0].id).toBe("session-1");
  expect(mockFs.readdir).toHaveBeenCalledTimes(1);
});

test("handles session discovery errors gracefully", async () => {
  const errorFs = {
    readdir: mock(() => Promise.reject(new Error("Permission denied")))
  };
  
  const manager = new SessionManager({ fs: errorFs });
  const sessions = await manager.discoverSessions();
  
  expect(sessions).toHaveLength(0); // Empty array on error
});
```

## Mocking Guidelines

### Telegram API
```typescript
const mockTelegram = {
  sendMessage: mock((chatId, text) => 
    Promise.resolve({ ok: true, result: { message_id: 123 } })
  ),
  editMessageText: mock(() => Promise.resolve({ ok: true })),
  getFile: mock(() => Promise.resolve({ file_path: "voice/123.ogg" }))
};
```

### OpenAI Whisper
```typescript
const mockWhisper = {
  transcribe: mock((audioFile) => 
    Promise.resolve({ text: "Test transcription" })
  )
};
```

### File System
```typescript
const mockFs = {
  readFile: mock(() => Promise.resolve(Buffer.from("test"))),
  writeFile: mock(() => Promise.resolve()),
  unlink: mock(() => Promise.resolve())
};
```

### Claude Code Session
```typescript
const mockSession = {
  send: mock((message) => Promise.resolve()),
  onStream: mock((callback) => {
    // Simulate streaming response
    callback({ type: "text", content: "Hello" });
    callback({ type: "tool_use", name: "read_file" });
  })
};
```

## CI/CD Integration

### GitHub Actions Workflow
```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run typecheck
      - run: bun test --coverage
      - run: bun run lint  # if you have linting
```

### Pre-commit Hook (Optional)
```bash
#!/bin/sh
# .git/hooks/pre-commit
bun run typecheck && bun test
```

## Test-Driven Development (TDD) Approach

For new features:
1. ✅ Write test first (it fails - red)
2. ✅ Write minimal code to pass (green)
3. ✅ Refactor while keeping tests green
4. ✅ Commit with passing tests

## Common Testing Pitfalls

### ❌ Don't
- Test implementation details
- Write brittle tests that break on refactoring
- Mock everything (over-mocking)
- Write slow tests (network calls, real file I/O)
- Skip edge cases and error paths

### ✅ Do
- Test behavior and contracts
- Write resilient tests that test "what" not "how"
- Mock external dependencies only
- Use in-memory operations for speed
- Test error handling thoroughly

## Debugging Failed Tests

```bash
# Run single test with verbose output
bun test src/__tests__/failing-test.test.ts --verbose

# Run with debugger
bun test --inspect src/__tests__/failing-test.test.ts

# Check test coverage for specific file
bun test --coverage src/__tests__/session-manager.test.ts
```

## Maintenance

- ✅ Run full test suite before every PR
- ✅ Update tests when adding features
- ✅ Remove tests for removed features
- ✅ Keep test coverage above 80%
- ✅ Review failing tests in CI immediately

## Success Criteria

Tests are successful when:
- ✅ All tests pass locally: `bun test`
- ✅ All tests pass in CI
- ✅ Coverage meets minimums (80%+)
- ✅ Tests run in <10 seconds
- ✅ Manual E2E verification passes

---

**Remember:** Tests are not just for finding bugs - they're living documentation of how your code should behave!

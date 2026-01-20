// Basic grammy mocks for testing
import { mock } from "bun:test";

export const createMockBot = () => ({
  api: {
    sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    editMessageText: mock(() => Promise.resolve(true)),
    getFile: mock(() => Promise.resolve({ file_path: "test/file.ogg" })),
  },
  command: mock(() => {}),
  on: mock(() => {}),
  start: mock(() => Promise.resolve()),
  stop: mock(() => Promise.resolve()),
});

export const createMockContext = (overrides = {}) => ({
  chat: { id: 123 },
  from: { id: 456, username: "testuser" },
  message: { message_id: 1, text: "test message" },
  reply: mock(() => Promise.resolve({ message_id: 2 })),
  ...overrides,
});

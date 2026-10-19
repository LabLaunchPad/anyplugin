import { describe, it, expect } from "vitest";
import { HookSchema } from "./index.js";

describe("Hook ID validation — audit regression tests (Finding A)", () => {
  const validHook = { id: "guard-tool", event: "before-tool-use", handler: "./hooks/guard.mjs" };

  it("rejects empty ID", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "" });
    expect(result.success).toBe(false);
  });

  it("rejects leading underscore (audit: must start with letter)", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "_guard-tool" });
    expect(result.success).toBe(false);
  });

  it("rejects leading digit (audit: must start with letter)", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "0-guard-tool" });
    expect(result.success).toBe(false);
  });

  it("rejects uppercase (audit: lowercase only)", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "Guard-Tool" });
    expect(result.success).toBe(false);
  });

  it("rejects spaces", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "guard tool" });
    expect(result.success).toBe(false);
  });

  it("rejects shell metacharacters: semicolon", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "guard;tool" });
    expect(result.success).toBe(false);
  });

  it("rejects shell metacharacters: backtick", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "guard`tool" });
    expect(result.success).toBe(false);
  });

  it("rejects shell metacharacters: dollar", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "guard$tool" });
    expect(result.success).toBe(false);
  });

  it("rejects shell metacharacters: parentheses", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "guard(tool)" });
    expect(result.success).toBe(false);
  });

  it("rejects shell metacharacters: ampersand", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "guard&tool" });
    expect(result.success).toBe(false);
  });

  it("rejects shell metacharacters: pipe", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "guard|tool" });
    expect(result.success).toBe(false);
  });

  it("rejects newlines", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "guard\ntool" });
    expect(result.success).toBe(false);
  });

  it("rejects paths with slash", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "a/b" });
    expect(result.success).toBe(false);
  });

  it("rejects paths with backslash", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "a\\b" });
    expect(result.success).toBe(false);
  });

  it("rejects traversal sequences", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "../../etc/passwd" });
    expect(result.success).toBe(false);
  });

  it("rejects IDs longer than 64 chars (audit limit)", () => {
    const longId = "a".repeat(65);
    const result = HookSchema.safeParse({ ...validHook, id: longId });
    expect(result.success).toBe(false);
  });

  it("accepts valid kebab-case starting with letter", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "guard-tool" });
    expect(result.success).toBe(true);
  });

  it("accepts valid with digits after first char", () => {
    const result = HookSchema.safeParse({ ...validHook, id: "guard2-tool" });
    expect(result.success).toBe(true);
  });

  it("accepts exactly 64 chars", () => {
    const id = "a" + "b".repeat(63);
    const result = HookSchema.safeParse({ ...validHook, id });
    expect(result.success).toBe(true);
  });
});
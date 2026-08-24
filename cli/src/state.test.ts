import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setActivePlugin, getActivePlugin, setIntensityMode, clearActivePlugin, STATE_BASENAME } from "./state.js";
import { pathExists } from "@lablaunchpad/core";
import { parseCliArgv } from "./strict-args.js";

describe("runtime mode state (.anyplugin-active — ponytail pattern, adapted)", () => {
  it("activate → read → switch mode → clear", async () => {
    const root = await mkdtemp(join(tmpdir(), "state-"));
    await setActivePlugin(root, { pluginId: "p", version: "1.0.0", mode: "balanced", timestamp: 1 });
    expect((await getActivePlugin(root))?.mode).toBe("balanced");

    await setIntensityMode(root, "aggressive", { pluginId: "p", version: "1.0.0" });
    const after = await getActivePlugin(root);
    expect(after?.mode).toBe("aggressive");
    expect(after?.pluginId).toBe("p");

    expect(await clearActivePlugin(root)).toBe(true);
    expect(await pathExists(join(root, STATE_BASENAME))).toBe(false);
    expect(await getActivePlugin(root)).toBeNull();
    expect(await clearActivePlugin(root)).toBe(false);
  });

  it("state file is plain JSON in the plugin root (travels with installs)", async () => {
    const root = await mkdtemp(join(tmpdir(), "state-"));
    const file = await setIntensityMode(root, "conservative", { pluginId: "x", version: "0.0.1" });
    expect(file).toBe(join(root, STATE_BASENAME));
    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed.mode).toBe("conservative");
  });
});

describe("strict-args: intensity command contract", () => {
  it("requires a valid --mode", () => {
    expect(() => parseCliArgv(["intensity"])).toThrow(/requires --mode/);
    expect(() => parseCliArgv(["intensity", "--mode", "turbo"])).toThrow(/mode/);
    const { values } = parseCliArgv<"intensity">(["intensity", "--mode", "aggressive", "--plugin", "p", "--json"]);
    expect(values.mode).toBe("aggressive");
  });
});

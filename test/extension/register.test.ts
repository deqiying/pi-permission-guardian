import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import guardianExtension from "../../extensions/guardian.ts";
import {
  GUARDIAN_COMMAND,
  GUARDIAN_EVENTS,
  GUARDIAN_FLAG,
  registerGuardian,
} from "../../src/extension/register.ts";
import { createFakeContext } from "../support/fake-context.ts";
import { createFakePi } from "../support/fake-pi.ts";

describe("M0 extension skeleton", () => {
  it("loads through the package entry and registers the inert surface", async () => {
    const pi = createFakePi();

    guardianExtension(pi);

    expect([...pi.handlers.keys()]).toEqual([...GUARDIAN_EVENTS]);
    expect(pi.commands.has(GUARDIAN_COMMAND)).toBe(true);
    expect(pi.flags.get(GUARDIAN_FLAG)).toMatchObject({
      type: "boolean",
      default: false,
    });

    for (const event of GUARDIAN_EVENTS) {
      await expect(pi.fire(event, {}, createFakeContext())).resolves.toBe(
        undefined,
      );
    }
    expect(pi.eventCalls.map(({ event, result }) => ({ event, result }))).toEqual(
      GUARDIAN_EVENTS.map((event) => ({ event, result: undefined })),
    );
  });

  it("keeps registration independent from ExtensionContext", () => {
    const pi = createFakePi();

    expect(() => registerGuardian(pi)).not.toThrow();
  });

  it("declares the extension entry and package payload", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      pi?: { extensions?: string[] };
      files?: string[];
      type?: string;
    };

    expect(packageJson.type).toBe("module");
    expect(packageJson.pi?.extensions).toEqual(["./extensions/guardian.ts"]);
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "extensions",
        "src",
        "schemas",
        "config",
        "docs",
        "README.md",
        "LICENSE",
      ]),
    );
  });
});

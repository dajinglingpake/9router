import { describe, expect, it } from "vitest";
import { parseCodexImportText } from "@/shared/utils/codexImport";

const first = { accessToken: "first", user: { email: "first@example.com" }, extra: { nested: [1, 2] } };
const second = { accessToken: "second", email: "second@example.com" };

describe("Codex import text", () => {
  it.each(["\n", "\n\n", "", ",\n", "\r\n"])("reads consecutive JSON documents separated by %j", separator => {
    expect(parseCodexImportText(JSON.stringify(first, null, 2) + separator + JSON.stringify(second, null, 2)))
      .toEqual([first, second]);
  });

  it("keeps brackets, escaped quotes, backslashes and newlines inside strings intact", () => {
    const special = { ...first, name: 'A } { [ "] \\ name\nwith newline', extra: { nested: ["}", "{"] } };
    expect(parseCodexImportText(JSON.stringify(special) + JSON.stringify(second))).toEqual([special, second]);
  });

  it("combines single documents, existing arrays and accounts wrappers from multiple files", () => {
    const text = [JSON.stringify(first), JSON.stringify([second]), JSON.stringify({ accounts: [first, second] })].join("\n\n");
    expect(parseCodexImportText(text)).toEqual([first, second, first, second]);
  });

  it("accepts a BOM and whitespace around file contents", () => {
    expect(parseCodexImportText("\uFEFF " + JSON.stringify(first) + " \n\uFEFF " + JSON.stringify(second) + "\n")).toEqual([first, second]);
  });

  it.each([JSON.stringify(first), JSON.stringify([first]), JSON.stringify({ accounts: [first] })])("keeps existing JSON formats compatible", input => {
    expect(parseCodexImportText(input)).toEqual([first]);
  });

  it("keeps plain and JSON-quoted Access Tokens compatible", () => {
    const token = "eyJhbGciOiJub25lIn0.eyJlbWFpbCI6InVzZXIifQ.signature";
    expect(parseCodexImportText(token)).toEqual([{ accessToken: token }]);
    expect(parseCodexImportText(JSON.stringify(token))).toEqual([token]);
  });

  it.each(["", " \r\n ", "[]", '{"accounts":[]}'])("returns no accounts for empty input %j", input => {
    expect(parseCodexImportText(input)).toEqual([]);
  });

  it.each([
    '{"accessToken":"secret",}',
    '{"accessToken":"secret"',
    '{"accessToken":"secret","data":[1,2}}',
    '{"accessToken":"secret"} trailing-text',
    '{"accessToken":"secret"},',
    '{"accessToken":"secret"},,{}',
    '{"accessToken":"secret"}\n{"accessToken":"unfinished',
    "null", "123", "true",
  ])("rejects malformed input without including credentials in errors", input => {
    let error;
    try { parseCodexImportText(input); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toMatch(/secret|unfinished/);
  });
});

import { describe, expect, it } from "vitest";
import { nextIndexAfterReplaceOne, replaceText } from "../src/search";

describe("replaceText", () => {
  it("replaces case-insensitively and counts hits", () => {
    expect(replaceText("Foo foo FOO", "foo", "x")).toEqual({ next: "x x x", hits: 3 });
  });

  it("does not re-replace a replacement that contains the query", () => {
    expect(replaceText("foo and foo", "foo", "foobar")).toEqual({ next: "foobar and foobar", hits: 2 });
  });

  it("treats regex metacharacters and $-patterns literally", () => {
    expect(replaceText("a.b a+b", "a.b", "X")).toEqual({ next: "X a+b", hits: 1 });
    expect(replaceText("price", "price", "$&$1")?.next).toBe("$&$1");
  });

  it("returns null when the Markdown has no match", () => {
    expect(replaceText("abc", "zzz", "y")).toBeNull();
  });

  it("leaves formatted text alone instead of flattening it", () => {
    // "Docs page" only exists in the rendered text; rewriting it would drop the link.
    expect(replaceText("[Docs](https://x) page", "Docs page", "Guide")).toBeNull();
    expect(replaceText("**fo**o bar", "foo", "baz")).toBeNull();
  });
});

describe("nextIndexAfterReplaceOne", () => {
  it("advances when the replaced node still matches", () => {
    expect(nextIndexAfterReplaceOne(0, 3, 3)).toBe(1);
    expect(nextIndexAfterReplaceOne(2, 3, 3)).toBe(0);
  });

  it("stays on the same position when the replaced node dropped out", () => {
    expect(nextIndexAfterReplaceOne(1, 3, 2)).toBe(1);
    expect(nextIndexAfterReplaceOne(2, 3, 2)).toBe(1);
  });

  it("clears the cursor when nothing matches any more", () => {
    expect(nextIndexAfterReplaceOne(0, 1, 0)).toBe(-1);
  });
});

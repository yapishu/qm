import assert from "node:assert/strict";
import test from "node:test";
import { markdownToStory } from "../src/story.ts";

test("Markdown converts into Tlon Story blocks and inlines", () => {
  assert.deepEqual(
    markdownToStory(
      "# Result\n\nHello **bold**, *italic*, ~~gone~~, `code`, [link](https://example.com), and ~zod.\n\n- first\n- second\n\n```ts\nconst ok = true;\n```",
    ),
    [
      { block: { header: { tag: "h1", content: ["Result"] } } },
      {
        inline: [
          "Hello ",
          { bold: ["bold"] },
          ", ",
          { italics: ["italic"] },
          ", ",
          { strike: ["gone"] },
          ", ",
          { "inline-code": "code" },
          ", ",
          { link: { href: "https://example.com/", content: "link" } },
          ", and ~zod.",
        ],
      },
      {
        block: {
          listing: {
            list: {
              type: "unordered",
              contents: [],
              items: [{ item: ["first"] }, { item: ["second"] }],
            },
          },
        },
      },
      { block: { code: { code: "const ok = true;", lang: "ts" } } },
    ],
  );
});

test("Markdown images, quotes, tasks, and tables remain readable Tlon Story", () => {
  const story = markdownToStory(
    "> quoted **text**\n\n- [x] done\n- [ ] next\n\n![alt](https://example.com/image.png)\n\n| A | B |\n| - | - |\n| 1 | 2 |",
  );
  assert.deepEqual(story[0], { inline: [{ blockquote: ["quoted ", { bold: ["text"] }] }] });
  assert.deepEqual(story[1], {
    block: {
      listing: {
        list: {
          type: "tasklist",
          contents: [],
          items: [
            { item: [{ task: { checked: true, content: ["done"] } }] },
            { item: [{ task: { checked: false, content: ["next"] } }] },
          ],
        },
      },
    },
  });
  assert.deepEqual(story[2], {
    inline: ["![alt](https://example.com/image.png)"],
  });
  assert.deepEqual(story[3], { inline: ["A | B", { break: null }, "1 | 2"] });
});

test("HTML, references, and malformed Markdown never disappear from a response", () => {
  assert.deepEqual(markdownToStory("before\n\n<div>inside</div>\n\nafter"), [
    { inline: ["before"] },
    { inline: ["inside"] },
    { inline: ["after"] },
  ]);
  const references = JSON.stringify(markdownToStory("See [docs][guide].\n\n[guide]: https://example.com"));
  assert.match(references, /docs/);
  assert.match(references, /https:\/\/example\.com/);
  const footnote = "before[^1]\n\n[^1]: footnote text";
  assert.deepEqual(markdownToStory(footnote), [{ inline: [footnote] }]);
  assert.deepEqual(markdownToStory("> | A | B |\n> | - | - |\n> | 1 | 2 |"), [
    { inline: [{ blockquote: ["A | B", { break: null }, "1 | 2"] }] },
  ]);
  assert.deepEqual(markdownToStory("**unterminated"), [{ inline: ["**unterminated"] }]);
});

test("unsafe links stay inert and pathological nesting falls back to plaintext", () => {
  const unsafe = JSON.stringify(
    markdownToStory(
      "[run](javascript:alert(1)) [local](http://127.0.0.1/private) [dot](http://localhost./private) ![file](file:///etc/passwd) ![data](data:text/html,boom)",
    ),
  );
  assert.doesNotMatch(unsafe, /"link":/);
  assert.doesNotMatch(unsafe, /"image":/);
  assert.match(unsafe, /javascript:alert/);
  assert.match(unsafe, /127\.0\.0\.1/);
  assert.match(unsafe, /localhost\./);
  assert.match(unsafe, /file:\/\/\/etc\/passwd/);

  const galleryLink = JSON.stringify(markdownToStory("[download](https://example.com/tracker.png)"));
  assert.doesNotMatch(galleryLink, /"link":/);
  assert.match(galleryLink, /tracker\.png/);

  const nested = `${"> ".repeat(5_000)}x`;
  assert.deepEqual(markdownToStory(nested), [{ inline: [nested] }]);
  const parserBomb = `${"> ".repeat(65_000)}x`;
  const startedAt = performance.now();
  assert.deepEqual(markdownToStory(parserBomb), [{ inline: [parserBomb] }]);
  assert.ok(performance.now() - startedAt < 500);
  for (const syntaxBomb of ["[".repeat(20_000) + "]".repeat(20_000), `${"- ".repeat(10_000)}x`]) {
    const syntaxStartedAt = performance.now();
    assert.deepEqual(markdownToStory(syntaxBomb), [{ inline: [syntaxBomb] }]);
    assert.ok(performance.now() - syntaxStartedAt < 500);
  }
  assert.deepEqual(markdownToStory("\\~zod and &#126;zod"), [{ inline: ["~zod and ~zod"] }]);
});

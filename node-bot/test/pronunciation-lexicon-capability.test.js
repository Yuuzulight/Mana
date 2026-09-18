const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");

const { pronunciationLexiconCapability } = require("../capabilities/pronunciation-lexicon-capability");
const { withServer } = require("./helpers");

function fakeStore(overrides = {}) {
  return {
    listWords: () => [],
    addWord: () => {
      throw new Error("addWord not stubbed");
    },
    updateWord: () => null,
    removeWord: () => false,
    ...overrides,
  };
}

test("pronunciation lexicon capability lists words from the store", async () => {
  const app = express();
  app.use(express.json());
  pronunciationLexiconCapability.registerRoutes(app, {
    pronunciationLexiconStore: fakeStore({
      listWords: () => [{ id: "a", word: "Qwen", replacement: "kwen" }],
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/pronunciation-lexicon`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.words.length, 1);
    assert.equal(payload.words[0].word, "Qwen");
  });
});

test("pronunciation lexicon capability creates a word from word and replacement", async () => {
  const app = express();
  app.use(express.json());
  let received = null;
  pronunciationLexiconCapability.registerRoutes(app, {
    pronunciationLexiconStore: fakeStore({
      addWord: (input) => {
        received = input;
        return { id: "new-id", ...input, createdAt: "t" };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/pronunciation-lexicon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word: "Qwen", replacement: "kwen" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.id, "new-id");
    assert.deepEqual(received, { word: "Qwen", replacement: "kwen" });
  });
});

test("pronunciation lexicon capability rejects creation missing word or replacement", async () => {
  const app = express();
  app.use(express.json());
  pronunciationLexiconCapability.registerRoutes(app, { pronunciationLexiconStore: fakeStore() });

  await withServer(app, async (baseUrl) => {
    const missingWord = await fetch(`${baseUrl}/pronunciation-lexicon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replacement: "x" }),
    });
    assert.equal(missingWord.status, 400);

    const missingReplacement = await fetch(`${baseUrl}/pronunciation-lexicon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word: "x" }),
    });
    assert.equal(missingReplacement.status, 400);
  });
});

test("pronunciation lexicon capability surfaces a store rejection (e.g. duplicate word) as a 400", async () => {
  const app = express();
  app.use(express.json());
  pronunciationLexiconCapability.registerRoutes(app, {
    pronunciationLexiconStore: fakeStore({
      addWord: () => {
        throw new Error('a pronunciation entry for "Qwen" already exists');
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/pronunciation-lexicon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word: "Qwen", replacement: "kwen" }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.match(payload.error, /already exists/);
  });
});

test("pronunciation lexicon capability updates only the fields present in the request", async () => {
  const app = express();
  app.use(express.json());
  let received = null;
  pronunciationLexiconCapability.registerRoutes(app, {
    pronunciationLexiconStore: fakeStore({
      updateWord: (id, updates) => {
        received = { id, updates };
        return { id, word: "Qwen", replacement: updates.replacement || "kwen" };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/pronunciation-lexicon/word-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replacement: "kwenn" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.replacement, "kwenn");
    assert.deepEqual(received, { id: "word-1", updates: { replacement: "kwenn" } });
  });
});

test("pronunciation lexicon capability returns 404 when updating or deleting an unknown word", async () => {
  const app = express();
  app.use(express.json());
  pronunciationLexiconCapability.registerRoutes(app, { pronunciationLexiconStore: fakeStore() });

  await withServer(app, async (baseUrl) => {
    const patchResp = await fetch(`${baseUrl}/pronunciation-lexicon/missing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replacement: "x" }),
    });
    assert.equal(patchResp.status, 404);

    const deleteResp = await fetch(`${baseUrl}/pronunciation-lexicon/missing`, { method: "DELETE" });
    assert.equal(deleteResp.status, 404);
  });
});

test("pronunciation lexicon capability deletes a word", async () => {
  const app = express();
  app.use(express.json());
  let deletedId = null;
  pronunciationLexiconCapability.registerRoutes(app, {
    pronunciationLexiconStore: fakeStore({
      removeWord: (id) => {
        deletedId = id;
        return true;
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/pronunciation-lexicon/word-1`, { method: "DELETE" });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { deleted: true, id: "word-1" });
    assert.equal(deletedId, "word-1");
  });
});

test("pronunciation lexicon capability reports health with the current word count", () => {
  const configured = pronunciationLexiconCapability.getHealth({
    pronunciationLexiconStore: fakeStore({ listWords: () => [{}, {}, {}] }),
  });
  assert.equal(configured.status, "configured");
  assert.equal(configured.configured, true);
  assert.equal(configured.count, 3);
});

const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");

const { presetsCapability } = require("../capabilities/presets-capability");
const { withServer } = require("./helpers");

function fakeStore(overrides = {}) {
  return {
    listPresets: () => [],
    getPreset: () => null,
    createPreset: () => {
      throw new Error("createPreset not stubbed");
    },
    updatePreset: () => null,
    deletePreset: () => false,
    ...overrides,
  };
}

test("presets capability lists presets from the store", async () => {
  const app = express();
  app.use(express.json());
  presetsCapability.registerRoutes(app, {
    presetsStore: fakeStore({
      listPresets: () => [{ id: "a", name: "Concise", instructions: "Be brief." }],
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/presets`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.presets.length, 1);
    assert.equal(payload.presets[0].name, "Concise");
  });
});

test("presets capability creates a preset from name and instructions", async () => {
  const app = express();
  app.use(express.json());
  let received = null;
  presetsCapability.registerRoutes(app, {
    presetsStore: fakeStore({
      createPreset: (input) => {
        received = input;
        return { id: "new-id", ...input, createdAt: "t", updatedAt: "t" };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Brainstorm", instructions: "Suggest wild ideas." }),
    });
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.id, "new-id");
    assert.deepEqual(received, { name: "Brainstorm", instructions: "Suggest wild ideas." });
  });
});

test("presets capability rejects creation missing name or instructions", async () => {
  const app = express();
  app.use(express.json());
  presetsCapability.registerRoutes(app, { presetsStore: fakeStore() });

  await withServer(app, async (baseUrl) => {
    const missingName = await fetch(`${baseUrl}/presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: "x" }),
    });
    assert.equal(missingName.status, 400);

    const missingInstructions = await fetch(`${baseUrl}/presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(missingInstructions.status, 400);
  });
});

test("presets capability updates only the fields present in the request", async () => {
  const app = express();
  app.use(express.json());
  let received = null;
  presetsCapability.registerRoutes(app, {
    presetsStore: fakeStore({
      updatePreset: (id, updates) => {
        received = { id, updates };
        return { id, name: updates.name || "Original", instructions: "x" };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/presets/preset-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.name, "Renamed");
    assert.deepEqual(received, { id: "preset-1", updates: { name: "Renamed" } });
  });
});

test("presets capability returns 404 when updating or deleting an unknown preset", async () => {
  const app = express();
  app.use(express.json());
  presetsCapability.registerRoutes(app, { presetsStore: fakeStore() });

  await withServer(app, async (baseUrl) => {
    const patchResp = await fetch(`${baseUrl}/presets/missing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(patchResp.status, 404);

    const deleteResp = await fetch(`${baseUrl}/presets/missing`, { method: "DELETE" });
    assert.equal(deleteResp.status, 404);
  });
});

test("presets capability deletes a preset", async () => {
  const app = express();
  app.use(express.json());
  let deletedId = null;
  presetsCapability.registerRoutes(app, {
    presetsStore: fakeStore({
      deletePreset: (id) => {
        deletedId = id;
        return true;
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/presets/preset-1`, { method: "DELETE" });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { deleted: true, id: "preset-1" });
    assert.equal(deletedId, "preset-1");
  });
});

test("presets capability reports health with the current preset count", () => {
  const configured = presetsCapability.getHealth({
    presetsStore: fakeStore({ listPresets: () => [{}, {}, {}] }),
  });
  assert.equal(configured.status, "configured");
  assert.equal(configured.configured, true);
  assert.equal(configured.count, 3);
});

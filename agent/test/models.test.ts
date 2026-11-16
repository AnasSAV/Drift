import assert from "node:assert/strict";
import type { Interface } from "node:readline";
import { test } from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { matchModel, toModels } from "../src/claude.js";
import { BUILTIN_EFFORT, BUILTIN_MODEL, chooseModel } from "../src/config.js";
import { pickEffort, pickModel } from "../src/pick.js";

// Shaped like the account list Claude returns: aliases first, then concrete ids.
const accountList: ModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "complex work", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "efficient", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "fast", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "older", supportedEffortLevels: ["low", "medium", "high", "max"] },
  { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "older" },
];

test("account models: aliases collapse onto their real id, order kept", () => {
  const models = toModels(accountList);
  assert.deepEqual(
    models.map((m) => m.id),
    ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  );
  assert.equal(models[0].name, "Opus 5.5");
  assert.deepEqual(models[4].efforts, []);
});

test("model names, ids and short aliases all match", () => {
  const models = toModels(accountList);
  assert.equal(matchModel("sonnet", models)?.id, "claude-sonnet-5-5");
  assert.equal(matchModel("Haiku 5.5", models)?.id, "claude-haiku-5-5");
  assert.equal(matchModel("claude-sonnet-4-6", models)?.id, "claude-sonnet-4-6");
  assert.equal(matchModel("opus-5-5", models)?.id, "claude-opus-5-5");
  assert.equal(matchModel("gpt", models), undefined);
});

test("model choice: flag > skill > saved default > built-in", () => {
  const saved = { model: "claude-sonnet-5-5", effort: "medium" as const };
  assert.deepEqual(chooseModel({}, {}, {}), { model: BUILTIN_MODEL, modelFrom: "built-in", effort: BUILTIN_EFFORT, effortFrom: "built-in" });
  assert.equal(chooseModel({}, {}, saved).model, "claude-sonnet-5-5");
  assert.equal(chooseModel({}, {}, saved).effortFrom, "default");
  assert.equal(chooseModel({}, { model: "claude-fable-5-2" }, saved).modelFrom, "skill");
  assert.equal(chooseModel({ model: "claude-haiku-5-5" }, { model: "claude-fable-5-2" }, saved).model, "claude-haiku-5-5");
  // A skill's unknown effort value is ignored rather than passed to the API.
  assert.equal(chooseModel({}, { effort: "turbo" }, saved).effort, "medium");
});

// A readline stand-in that answers each question with the next scripted reply.
function scripted(...answers: string[]): Interface {
  return { question: (_q: string, cb: (a: string) => void) => cb(answers.shift() ?? "") } as unknown as Interface;
}

test("model picker: Enter keeps, number picks, alias picks, 'm' shows the rest", async () => {
  const models = toModels(accountList);
  const quiet = console.log;
  console.log = () => {};
  try {
    assert.equal(await pickModel(scripted(""), models, "claude-opus-5-5"), "claude-opus-5-5");
    assert.equal(await pickModel(scripted("2"), models, "claude-opus-5-5"), "claude-sonnet-5-5");
    assert.equal(await pickModel(scripted("nonsense", "haiku"), models, "claude-opus-5-5"), "claude-haiku-5-5");
    assert.equal(await pickModel(scripted("m", "5"), models, "claude-opus-5-5"), "claude-haiku-4-5-20251001");
    assert.equal(await pickEffort(scripted(""), models[0], "xhigh"), "xhigh");
    // Sonnet 4.6 has no xhigh: the default falls back to high.
    assert.equal(await pickEffort(scripted(""), models[3], "xhigh"), "high");
    assert.equal(await pickEffort(scripted("turbo", "low"), models[0], "high"), "low");
  } finally {
    console.log = quiet;
  }
});

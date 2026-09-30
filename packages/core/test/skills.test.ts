import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHarness, decodeThreadEvent, defineAgent, defineSchema, defineSkill, defineTool,
  InMemoryEventStore, replayEvents,
} from "../src/index.ts";
import type {
  AnyThreadEvent, ContextCompactEffect, ContinuityHandoffBody,
  ModelDriver, ModelGenerateEffect, ModelResponse,
} from "../src/index.ts";
import { SequenceModelDriver, succeed } from "../../testkit/src/index.ts";

const skill = defineSkill({
  name: "receipt-format", description: "Format synthetic receipts.", version: "1",
  instructions: "Use the private fixture format: VERIFIED / observed evidence / remaining uncertainty.",
});
const modelCapabilities = {
  contextWindowTokens: 32_768, maxOutputTokens: 4_096, resolvedModel: "fixture",
  source: { kind: "explicit", name: "skills-test" },
} as const;
function agent(skills = [skill]) {
  return defineAgent({ instructions: "Use relevant Skills.", skills, model: { provider: "fixture", model: "fixture" }, modelCapabilities });
}
const activate = { content: "Loading the requested Skill.", skillActivation: skill.descriptor.name, toolCalls: [] } as const;
const answer = { content: "VERIFIED / fixture inspected / no external evidence", toolCalls: [] } as const;

test("JX-AC-065 catalogue-only disclosure, atomic activation, replay, fork and clear use ordinary Harness", async () => {
  const driver = new SequenceModelDriver([succeed(activate), succeed(answer), succeed(answer), succeed(activate), succeed(answer)]);
  const store = new InMemoryEventStore();
  const configured = agent();
  const harness = createHarness({ agent: configured, store, modelDrivers: { fixture: driver } });
  const thread = await harness.createThread();
  const state = await thread.send("Format the receipt");
  assert.equal(state.error, null);
  assert.equal(state.result, answer.content);
  assert.equal(state.activatedSkills.length, 1);
  const events = await thread.events();
  assert.ok(!JSON.stringify(events[0]).includes(skill.instructions));
  assert.ok(!JSON.stringify(driver.effects[0]).includes(skill.instructions));
  assert.deepEqual(driver.effects[0]?.input.skills?.catalogue, configured.snapshot.skills);
  assert.deepEqual(driver.effects[1]?.input.skills?.active, [skill]);
  assert.equal(driver.effects[1]?.input.skills?.control, null);
  assert.equal(driver.effects[1]?.input.runtimeContext?.continuation.reason, "skill_activated");
  assert.equal(events.filter(event => event.type === "tool.requested").length, 0);
  const activated = events.find(event => event.type === "model.completed" && event.payload.activatedSkill);
  assert.ok(activated?.type === "model.completed");
  assert.equal(activated.payload.response.content, activate.content);
  assert.ok(!JSON.stringify(driver.effects[1]?.input.messages).includes(activate.content));
  assert.deepEqual(state.activatedSkills[0], { skill, eventId: activated.id, sequence: activated.sequence });
  assert.deepEqual(await thread.replay(), state);
  assert.equal(driver.effects.length, 2);
  const child = await thread.fork({ at: events.at(-1)!.id, input: "Continue in child" });
  const childState = await child.wait();
  assert.deepEqual(childState.activatedSkills[0]?.skill, skill);
  assert.notEqual(childState.activatedSkills[0]?.eventId, activated.id);
  assert.deepEqual(await child.replay(), childState);
  assert.deepEqual(await thread.state(), state);
  const reopened = await createHarness({ agent: configured, store, checkpoints: false, modelDrivers: {} }).openThread(thread.id);
  assert.deepEqual(await reopened.state(), state);
  const cleared = await thread.clear();
  assert.deepEqual(cleared.activatedSkills, []);
  const again = await thread.send("Format again");
  assert.equal(again.error, null);
  assert.equal(again.activatedSkills.length, 1);
  assert.ok(!JSON.stringify(driver.effects[3]).includes(skill.instructions));
  assert.deepEqual(driver.effects[4]?.input.skills?.active, [skill]);
  await assert.rejects(createHarness({ agent: agent([defineSkill({ ...skill.descriptor, instructions: "Changed body" })]), store, modelDrivers: {} }).openThread(thread.id), /Agent/u);
});

test("JX-AC-065 invalid or mixed activation fails without sibling Tool dispatch or silent body substitution", async () => {
  const bad: readonly ModelResponse[] = [
    { ...activate, skillActivation: "unknown" },
    { ...activate, toolCalls: [{ id: "sibling", name: "must-not-run", arguments: {} }] },
    { content: "", toolCalls: [{ id: "bypass", name: "jixu_activate_skill", arguments: { name: skill.descriptor.name } }] },
    { ...activate, planUpdates: [{ operation: "create", objective: "Mixed", acceptanceCriteria: [], assumptions: [], blockers: [], nextAction: "Inspect", steps: [{ id: "inspect", description: "Inspect", status: "pending", evidence: [] }] }] },
    { ...activate, skillActivation: "" },
  ];
  for (const response of bad) {
    const driver = new SequenceModelDriver([succeed(response)]);
    const thread = await createHarness({ agent: agent(), modelDrivers: { fixture: driver } }).createThread();
    const state = await thread.send("Check failure");
    assert.equal(state.error?.code, "model_response_invalid");
    assert.equal(state.error?.retryable, false);
    assert.deepEqual(state.activatedSkills, []);
    assert.ok(!(await thread.events()).some(event => event.type === "tool.requested"));
  }
  const driver = new SequenceModelDriver([succeed(activate), succeed(activate)]);
  const thread = await createHarness({ agent: agent(), modelDrivers: { fixture: driver } }).createThread();
  const repeated = await thread.send("Check repeated activation");
  assert.equal(repeated.error?.code, "model_response_invalid");
  assert.equal(driver.effects.length, 2);
  assert.equal(repeated.activatedSkills.length, 1);
  const events = await thread.events();
  const index = events.findIndex(event => event.type === "model.completed" && event.payload.activatedSkill);
  const event = events[index];
  assert.ok(event?.type === "model.completed");
  const forged = { ...event, payload: { ...event.payload, activatedSkill: defineSkill({ ...skill.descriptor, instructions: "Forged body with valid own digest" }) } };
  assert.throws(() => replayEvents(thread.id, [...events.slice(0, index), forged]), /Skill/u);
  assert.throws(() => decodeThreadEvent({ ...event, payload: { ...event.payload, activatedSkill: { ...skill, instructions: "corruption" } } }), /body/u);
  for (const value of events.filter(value => value.type === "thread.created" || value.type === "model.requested" || value.type === "model.completed")) {
    assert.throws(() => decodeThreadEvent({ ...value, schemaVersion: 13 }), /Skill|schema 14/u);
  }
});

test("JX-AC-065 activation cannot bypass execution-only recovery or the model input budget", async () => {
  const driver = new SequenceModelDriver([
    { status: "failed", error: { code: "fixture_progress_only", message: "Progress without work", retryable: false } },
    succeed(activate),
  ]);
  const thread = await createHarness({ agent: agent(), modelDrivers: { fixture: driver } }).createThread();
  const state = await thread.send("Perform work");
  assert.equal(state.error?.code, "model_response_invalid");
  assert.equal(driver.effects[1]?.input.skills?.control, null);
  assert.deepEqual(state.activatedSkills, []);

  const huge = defineSkill({ ...skill.descriptor, instructions: "Bounded instructions. ".repeat(700) });
  let requests = 0;
  let compactions = 0;
  const configured = defineAgent({
    instructions: "Use the receipt Skill", skills: [huge], model: agent().snapshot.model,
    modelCapabilities: { ...modelCapabilities, contextWindowTokens: 4_096, maxOutputTokens: 512 },
    context: { rawTailTokens: 512, reservedOutputTokens: 512, safetyMarginTokens: 128 },
  });
  const oversized = await createHarness({ agent: configured, modelDrivers: { fixture: {
    async generate() { requests += 1; return succeed(activate); },
    async compact() { compactions += 1; throw new Error("Must fail before dispatch"); },
  } } }).createThread();
  const rejected = await oversized.send("Format");
  assert.equal(rejected.error?.code, "context_budget_uncompactable");
  assert.equal(requests, 1);
  assert.equal(compactions, 0);
  assert.deepEqual(rejected.activatedSkills[0]?.skill, huge);
  assert.deepEqual(await oversized.replay(), rejected);
});

test("JX-AC-065 an omitted historical catalogue remains compatible with an explicitly empty configuration", async () => {
  const driver = new SequenceModelDriver([succeed(answer)]);
  const original = await createHarness({ agent: agent([]), modelDrivers: { fixture: driver } }).createThread();
  const state = await original.send("Reply");
  const store = new InMemoryEventStore();
  await store.createThread(original.id);
  for (const event of await original.events()) {
    const historical = decodeThreadEvent({ ...event, schemaVersion: 13 });
    await store.append(original.id, event.sequence - 1, historical);
  }
  const reopened = await createHarness({ agent: agent([]), store, checkpoints: false, modelDrivers: {} }).openThread(original.id);
  assert.deepEqual(await reopened.state(), state);

  const schema = defineSchema({ jsonSchema: { type: "object" }, parse() { return {}; } });
  const legacyTool = defineTool({
    name: "jixu_activate_skill", description: "Historical application Tool",
    input: schema, output: schema, execute() { return {}; },
  });
  const config = { instructions: "Use the application Tool", model: agent().snapshot.model, modelCapabilities, tools: [legacyTool] };
  assert.throws(() => defineAgent({ ...config, skills: [skill] }), /reserved/u);
  const legacy = await createHarness({ agent: defineAgent(config), modelDrivers: {
    fixture: new SequenceModelDriver([
      succeed({ content: "", toolCalls: [{ id: "legacy", name: legacyTool.descriptor.name, arguments: {} }] }), succeed(answer),
    ]),
  } }).createThread();
  assert.equal((await legacy.send("Use the historical Tool")).error, null);
  const historical = (await legacy.events()).map(event => decodeThreadEvent({ ...event, schemaVersion: 13 }));
  assert.deepEqual(replayEvents(legacy.id, historical), await legacy.state());
});

test("JX-AC-065 accepted activation survives request-append failure with Checkpoints disabled", async () => {
  class CrashStore extends InMemoryEventStore {
    failed = false;
    override async append(threadId: string, revision: number, event: AnyThreadEvent): Promise<void> {
      if (!this.failed && event.type === "model.requested" && event.payload.effect.input.skills?.active.length) {
        this.failed = true;
        throw new Error("crash before activated continuation append");
      }
      await super.append(threadId, revision, event);
    }
  }
  const store = new CrashStore();
  const first = new SequenceModelDriver([succeed(activate)]);
  const thread = await createHarness({ agent: agent(), store, checkpoints: false, modelDrivers: { fixture: first } }).createThread();
  await assert.rejects(thread.send("Activate"), /crash/u);
  const before = await thread.events();
  assert.equal(before.at(-1)?.type, "model.completed");
  assert.equal(replayEvents(thread.id, before).activatedSkills.length, 1);
  const recovered = new SequenceModelDriver([succeed(answer)]);
  const reopened = await createHarness({ agent: agent(), store, checkpoints: false, modelDrivers: { fixture: recovered } }).openThread(thread.id);
  assert.equal((await reopened.wait()).result, answer.content);
  assert.equal(recovered.effects.length, 1);
  assert.deepEqual(recovered.effects[0]?.input.skills?.active, [skill]);
  assert.equal((await reopened.events()).filter(event => event.type === "model.completed" && event.payload.activatedSkill).length, 1);
});

test("JX-AC-065 bounded Context compaction retains exact Skills and source-linked provenance", async () => {
  const generations: ModelGenerateEffect[] = [];
  const compactions: ContextCompactEffect[] = [];
  const driver: ModelDriver = {
    async generate(effect) {
      generations.push(effect);
      return succeed(generations.length === 1 ? activate : answer);
    },
    async compact(effect) {
      compactions.push(effect);
      const origin = effect.input.sourceManifest.find(source => source.kind === "skill")?.causedByEventId;
      assert.ok(origin);
      const fact = { text: "Use the accepted receipt Skill.", sourceEventIds: [origin] };
      const body: ContinuityHandoffBody = {
        acceptanceCriteria: [], artifacts: [], attemptedApproaches: [], blockers: [], completedEvidence: [],
        constraints: [fact], currentState: [], decisions: [], doNotRetry: [], failures: [], nextAction: null,
        objective: null, pendingEffects: [], permissions: [], rejectedAlternatives: [], relevantFiles: [],
        scope: [], summary: [fact], unresolvedQuestions: [], validation: [], waitsAndApprovals: [],
      };
      return succeed(body);
    },
  };
  const configured = defineAgent({ instructions: "Use Skills", model: agent().snapshot.model, skills: [skill], modelCapabilities: { ...modelCapabilities, contextWindowTokens: 4_096, maxOutputTokens: 512 }, context: { rawTailTokens: 512, reservedOutputTokens: 512, safetyMarginTokens: 128 } });
  const thread = await createHarness({ agent: configured, modelDrivers: { fixture: driver } }).createThread();
  await thread.send("Format");
  const result = await thread.send("Historical evidence. ".repeat(600));
  assert.equal(result.error, null);
  assert.ok(compactions.length > 0);
  assert.deepEqual(compactions[0]?.input.activeSkills, [skill]);
  assert.deepEqual(generations.at(-1)?.input.skills?.active, [skill]);
  assert.ok(result.acceptedHandoff);
  const source = generations.at(-1)?.input.contextManifest?.sources.find(source => source.kind === "skill");
  assert.equal(source?.causedByEventId, result.activatedSkills[0]?.eventId);
  assert.deepEqual(await thread.replay(), result);
  const child = await thread.fork({ at: (await thread.events()).at(-1)!.id, input: "Continue in child" });
  await child.wait();
  assert.deepEqual(await child.replay(), await child.state());
});

test("JX-AC-065 Skill configuration is immutable and bounded before any Driver dispatch", () => {
  assert.ok(Object.isFrozen(agent().snapshot.skills?.[0]));
  assert.ok(Object.isFrozen(agent().skills?.[0]));
  assert.throws(() => agent([skill, skill]), /duplicate/u);
  assert.throws(() => defineSkill({ ...skill.descriptor, name: "../file", instructions: "x" }), /slug/u);
  assert.throws(() => defineSkill({ ...skill.descriptor, instructions: "中".repeat(6_000) }), /invalid/u);
  assert.throws(() => agent(Array.from({ length: 17 }, (_, i) => defineSkill({ ...skill.descriptor, name: `skill-${i}`, instructions: "x" }))), /at most/u);
  assert.throws(() => agent(Array.from({ length: 5 }, (_, i) => defineSkill({ ...skill.descriptor, name: `skill-${i}`, instructions: "x".repeat(16_384) }))), /65536/u);
});

import { InMemoryEventStore } from "../src/index.ts";
import { defineStoreContract } from "../../testkit/src/store-contract.ts";

defineStoreContract("InMemoryEventStore", () => ({
  store: new InMemoryEventStore(),
}));

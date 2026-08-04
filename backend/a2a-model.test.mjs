import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_A2A_MODEL, DEFAULT_A2A_PROVIDER } from "./a2a-model.mjs";

test("cloud and fallback chat runtime pin the requested DeepSeek model", () => {
  const deployment = JSON.parse(readFileSync(
    new URL("./deploy/aws-lightsail/apprunner-service.json", import.meta.url),
    "utf8",
  ));
  const environment = deployment.SourceConfiguration.ImageRepository.ImageConfiguration.RuntimeEnvironmentVariables;
  assert.equal(DEFAULT_A2A_PROVIDER, "openrouter");
  assert.equal(DEFAULT_A2A_MODEL, "deepseek/deepseek-v4-flash-0731");
  assert.equal(environment.HERMES_PROVIDER, DEFAULT_A2A_PROVIDER);
  assert.equal(environment.HERMES_MODEL, DEFAULT_A2A_MODEL);
});

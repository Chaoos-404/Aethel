import React from "react";
import { render } from "ink";
import { AethelTui } from "./app.js";

export async function runTui({
  repo,
  includeSharedDrives = false,
  cliPath = null,
  cliArgs = [],
  initialView = "browser",
} = {}) {
  const instance = render(
    React.createElement(AethelTui, {
      repo,
      includeSharedDrives,
      cliPath,
      cliArgs,
      initialView,
    })
  );
  await instance.waitUntilExit();
}

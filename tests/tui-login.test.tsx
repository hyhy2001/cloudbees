import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { BeeApp } from "../src/core/tui/app";
import { TuiProvider } from "../src/core/tui/context";
import { collectScreens } from "../src/registry/tui";

test("logged-out shell shows the login hint and opens the login modal on 'l'", async () => {
  const screens = collectScreens();
  const { lastFrame, stdin } = render(
    <TuiProvider initialSession={{ username: "", activeController: null, loggedIn: false }}>
      <BeeApp screens={screens} />
    </TuiProvider>,
  );
  // footer advertises login while logged out
  expect(lastFrame() ?? "").toContain("login");

  // press 'l' → login modal with the three fields
  stdin.write("l");
  await new Promise((r) => setTimeout(r, 50));
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Login to CloudBees");
  expect(frame).toContain("Server URL");
  expect(frame).toContain("Username");
  expect(frame).toContain("API Token");
});

test("logged-in shell does NOT show the login hint", () => {
  const screens = collectScreens();
  const { lastFrame } = render(
    <TuiProvider initialSession={{ username: "huy", activeController: "prod", loggedIn: true }}>
      <BeeApp screens={screens} />
    </TuiProvider>,
  );
  // 'l' is gated by !loggedIn → not in the footer
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain(" login");
});
